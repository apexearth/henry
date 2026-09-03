// Session manager. Owns Session records (the DB rows, titles, Claude binding) while the
// PTYs and their scrollback live in henry-sessiond (packages/sessiond), reached through
// SessiondClient. Because sessiond outlives the daemon, start() reconciles what sessiond
// still has with what the DB remembers. Emits:
//   "update" (session)                 - created / changed / exited
//   "data"   (sessionId, data: string) - live PTY output
//   "exit"   (sessionId, exitCode)
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { basename } from "node:path";
import type { Session } from "@henry/shared";
import { config, henryDir } from "./config";
import * as db from "./db";
import { writeLaunchSettings } from "./installer";
import { SessiondClient, type SessionSummary } from "./sessiond-client";

export interface CreateOptions {
  cwd: string;
  title?: string;
  command?: string;
  args?: string[];
  /** Resume an existing Claude session id instead of starting a fresh one. */
  resume?: string;
  cols?: number;
  rows?: number;
  parentSessionId?: string;
}

interface Live {
  session: Session;
  /** No PTY: a claude started outside Henry, known only through its hooks (milestone 2). */
  external?: boolean;
  /** Set when sessiond does not hold this session (external, or restored from the DB): the
   * whole "scrollback" is this note. Undefined means ask sessiond. */
  local?: string;
}

export interface SessionEvents {
  update: [session: Session];
  data: [sessionId: string, data: string];
  exit: [sessionId: string, exitCode: number];
}

/** Environment for anything Henry spawns (sessiond, and through it every session). */
export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Never inherit markers from a Claude Code session that may have started the daemon:
    // CLAUDE_CODE_CHILD_SESSION turns transcript saving off in the child, which starves
    // Henry's tailer and any transcript-based plugin hooks.
    if (v === undefined || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    env[k] = v;
  }
  return env;
}

/** Short host name stamped on every session this daemon creates (groundwork for multi-machine). */
export function localHost(): string {
  return config.host || hostname().split(".")[0] || "localhost";
}

class SessionManager extends EventEmitter<SessionEvents> {
  private live = new Map<string, Live>();
  readonly client: SessiondClient;
  private starting: Promise<void> | undefined;
  private started = false;

  constructor() {
    super();
    this.client = new SessiondClient({ henryDir, env: cleanEnv(), log: (m) => console.error(`[henry] ${m}`) });
    this.client.on("spawned", (id, pid) => {
      const l = this.live.get(id);
      if (!l || l.session.pid === pid) return;
      l.session.pid = pid;
      db.updateSession(id, { pid });
      this.emit("update", l.session);
    });
    this.client.on("data", (id, data) => {
      if (this.live.has(id)) this.emit("data", id, data);
    });
    this.client.on("exit", (id, exitCode) => {
      const l = this.live.get(id);
      if (l) this.finish(l, exitCode);
    });
    this.client.on("error", (id, message) => {
      const l = id ? this.live.get(id) : undefined;
      if (l && l.session.status === "running" && l.session.pid === undefined && message.startsWith("spawn failed")) {
        this.emit("data", id!, `\r\n[henry] failed to start ${l.session.command}: ${message}\r\n`);
        this.finish(l, 127);
      } else console.error(`[henry] sessiond error${id ? ` (${id.slice(0, 8)})` : ""}: ${message}`);
    });
    // Reconnects after the first start: re-attach, and drop anything sessiond lost.
    this.client.on("connect", (summaries) => {
      if (this.started) this.reconcile(summaries);
    });
  }

