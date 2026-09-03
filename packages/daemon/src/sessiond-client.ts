// Client for henry-sessiond (packages/sessiond): the long-lived Node process that owns the
// PTYs. This is the only daemon module that knows how sessiond is found, started and spoken
// to. sessions.ts drives it; index.ts uses it for `henry sessiond status|restart`.
//
// Lifecycle: connect() reads <henryDir>/sessiond.json and connects; if the file is missing,
// stale, or refuses us, it spawns a detached sessiond and waits for a fresh file. A dropped
// connection triggers reconnect with backoff and a "connect" event so the owner can
// re-attach. close() stops all of that; it never stops sessiond itself.
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type SessionSummary, type SessiondInfo } from "../../sessiond/src/protocol";

export { PROTOCOL_VERSION };
export type { ClientMessage, ServerMessage, SessionSummary, SessiondInfo };

export const sessiondMain = join(import.meta.dir, "../../sessiond/src/main.ts");

export interface SessiondClientEvents {
  /** Connected (or reconnected) and past hello; carries sessiond's session table. */
  connect: [sessions: SessionSummary[], info: { protocolVersion: number; pid: number }];
  disconnect: [];
  spawned: [id: string, pid: number];
  data: [id: string, data: string];
  scrollback: [id: string, data: string];
  exit: [id: string, exitCode: number, signal?: number];
  sessions: [sessions: SessionSummary[]];
  error: [id: string | undefined, message: string];
}

export interface SessiondClientOptions {
  henryDir: string;
  /** Environment for a sessiond we spawn (caller strips CLAUDE_CODE_* etc.). */
  env?: Record<string, string>;
  /** Spawn a sessiond when none answers. Default true; the CLI passes false. */
  autoStart?: boolean;
  /** Reconnect after a drop. Default true. */
  reconnect?: boolean;
  log?: (msg: string) => void;
}

export function readSessiondInfo(henryDir: string): SessiondInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(join(henryDir, "sessiond.json"), "utf8"));
    return typeof info?.port === "number" && typeof info?.token === "string" ? info : undefined;
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One-shot dial: connect, hello, resolve with the reply. Rejects on refusal or timeout. */
export function dial(info: SessiondInfo, timeoutMs = 2000): Promise<{ socket: Socket; hello: Extract<ServerMessage, { op: "hello" }> }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: info.port });
    let buf = "";
    const fail = (why: string) => {
      clearTimeout(t);
      socket.destroy();
      reject(new Error(why));
    };
    const t = setTimeout(() => fail("sessiond did not answer hello"), timeoutMs);
    socket.once("error", (e) => fail(`connect failed: ${e.message}`));
    socket.once("close", () => fail("sessiond closed the connection"));
    socket.once("connect", () => {
      socket.setNoDelay(true);
      socket.write(JSON.stringify({ op: "hello", token: info.token, protocolVersion: PROTOCOL_VERSION } satisfies ClientMessage) + "\n");
    });
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      const rest = buf.slice(nl + 1);
      let msg: ServerMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        return fail("sessiond sent invalid JSON");
      }
      if (msg.op !== "hello") return fail(`sessiond refused: ${msg.op === "error" ? msg.message : msg.op}`);
      clearTimeout(t);
      socket.off("data", onData);
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      if (rest) socket.unshift(Buffer.from(rest, "utf8"));
      resolve({ socket, hello: msg });
    };
    socket.on("data", onData);
  });
}

export class SessiondClient extends EventEmitter<SessiondClientEvents> {
  readonly henryDir: string;
  private readonly opts: SessiondClientOptions;
  private socket: Socket | undefined;
  private connecting: Promise<SessionSummary[]> | undefined;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 250;
  private waiters = new Map<string, Array<(data: string) => void>>();
  private listWaiters: Array<(s: SessionSummary[]) => void> = [];
  private pongWaiters: Array<() => void> = [];
  info: SessiondInfo | undefined;
  remoteProtocolVersion: number | undefined;
  remotePid: number | undefined;

  constructor(opts: SessiondClientOptions) {
    super();
    this.opts = opts;
    this.henryDir = opts.henryDir;
  }

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  private log(msg: string): void {
    (this.opts.log ?? ((m) => console.error(m)))(`[sessiond] ${msg}`);
  }

