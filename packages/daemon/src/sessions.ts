// Session manager. Owns Session records (the DB rows, titles, Claude binding) while the
// PTYs and their scrollback live in henry-sessiond (packages/sessiond), reached through
// SessiondClient. Because sessiond outlives the daemon, start() reconciles what sessiond
// still has with what the DB remembers. Emits:
//   "update" (session)                 - created / changed / exited
//   "data"   (sessionId, data: string) - live PTY output
//   "exit"   (sessionId, exitCode)
import { EventEmitter } from "node:events";
import { homedir, hostname } from "node:os";
import { basename } from "node:path";
import type { Session, SessionKind } from "@henry/shared";
import * as attention from "./attention";
import { boundPort, config, henryDir } from "./config";
import * as db from "./db";
import { syncLaunchMcp, writeLaunchBin, writeLaunchSettings } from "./installer";
import { defaultShell, expandTilde, prependPath, programName, redrawByShrink, resolveClaude, spawnSpec, windowsBuild } from "./platform";
import { screens } from "./screen";
import { SessiondClient, type SessionSummary } from "./sessiond-client";
import { Typist } from "./typing";

export interface CreateOptions {
  cwd: string;
  title?: string;
  /** "claude" (default) or "shell" ($SHELL as a login shell). `command` overrides. */
  kind?: SessionKind;
  command?: string;
  args?: string[];
  /** Resume an existing Claude session id instead of starting a fresh one. */
  resume?: string;
  /** Start from a copy of this Claude session id's conversation, under the new session's own id. */
  fork?: string;
  cols?: number;
  rows?: number;
  parentSessionId?: string;
  /** Appended to the Claude flags Henry adds (a coordinator's system prompt and tool limits). */
  extraArgs?: string[];
  topicId?: string;
  coordinator?: boolean;
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
  /** Sessions sessiond lost while this daemon was attached (it died and a new one started). */
  lost: [sessions: Session[]];
}

/** What a session brought back takes from its topic (topics.inherit), and whether Claude resumes. */
export interface Respawn extends Pick<CreateOptions, "topicId" | "coordinator" | "extraArgs"> {
  /** A conversation is on disk to resume; otherwise Claude starts fresh under the same id. */
  resume: boolean;
}

/** How often the daemon notes it is alive, so a restart can tell what ended as the machine went down. */
const ALIVE_EVERY_MS = 30_000;
/** A session that ended this close before the daemon last noted it was alive went down with it. */
const DIED_WITH_MS = 90_000;

/** A session Henry can start again by itself: a Claude conversation or a plain terminal it spawned. */
function restartable(s: Session): boolean {
  if (s.peer || s.command === "external" || !s.command) return false;
  if (s.kind === "shell") return s.command === defaultShell().command;
  return programName(s.command) === "claude" && !!s.claudeSessionId;
}