  /**
   * Connect to sessiond (starting one if needed) and reconcile its live sessions with
   * the DB. Called once by the server before it listens; create() also calls it so a
   * daemon whose start failed (no node on PATH) still recovers later. Never throws
   * after the first attempt: without sessiond the rail still shows recent sessions.
   */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      let summaries: SessionSummary[] = [];
      try {
        summaries = await this.client.connect();
      } catch (e) {
        console.error(`[henry] sessiond unavailable: ${(e as Error).message}`);
        this.starting = undefined;
      }
      this.reconcile(summaries);
      this.started = true;
    })();
    return this.starting;
  }

  /** Sync the live table with sessiond's: attach to what it holds, restore the rest from the DB as exited. */
  private reconcile(summaries: SessionSummary[]): void {
    const known = new Map(summaries.map((s) => [s.id, s]));
    for (const sum of summaries) {
      const l = this.live.get(sum.id);
      if (l && !l.local) {
        if (sum.status === "exited" && l.session.status === "running") this.finish(l, sum.exitCode ?? 0);
        this.client.send({ op: "attach", id: sum.id });
        continue;
      }
      const row = db.getSession(sum.id);
      const session: Session = row ?? {
        id: sum.id,
        cwd: sum.cwd,
        title: basename(sum.cwd) || sum.cwd,
        createdAt: sum.createdAt,
        status: sum.status,
        command: sum.command,
        host: localHost(),
      };
      const patch: Partial<Session> = {};
      if (session.pid !== sum.pid) patch.pid = sum.pid;
      if (session.status !== sum.status) patch.status = sum.status;
      if (sum.status === "exited" && session.exitCode !== sum.exitCode) patch.exitCode = sum.exitCode;
      Object.assign(session, patch);
      if (!row) db.insertSession(session);
      else if (Object.keys(patch).length) db.updateSession(session.id, patch);
      this.live.set(sum.id, { session });
      this.client.send({ op: "attach", id: sum.id });
      this.emit("update", session);
    }
    // Live entries sessiond no longer has (it was restarted underneath us).
    for (const l of this.live.values()) {
      if (l.local || known.has(l.session.id)) continue;
      l.local = "\x1b[2m[henry] sessiond restarted; terminal output was not retained\x1b[0m\r\n";
      if (l.session.status === "running") this.finish(l, 1);
    }
    if (this.started) return;
    // First start only: DB rows that claim running but sessiond does not hold died with
    // an earlier sessiond. Recent sessions come back exited (repos, flags and playbook
    // are still in the DB); kill (dismiss) drops them like any other exited session.
    for (const s of db.listSessions({ status: "running" })) {
      if (!known.has(s.id)) db.updateSession(s.id, { status: "exited" });
    }
    const cutoff = Date.now() - db.SESSION_RESTORE_WINDOW_MS;
    for (const s of db.listSessions({ limit: 20 })) {
      if (this.live.has(s.id) || known.has(s.id) || s.createdAt < cutoff) continue;
      if (s.status === "running") s.status = "exited";
      const note = "\x1b[2m[henry] session from a previous daemon run; terminal output was not retained\x1b[0m\r\n";
      this.live.set(s.id, { session: s, local: note, external: s.command === "external" });
    }
  }

  list(): Session[] {
    return [...this.live.values()].map((l) => l.session).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Session | undefined {
    return this.live.get(id)?.session;
  }

  /**
   * Scrollback for a window that is attaching. `cb` runs synchronously when the data is
   * known (local note) or inside sessiond's reply handler, before any later live "data"
   * event fires, so a caller that subscribes to live output inside `cb` sees an ordered
   * stream. Unknown session: cb is not called.
   */
  withScrollback(id: string, cb: (data: string) => void): void {
    const l = this.live.get(id);
    if (!l) return;
    if (l.local !== undefined) return cb(l.local);
    this.client.attach(id, cb);
  }

  scrollback(id: string): Promise<string> {
    return new Promise((res) => {
      if (!this.live.has(id)) return res("");
      this.withScrollback(id, res);
    });
  }

  async create(opts: CreateOptions): Promise<Session> {
    await this.start();
    if (!this.client.connected) await this.client.connect();
    const id = crypto.randomUUID();
    const command = opts.command ?? resolveClaude();
    const isClaude = basename(command) === "claude";
    // Henry-launched claude: pin its session id to ours (no hook round-trip needed to
    // bind) and layer Henry's hooks + statusline on top of the user's settings.
    const claudeId = opts.resume ?? id;
    const args = opts.args ?? (isClaude ? [opts.resume ? "--resume" : "--session-id", claudeId, "--settings", writeLaunchSettings(henryDir)] : []);
    const session: Session = {
      id,
      claudeSessionId: isClaude && !opts.args ? claudeId : undefined,
      cwd: opts.cwd,
      title: opts.title || basename(opts.cwd),
      createdAt: Date.now(),
      status: "running",
      command,
      parentSessionId: opts.parentSessionId,
      host: localHost(),
    };
    this.live.set(id, { session });
    db.insertSession(session);

    const env = cleanEnv();
    Object.assign(env, {
      HENRY_SESSION: id,
      HENRY_PORT: String(config.port),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
    this.client.send({ op: "spawn", id, command, args, cwd: opts.cwd, env, cols: opts.cols ?? 120, rows: opts.rows ?? 36 });
    this.client.send({ op: "attach", id });
    this.emit("update", session);
    return session;
  }

  write(id: string, data: string): void {
    if (this.live.get(id)?.session.status === "running") this.client.send({ op: "write", id, data });
  }

  resize(id: string, cols: number, rows: number): void {
    if (this.live.get(id)?.session.status === "running") this.client.send({ op: "resize", id, cols, rows });
  }

  /** Kill a running session; on an exited one, forget it (drops it from the rail and from sessiond). */
  kill(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    if (l.external && l.session.status === "running") {
      this.finish(l, 0);
    } else if (l.session.status === "running") {
      this.client.send({ op: "kill", id, signal: "SIGHUP" });
      // Anything still alive after a grace period gets SIGKILL.
      setTimeout(() => {
        if (this.live.get(id)?.session.status === "running") this.client.send({ op: "kill", id, signal: "SIGKILL" });
      }, 3000);
    } else {
      this.live.delete(id);
      if (l.local === undefined) this.client.send({ op: "kill", id });
    }
  }

  /** Register a session Henry did not spawn (hooks.ts, for a claude started elsewhere). No PTY behind it. */
  registerExternal(session: Session): void {
    if (this.live.has(session.id)) return;
    session.host ??= localHost();
    const note = `[henry] external session: started outside Henry, output not captured (cwd ${session.cwd})\r\n`;
    this.live.set(session.id, { session, local: note, external: true });
    db.insertSession(session);
    this.emit("update", session);
  }

  /** Bind Claude's own session_id to a PTY session (milestone 2 calls this from hooks.ts). */
  bindClaudeSession(id: string, claudeSessionId: string): void {
    const l = this.live.get(id);
    if (!l || l.session.claudeSessionId === claudeSessionId) return;
    l.session.claudeSessionId = claudeSessionId;
    db.updateSession(id, { claudeSessionId });
    this.emit("update", l.session);
  }

  /** Disconnect from sessiond. Sessions keep running there; the next daemon picks them up. */
  shutdown(): void {
    this.client.close();
  }

  private finish(l: Live, exitCode: number): void {
    if (l.session.status === "exited") return;
    l.session.status = "exited";
    l.session.exitCode = exitCode;
    db.updateSession(l.session.id, { status: "exited", exitCode });
    this.emit("exit", l.session.id, exitCode);
    this.emit("update", l.session);
  }
}

function resolveClaude(): string {
  return Bun.which("claude") ?? "claude";
}

export const sessions = new SessionManager();
