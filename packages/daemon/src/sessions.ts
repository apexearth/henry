// PTY session manager. Owns Session records and per-session scrollback; the PTYs
// themselves live in pty-host.ts (Node child, see comment there). Emits:
//   "update" (session)                 - created / changed / exited
//   "data"   (sessionId, data: string) - live PTY output
//   "exit"   (sessionId, exitCode)
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";
import type { Session } from "@henry/shared";
import { config } from "./config";
import * as db from "./db";
import type { HostCommand, HostEvent } from "./pty-host";

const SCROLLBACK_BYTES = 2 * 1024 * 1024;

export interface CreateOptions {
  cwd: string;
  title?: string;
  command?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  parentSessionId?: string;
}

interface Live {
  session: Session;
  chunks: string[];
  bytes: number;
}

export interface SessionEvents {
  update: [session: Session];
  data: [sessionId: string, data: string];
  exit: [sessionId: string, exitCode: number];
}

class SessionManager extends EventEmitter<SessionEvents> {
  private live = new Map<string, Live>();
  private host: ChildProcess | undefined;
  private hostReady: Promise<void> | undefined;

  constructor() {
    super();
    db.markAllSessionsExited();
  }

  list(): Session[] {
    return [...this.live.values()].map((l) => l.session).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Session | undefined {
    return this.live.get(id)?.session;
  }

  scrollback(id: string): string {
    return this.live.get(id)?.chunks.join("") ?? "";
  }

  async create(opts: CreateOptions): Promise<Session> {
    const id = crypto.randomUUID();
    const command = opts.command ?? resolveClaude();
    const session: Session = {
      id,
      cwd: opts.cwd,
      title: opts.title || basename(opts.cwd),
      createdAt: Date.now(),
      status: "running",
      command,
      parentSessionId: opts.parentSessionId,
    };
    this.live.set(id, { session, chunks: [], bytes: 0 });
    db.insertSession(session);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, {
      HENRY_SESSION: id,
      HENRY_PORT: String(config.port),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
    await this.send({ op: "spawn", id, command, args: opts.args ?? [], cwd: opts.cwd, env, cols: opts.cols ?? 120, rows: opts.rows ?? 36 });
    this.emit("update", session);
    return session;
  }

  write(id: string, data: string): void {
    if (this.live.get(id)?.session.status === "running") void this.send({ op: "write", id, data });
  }

  resize(id: string, cols: number, rows: number): void {
    if (this.live.get(id)?.session.status === "running") void this.send({ op: "resize", id, cols, rows });
  }

  /** Kill a running session; on an exited one, forget it (drops it from the rail). */
  kill(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    if (l.session.status === "running") {
      void this.send({ op: "kill", id, signal: "SIGHUP" });
      // Anything still alive after a grace period gets SIGKILL.
      setTimeout(() => {
        if (this.live.get(id)?.session.status === "running") void this.send({ op: "kill", id, signal: "SIGKILL" });
      }, 3000);
    } else {
      this.live.delete(id);
    }
  }

  /** Bind Claude's own session_id to a PTY session (milestone 2 calls this from hooks.ts). */
  bindClaudeSession(id: string, claudeSessionId: string): void {
    const l = this.live.get(id);
    if (!l || l.session.claudeSessionId === claudeSessionId) return;
    l.session.claudeSessionId = claudeSessionId;
    db.updateSession(id, { claudeSessionId });
    this.emit("update", l.session);
  }

  shutdown(): void {
    this.host?.stdin?.end();
  }

  // ---- host process ----

  private async send(cmd: HostCommand): Promise<void> {
    await this.ensureHost();
    this.host!.stdin!.write(JSON.stringify(cmd) + "\n");
  }

  private ensureHost(): Promise<void> {
    if (this.host && this.hostReady) return this.hostReady;
    const node = Bun.which("node");
    if (!node) throw new Error("node is required on PATH to host PTYs (see README)");
    const host = spawn(node, [join(import.meta.dir, "pty-host.ts")], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
    this.host = host;
    this.hostReady = new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null) => reject(new Error(`pty-host exited early (code ${code})`));
      host.once("exit", onExit);
      createInterface({ input: host.stdout! }).on("line", (line) => {
        let ev: HostEvent;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.ev === "ready") {
          host.off("exit", onExit);
          resolve();
        } else this.onHostEvent(ev);
      });
    });
    host.on("exit", (code) => {
      console.error(`[henry] pty-host exited (code ${code}); marking sessions exited`);
      this.host = undefined;
      this.hostReady = undefined;
      for (const l of this.live.values()) if (l.session.status === "running") this.finish(l, 1);
    });
    return this.hostReady;
  }

  private onHostEvent(ev: HostEvent): void {
    if (ev.ev === "ready") return;
    const l = this.live.get(ev.id);
    if (!l) return;
    switch (ev.ev) {
      case "spawned":
        l.session.pid = ev.pid;
        db.updateSession(ev.id, { pid: ev.pid });
        return;
      case "data":
        l.chunks.push(ev.data);
        l.bytes += ev.data.length;
        while (l.bytes > SCROLLBACK_BYTES && l.chunks.length > 1) l.bytes -= l.chunks.shift()!.length;
        this.emit("data", ev.id, ev.data);
        return;
      case "exit":
        this.finish(l, ev.exitCode);
        return;
      case "error":
        this.emit("data", ev.id, `\r\n[henry] failed to start ${l.session.command}: ${ev.message}\r\n`);
        this.finish(l, 127);
        return;
    }
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