/** You ended it: through Henry, with /exit, or by leaving a shell cleanly. */
function endedOnPurpose(s: Session): boolean {
  if (db.wasClosed(s.id)) return true;
  if (s.status !== "exited") return false;
  if (s.kind === "shell") return s.exitCode === 0;
  const end = db.listEvents({ sessionId: s.id, limit: 10 }).find((e) => e.hookEvent === "SessionEnd");
  const reason = (end?.payload as { reason?: string } | undefined)?.reason;
  return reason === "prompt_input_exit" || reason === "logout";
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
  /** Found dead at the first start, waiting for restore.ts to take them. */
  private lostAtStart: Session[] = [];
  private alive: ReturnType<typeof setInterval> | undefined;
  /** Long input goes in paced pieces (typing.ts). */
  private typist = new Typist(
    (id, data) => this.client.send({ op: "write", id, data }),
    (id) => this.live.get(id)?.session.status === "running",
  );

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
      const l = this.live.get(id);
      if (!l) return;
      // The emulator hears everything before any window does, so a snapshot taken inside a
      // later attach covers exactly the bytes already published.
      screens.write(id, data);
      this.noteTitle(l, data);
      this.emit("data", id, data);
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
      db.setMeta("alive_at", String(Date.now()));
      this.alive ??= setInterval(() => db.setMeta("alive_at", String(Date.now())), ALIVE_EVERY_MS);
    })();
    return this.starting;
  }

  /** The sessions found dead at startup that Henry can start again, once (restore.ts). */
  takeLost(): Session[] {
    const out = this.lostAtStart;
    this.lostAtStart = [];
    return out;
  }

  /**
   * Is the sessiond we are attached to a different one from last time? Only then can anything
   * have died with it: a daemon restart against the same sessiond finds every session still
   * there, and must never start a second copy of one.
   */
  private newSessiond(): boolean {
    const pid = this.client.remotePid;
    if (!pid) return false;
    const last = db.getMeta("sessiond_pid");
    db.setMeta("sessiond_pid", String(pid));
    // Nothing recorded: the first run of a daemon that keeps this, not evidence of a death.
    return last !== undefined && Number(last) !== pid;
  }

  /** Sync the live table with sessiond's: attach to what it holds, restore the rest from the DB as exited. */
  private reconcile(summaries: SessionSummary[]): void {
    const known = new Map(summaries.map((s) => [s.id, s]));
    for (const sum of summaries) {
      const l = this.live.get(sum.id);
      if (l && !l.local) {
        if (sum.status === "exited" && l.session.status === "running") this.finish(l, sum.exitCode ?? 0);
        this.rebuildScreen(sum);
        continue;
      }
      const row = db.getSession(sum.id);
      if (row && sum.status === "exited" && db.isDismissed(row.id)) {
        this.client.send({ op: "kill", id: sum.id });
        continue;
      }
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
      if (sum.status === "exited" && !session.endedAt) patch.endedAt = sum.endedAt ?? Date.now();
      Object.assign(session, patch);
      if (!row) db.insertSession(session);
      else if (Object.keys(patch).length) db.updateSession(session.id, patch);
      this.hold(sum.id, { session });
      this.rebuildScreen(sum);
      this.emit("update", session);
    }
    const fresh = this.newSessiond();
    // Live entries sessiond no longer has (it was restarted underneath us).
    const lost: Session[] = [];
    for (const l of this.live.values()) {
      if (l.local || known.has(l.session.id)) continue;
      l.local = "\x1b[2m[henry] sessiond restarted; terminal output was not retained\x1b[0m\r\n";
      screens.forget(l.session.id);
      if (l.session.status !== "running") continue;
      this.finish(l, 1);
      if (fresh && restartable(l.session) && !db.wasClosed(l.session.id)) lost.push(l.session);
    }
    if (this.started) {
      if (lost.length) this.emit("lost", lost);
      return;
    }
    // First start, against a sessiond that is not the one the last daemon had: whatever was
    // running then, or ended as the machine went down, went down with it.
    if (fresh) {
      const aliveAt = Number(db.getMeta("alive_at") ?? 0);
      for (const s of db.listSessions()) {
        if (known.has(s.id) || !restartable(s)) continue;
        const died = s.status === "running" || (aliveAt > 0 && (s.endedAt ?? 0) >= aliveAt - DIED_WITH_MS);
        if (died && !endedOnPurpose(s)) this.lostAtStart.push(s);
      }
    }
    // First start only: DB rows that claim running but sessiond does not hold died with
    // an earlier sessiond. Recent sessions come back exited (repos and flags
    // are still in the DB); kill (dismiss) drops them like any other exited session.
    for (const s of db.listSessions({ status: "running" })) {
      if (!known.has(s.id)) db.updateSession(s.id, { status: "exited" });
    }
    const cutoff = Date.now() - db.SESSION_RESTORE_WINDOW_MS;
    for (const s of db.listSessions({ limit: 20 })) {
      if (this.live.has(s.id) || known.has(s.id) || s.createdAt < cutoff) continue;
      if (s.status === "running") s.status = "exited";
      const note = "\x1b[2m[henry] session from a previous daemon run; terminal output was not retained\x1b[0m\r\n";
      this.hold(s.id, { session: s, local: note, external: s.command === "external" });
    }
  }

  /**
   * (Re)attach to a session sessiond holds and rebuild its emulator from the ring. Called for
   * every summary on connect and on every reconnect: while the socket was down the emulator
   * missed bytes, and the ring is the only place they still exist. History deeper than the
   * ring does not survive a daemon restart — sessiond keeps bytes, not screens.
   */
  private rebuildScreen(sum: SessionSummary): void {
    this.client.attach(sum.id, (raw) => {
      screens.forget(sum.id);
      screens.open(sum.id, sum.cols, sum.rows, raw);
    });
  }

  /** Everything in `live` is this daemon's own session, so it leaves here stamped with this
   * machine: its host name and, on Windows, its ConPTY build. The build travels with the
   * session because the window that draws it may be on another machine (federation), and only
   * the host knows whether the bytes came out of ConPTY. */
  private hold(id: string, entry: Live): void {
    entry.session.host ??= localHost();
    entry.session.windowsBuild = windowsBuild;
    this.live.set(id, entry);
  }

  list(): Session[] {
    return [...this.live.values()].map((l) => l.session).sort((a, b) => a.createdAt - b.createdAt);
  }

  stats(): Record<string, number> {
    let running = 0;
    for (const l of this.live.values()) if (l.session.status === "running") running++;
    return { sessionsHeld: this.live.size, sessionsRunning: running, titleTails: this.titleTail.size };
  }

  get(id: string): Session | undefined {
    return this.live.get(id)?.session;
  }

  /**
   * Scrollback for a window that is attaching: a snapshot of the session's emulator (screen.ts),
   * not the bytes that produced it. `cb` runs synchronously when the state is known (snapshot or
   * local note) or inside sessiond's reply handler, before any later live "data" event fires, so
   * a caller that subscribes to live output inside `cb` sees an ordered stream with no gap and no
   * repeat. Unknown session: cb is not called.
   */
  withScrollback(id: string, cb: (data: string) => void): void {
    const l = this.live.get(id);
    if (!l) return;
    if (l.local !== undefined) return cb(l.local);
    const snap = screens.snapshot(id);
    if (snap !== undefined) return cb(snap);
    // No emulator yet: a rebuild is still in flight, so fall back to the raw ring.
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
    const cwd = expandTilde(opts.cwd, homedir());
    const shell = !opts.command && opts.kind === "shell" ? defaultShell() : undefined;
    const command = opts.command ?? shell?.command ?? resolveClaude();
    const isClaude = programName(command) === "claude";
    const kind: SessionKind = opts.kind ?? (isClaude ? "claude" : "shell");
    // Henry-launched claude: pin its session id to ours (no hook round-trip needed to
    // bind) and layer Henry's hooks + statusline on top of the user's settings.
    const claudeId = opts.resume ?? id;
    // A fork keeps the pin: Claude Code takes --session-id with --resume only beside --fork-session.
    const idArgs = opts.fork ? ["--resume", opts.fork, "--fork-session", "--session-id", id] : [opts.resume ? "--resume" : "--session-id", claudeId];
    const args = opts.args ?? (isClaude ? this.claudeArgs(idArgs, opts.extraArgs) : shell?.args ?? []);
    const session: Session = {
      id,
      claudeSessionId: isClaude && !opts.args ? claudeId : undefined,
      cwd,
      title: opts.title || basename(cwd),
      createdAt: Date.now(),
      status: "running",
      command,
      kind,
      parentSessionId: opts.parentSessionId,
      host: localHost(),
    };
    if (opts.topicId) session.topicId = opts.topicId;
    if (opts.coordinator) session.coordinator = true;
    this.hold(id, { session });
    db.insertSession(session);
    this.launch(session, args, opts.cols, opts.rows);
    return session;
  }

  /**
   * Start a session again in its own row after sessiond lost it (restore.ts decides which, and
   * with what): the same id, so its tab, topic, flags and history stay where they were. Claude
   * resumes its conversation; a terminal starts a fresh shell in the same folder.
   */
  async respawn(prior: Session, how: Respawn): Promise<Session | undefined> {
    await this.start();
    if (!this.client.connected) await this.client.connect();
    if (this.live.get(prior.id)?.session.status === "running") return undefined;
    const shell = prior.kind === "shell" ? defaultShell() : undefined;
    const claudeId = prior.claudeSessionId!;
    const args = shell ? shell.args : this.claudeArgs([how.resume ? "--resume" : "--session-id", claudeId], how.extraArgs);
    const session: Session = {
      id: prior.id,
      cwd: prior.cwd,
      title: prior.title,
      createdAt: prior.createdAt,
      status: "running",
      command: shell?.command ?? resolveClaude(),
      kind: prior.kind ?? "claude",
      host: localHost(),
    };
    if (prior.claudeSessionId) session.claudeSessionId = prior.claudeSessionId;
    if (prior.parentSessionId) session.parentSessionId = prior.parentSessionId;
    if (how.topicId) session.topicId = how.topicId;
    if (how.coordinator) session.coordinator = true;
    this.titleTail.delete(prior.id);
    screens.forget(prior.id);
    this.hold(prior.id, { session });
    db.reopenSession(prior.id);
    db.updateSession(prior.id, { command: session.command, claudeActive: false, topicId: session.topicId, coordinator: !!session.coordinator });
    this.launch(session, args);
    return session;
  }

  /** Claude's flags for a Henry session: its id, Henry's hooks and statusline, Henry's MCP server. */
  private claudeArgs(idArgs: string[], extra: string[] = []): string[] {
    // MCP is its own flag: Claude Code ignores `mcpServers` inside a --settings file.
    const mcpPath = syncLaunchMcp(henryDir);
    return [...idArgs, "--settings", writeLaunchSettings(henryDir), ...(mcpPath ? ["--mcp-config", mcpPath] : []), ...extra];
  }

  private launch(session: Session, args: string[], cols = 120, rows = 36): void {
    const { id, kind, command } = session;
    // What this session will name for the rest of its life, hooks and MCP url alike. The
    // daemon keeps answering here even after its port moves (server.ts, syncAliasListeners).
    db.setSessionPort(id, boundPort());

    const env = cleanEnv();
    Object.assign(env, {
      HENRY_SESSION: id,
      HENRY_PORT: String(boundPort()),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
    if (kind === "shell") {
      // A `claude` typed into this shell goes through Henry's shim, which adds the launch
      // settings; its first hook (HENRY_SESSION) then marks the terminal as running Claude.
      writeLaunchSettings(henryDir);
      syncLaunchMcp(henryDir);
      prependPath(env, writeLaunchBin(henryDir));
      env.HENRY_CLAUDE = resolveClaude();
    }
    const spec = spawnSpec(command!, args);
    screens.open(id, cols, rows);
    this.client.send({ op: "spawn", id, command: spec.command, args: spec.args, cwd: session.cwd, env, cols, rows });
    this.client.send({ op: "attach", id });
    this.emit("update", session);
  }

  write(id: string, data: string): void {
    if (this.live.get(id)?.session.status === "running") this.typist.write(id, data);
  }

  /** `redraw`: the window just showed this terminal again and wants the program to repaint
   * even at an unchanged size (platform.ts redrawByShrink says how). */
  resize(id: string, cols: number, rows: number, redraw = false): void {
    if (this.live.get(id)?.session.status !== "running") return;
    if (redraw && redrawByShrink && rows > 1) {
      this.client.send({ op: "resize", id, cols, rows: rows - 1 });
      setTimeout(() => this.resize(id, cols, rows), 40);
      return;
    }
    screens.resize(id, cols, rows);
    this.client.send({ op: "resize", id, cols, rows });
  }

  /** Kill a running session; on an exited one, forget it (drops it from the rail and from sessiond). */
  kill(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    if (l.external && l.session.status === "running") {
      this.finish(l, 0);
    } else if (l.session.status === "running") {
      db.markClosed(id);
      this.client.send({ op: "kill", id, signal: "SIGHUP" });
      // Anything still alive after a grace period gets SIGKILL.
      setTimeout(() => {
        if (this.live.get(id)?.session.status === "running") this.client.send({ op: "kill", id, signal: "SIGKILL" });
      }, 3000);
    } else {
      this.live.delete(id);
      this.titleTail.delete(id);
      screens.forget(id);
      db.dismissSession(id);
      if (l.local === undefined) this.client.send({ op: "kill", id });
    }
  }

  /** Which topic a session is in (topics.ts decides). Exited sessions keep theirs as history. */
  setTopic(id: string, topicId: string | undefined, coordinator = false): void {
    const l = this.live.get(id);
    if (!l || (l.session.topicId === topicId && !!l.session.coordinator === coordinator)) return;
    l.session.topicId = topicId;
    l.session.coordinator = coordinator || undefined;
    db.updateSession(id, { topicId, coordinator });
    this.emit("update", l.session);
  }

  /** Rename a session (terminal title from the PTY, or /rename seen in the transcript). */
  setTitle(id: string, title: string): void {
    const l = this.live.get(id);
    const t = title.trim();
    if (!l || !t || l.session.title === t) return;
    l.session.title = t;
    db.updateSession(id, { title: t });
    this.emit("update", l.session);
  }

  // The rail shows what the terminal's title bar would: OSC 0/2 from the PTY. Claude Code
  // sets it to the /rename title (or its own summary), shells to whatever the user's rc does.
  // A sequence may straddle two chunks, so an unterminated tail is kept for the next one.
  private titleTail = new Map<string, string>();
  private noteTitle(l: Live, data: string): void {
    const id = l.session.id;
    const tail = this.titleTail.get(id);
    if (!tail && !data.includes("\x1b")) return;
    const buf = (tail ?? "") + data;
    let title: string | undefined;
    for (const m of buf.matchAll(OSC_TITLE)) title = m[1];
    if (title !== undefined && !EXE_TITLE.test(title)) this.setTitle(id, title.replace(LEADING_GLYPH, ""));
    const start = buf.lastIndexOf("\x1b]");
    const rest = start >= 0 ? buf.slice(start) : "";
    if (rest && !OSC_END.test(rest)) this.titleTail.set(id, rest.slice(0, 1024));
    else if (buf.endsWith("\x1b")) this.titleTail.set(id, "\x1b");
    else this.titleTail.delete(id);
  }

  /** Register a session Henry did not spawn (hooks.ts, for a claude started elsewhere). No PTY behind it. */
  registerExternal(session: Session): void {
    if (this.live.has(session.id)) return;
    const note = `[henry] external session: started outside Henry, output not captured (cwd ${session.cwd})\r\n`;
    this.hold(session.id, { session, local: note, external: true });
    db.insertSession(session);
    this.emit("update", session);
  }

  /** Bind Claude's own session_id to a PTY session (hooks.ts). Also marks Claude as active in it. */
  bindClaudeSession(id: string, claudeSessionId: string): void {
    const l = this.live.get(id);
    if (!l) return;
    const patch: Partial<Session> = {};
    if (l.session.claudeSessionId !== claudeSessionId) patch.claudeSessionId = claudeSessionId;
    if (!l.session.claudeActive) patch.claudeActive = true;
    if (!Object.keys(patch).length) return;
    Object.assign(l.session, patch);
    db.updateSession(id, patch);
    this.emit("update", l.session);
  }

  /** Claude inside this PTY sent SessionEnd (hooks.ts). A shell goes back to being a plain terminal. */
  claudeEnded(id: string): void {
    const l = this.live.get(id);
    if (!l || !l.session.claudeActive) return;
    l.session.claudeActive = false;
    l.session.activity = undefined;
    l.session.activitySince = undefined;
    l.session.lastInputAt = undefined;
    l.session.prompts = undefined;
    db.updateSession(id, { claudeActive: false });
    this.emit("update", l.session);
  }

  /**
   * Working / needsInput / waiting / idle, decided by activity.ts. Not persisted: it
   * describes this moment, and a restart re-derives it from the event log. `undefined`
   * clears it (Claude ended, session exited).
   */
  setActivity(id: string, activity: Session["activity"], since = Date.now()): void {
    const l = this.live.get(id);
    if (!l || l.session.activity === activity) return;
    l.session.activity = activity;
    l.session.activitySince = activity ? since : undefined;
    this.emit("update", l.session);
  }

  /** Your engagement with a Claude session, decided by engagement.ts. Not persisted, like activity. */
  setEngagement(id: string, lastInputAt: number | undefined, prompts: number[] | undefined): void {
    const l = this.live.get(id);
    if (!l || l.session.status !== "running") return;
    l.session.lastInputAt = lastInputAt;
    l.session.prompts = prompts;
    this.emit("update", l.session);
  }

  /** Unseen, reminder and last-seen marks, decided by seen.ts and notify.ts. Persisted: nothing
   * replays them. A key present in `marks` is set, undefined included; an absent one is kept. */
  setMarks(id: string, marks: Partial<Pick<Session, "unseenSince" | "remindAt" | "lastSeenAt">>): void {
    const l = this.live.get(id);
    if (!l || l.session.status !== "running") return;
    const changed = (Object.keys(marks) as (keyof typeof marks)[]).filter((k) => l.session[k] !== marks[k]);
    if (!changed.length) return;
    Object.assign(l.session, marks);
    // updateSession writes a present-but-undefined key as NULL.
    db.updateSession(id, marks);
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
    l.session.endedAt = Date.now();
    l.session.activity = undefined;
    l.session.activitySince = undefined;
    l.session.lastInputAt = undefined;
    l.session.prompts = undefined;
    l.session.unseenSince = undefined;
    l.session.remindAt = undefined;
    // An ask outlives its turn, not its session: there is nobody left to come to.
    attention.clearSession(l.session.id, l.session.endedAt);
    this.titleTail.delete(l.session.id);
    db.updateSession(l.session.id, { status: "exited", exitCode, endedAt: l.session.endedAt, unseenSince: undefined, remindAt: undefined });
    this.emit("exit", l.session.id, exitCode);
    this.emit("update", l.session);
  }
}

const OSC_TITLE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC_END = /\x07|\x1b\\/;
/** ConPTY announces the console's default title, the shell's own path ("C:\...\powershell.exe",
 * "Administrator: C:\...\cmd.exe - node x.js"), as an OSC 0. That is no name for a tab. */
const EXE_TITLE = /^(?:administrator:\s*)?[a-z]:\\[^\r\n]*?\.exe(?:\s|$)/i;
/** Claude Code prefixes its title with a status glyph (✳ idle, ◔◑◕ spinner, braille); the rail has its own icon. */
const LEADING_GLYPH = /^[\u2190-\u21ff\u2500-\u27bf\u2800-\u28ff\u2b00-\u2bff\u{1f300}-\u{1faff}]\ufe0f?\s*/u;

export const sessions = new SessionManager();