  /** Ensure a live connection; resolves with sessiond's session table. Safe to call repeatedly. */
  connect(): Promise<SessionSummary[]> {
    if (this.closed) return Promise.reject(new Error("client closed"));
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async doConnect(): Promise<SessionSummary[]> {
    let dialed = await this.tryDial();
    if (!dialed) {
      if (this.opts.autoStart === false) throw new Error(`no sessiond answering in ${this.henryDir}`);
      dialed = await this.startAndDial();
    }
    const { socket, hello } = dialed;
    this.socket = socket;
    this.remoteProtocolVersion = hello.protocolVersion;
    this.remotePid = hello.pid;
    this.retryDelay = 250;
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      this.log(
        `WARNING: sessiond pid ${hello.pid} speaks protocol ${hello.protocolVersion}, this daemon expects ${PROTOCOL_VERSION}. ` +
          `Run \`henry sessiond restart\` to drain it and pick up the new version; continuing for now.`,
      );
    }
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });
    socket.on("error", (e) => this.log(`socket error: ${e.message}`));
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.failWaiters();
      this.emit("disconnect");
      if (!this.closed && this.opts.reconnect !== false) this.scheduleReconnect();
    });
    this.emit("connect", hello.sessions, { protocolVersion: hello.protocolVersion, pid: hello.pid });
    return hello.sessions;
  }

  private async tryDial(): Promise<Awaited<ReturnType<typeof dial>> | undefined> {
    const info = readSessiondInfo(this.henryDir);
    if (!info) return undefined;
    if (!pidAlive(info.pid)) return undefined;
    try {
      const d = await dial(info);
      this.info = info;
      return d;
    } catch (e) {
      this.log(`sessiond.json points at pid ${info.pid} port ${info.port} but ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Spawn `node main.ts --daemon` (it double-forks and the launcher exits at once) and wait for a fresh sessiond.json. */
  private async startAndDial(): Promise<Awaited<ReturnType<typeof dial>>> {
    const node = Bun.which("node");
    if (!node) throw new Error("node is required on PATH to run henry-sessiond (see README)");
    const stale = readSessiondInfo(this.henryDir);
    this.log(`starting ${sessiondMain}${stale ? ` (replacing stale sessiond.json pid ${stale.pid})` : ""}`);
    const child = spawn(node, [sessiondMain, "--daemon"], {
      detached: true,
      stdio: "ignore",
      env: { ...(this.opts.env ?? (process.env as Record<string, string>)), HENRY_HOME: this.henryDir },
    });
    child.on("error", (e) => this.log(`spawn failed: ${e.message}`));
    child.unref();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const info = readSessiondInfo(this.henryDir);
      if (info && (!stale || info.pid !== stale.pid || info.startedAt !== stale.startedAt) && pidAlive(info.pid)) {
        try {
          const d = await dial(info, 1000);
          this.info = info;
          return d;
        } catch {
          // not ready yet
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("sessiond did not come up within 5s (see sessiond.log)");
  }

  private scheduleReconnect(): void {
    clearTimeout(this.retryTimer);
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 5000);
    this.log(`connection lost; reconnecting in ${delay}ms`);
    this.retryTimer = setTimeout(() => {
      this.connect().catch((e) => {
        this.log(`reconnect failed: ${(e as Error).message}`);
        if (!this.closed) this.scheduleReconnect();
      });
    }, delay);
  }

  private onLine(line: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`invalid JSON from sessiond: ${line.slice(0, 80)}`);
      return;
    }
    switch (msg.op) {
      case "spawned":
        return void this.emit("spawned", msg.id, msg.pid);
      case "data":
        return void this.emit("data", msg.id, msg.data);
      case "scrollback": {
        const w = this.waiters.get(msg.id)?.shift();
        if (w) w(msg.data);
        return void this.emit("scrollback", msg.id, msg.data);
      }
      case "exit":
        return void this.emit("exit", msg.id, msg.exitCode, msg.signal);
      case "sessions": {
        for (const w of this.listWaiters.splice(0)) w(msg.sessions);
        return void this.emit("sessions", msg.sessions);
      }
      case "error": {
        if (msg.id) for (const w of this.waiters.get(msg.id)?.splice(0) ?? []) w("");
        return void this.emit("error", msg.id, msg.message);
      }
      case "pong":
        for (const w of this.pongWaiters.splice(0)) w();
        return;
      case "hello":
        return;
    }
  }

  private failWaiters(): void {
    for (const ws of this.waiters.values()) for (const w of ws) w("");
    this.waiters.clear();
    for (const w of this.listWaiters.splice(0)) w([]);
    this.pongWaiters.splice(0);
  }

  /** Fire-and-forget; returns false (and drops the message) when not connected. */
  send(msg: ClientMessage): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    this.socket.write(JSON.stringify(msg) + "\n");
    return true;
  }

  /**
   * Attach (subscribe) and hand the scrollback to `cb`. The callback runs synchronously
   * inside the socket's data handler, so anything the caller does in it happens before
   * the next live `data` event: that is what keeps a window's scrollback ahead of its
   * live stream. `cb("")` on disconnect or error.
   */
  attach(id: string, cb: (scrollback: string) => void): void {
    if (!this.connected) return cb("");
    let list = this.waiters.get(id);
    if (!list) this.waiters.set(id, (list = []));
    list.push(cb);
    this.send({ op: "attach", id });
  }

  list(): Promise<SessionSummary[]> {
    return new Promise((res) => {
      if (!this.send({ op: "list" })) return res([]);
      this.listWaiters.push(res);
    });
  }

  ping(timeoutMs = 1000): Promise<boolean> {
    return new Promise((res) => {
      if (!this.send({ op: "ping" })) return res(false);
      const t = setTimeout(() => res(false), timeoutMs);
      this.pongWaiters.push(() => {
        clearTimeout(t);
        res(true);
      });
    });
  }

  /** Drop the connection and stop reconnecting. sessiond keeps running. */
  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    const s = this.socket;
    this.socket = undefined;
    s?.destroy();
    this.failWaiters();
  }
}
