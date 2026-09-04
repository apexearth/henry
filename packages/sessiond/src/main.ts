// henry-sessiond: owns the PTYs so Claude sessions survive daemon restarts.
//
// Runs on Node (node-pty cannot deliver data under Bun 1.3.3) and speaks NDJSON over a
// loopback TCP socket; see protocol.ts. The daemon connects, spawns and attaches; when the
// daemon restarts it reconnects and re-attaches to the same live sessions with scrollback
// intact. This process is meant to be boring: node-pty is its only dependency and it must
// never import anything from the rest of the repo.
import { spawn as spawnProcess } from "node:child_process";
import { createServer, createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as pty from "node-pty";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type SessionSummary, type SessiondInfo } from "./protocol.ts";

const SCROLLBACK_BYTES = 2 * 1024 * 1024;
const EXITED_RETENTION_MS = 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

const henryHome = process.env.HENRY_HOME ? resolve(process.env.HENRY_HOME) : join(homedir(), ".henry");
const infoPath = join(henryHome, "sessiond.json");
const logPath = join(henryHome, "sessiond.log");

function log(msg: string): void {
  const line = `${new Date().toISOString()} [sessiond ${process.pid}] ${msg}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
    // logging must never take us down
  }
  if (process.stderr.isTTY) process.stderr.write(line);
}

// `bun install` skips node-pty's postinstall unless it is a trustedDependency; that
// postinstall is what makes spawn-helper executable. Fix the bit here so it cannot matter.
function fixSpawnHelper(): void {
  try {
    const req = createRequire(import.meta.url);
    const pkgDir = dirname(req.resolve("node-pty/package.json"));
    const helper = join(pkgDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    if (!(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
  } catch {
    // no prebuild dir (built from source) — nothing to fix
  }
}

// node-pty on Windows rejects a signal argument outright (ConPTY has no signals to deliver;
// the process is terminated instead). Elsewhere the signal goes through as asked.
function hangup(term: pty.IPty, signal?: string): void {
  if (process.platform === "win32") term.kill();
  else term.kill(signal);
}
// ---- sessions ----

interface Conn {
  socket: Socket;
  authed: boolean;
}

interface Sess {
  summary: SessionSummary;
  term?: pty.IPty;
  chunks: string[];
  bytes: number;
  subscribers: Set<Conn>;
}

const sessions = new Map<string, Sess>();
const conns = new Set<Conn>();
let draining = false;

function send(conn: Conn, msg: ServerMessage): void {
  if (conn.socket.destroyed) return;
  try {
    conn.socket.write(JSON.stringify(msg) + "\n");
  } catch (e) {
    log(`write to client failed: ${(e as Error).message}`);
  }
}

function summaries(): SessionSummary[] {
  return [...sessions.values()].map((s) => s.summary).sort((a, b) => a.createdAt - b.createdAt);
}

function broadcastSessions(): void {
  const msg: ServerMessage = { op: "sessions", sessions: summaries() };
  for (const c of conns) if (c.authed) send(c, msg);
}

function runningCount(): number {
  let n = 0;
  for (const s of sessions.values()) if (s.summary.status === "running") n++;
  return n;
}

function forget(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  s.subscribers.clear();
}

function onExit(s: Sess, exitCode: number, signal?: number): void {
  if (s.summary.status === "exited") return;
  s.term = undefined;
  s.summary.status = "exited";
  s.summary.exitCode = exitCode;
  s.summary.endedAt = Date.now();
  log(`session ${s.summary.id} exited (code ${exitCode}${signal ? `, signal ${signal}` : ""})`);
  const msg: ServerMessage = { op: "exit", id: s.summary.id, exitCode, signal };
  for (const c of s.subscribers) send(c, msg);
  broadcastSessions();
  if (draining && runningCount() === 0) {
    log("drained; exiting");
    exit(0);
  }
}

function spawn(conn: Conn, cmd: Extract<ClientMessage, { op: "spawn" }>): void {
  if (sessions.has(cmd.id)) return send(conn, { op: "error", id: cmd.id, message: "session id already exists" });
  if (draining) return send(conn, { op: "error", id: cmd.id, message: "sessiond is shutting down; start a new one" });
  const cols = cmd.cols > 0 ? cmd.cols : 120;
  const rows = cmd.rows > 0 ? cmd.rows : 36;
  let term: pty.IPty;
  try {
    term = pty.spawn(cmd.command, cmd.args ?? [], { name: "xterm-256color", cols, rows, cwd: cmd.cwd, env: cmd.env ?? {} });
  } catch (e) {
    log(`spawn ${cmd.command} failed: ${(e as Error).message}`);
    return send(conn, { op: "error", id: cmd.id, message: `spawn failed: ${(e as Error).message}` });
  }
  const s: Sess = {
    summary: { id: cmd.id, command: cmd.command, args: cmd.args ?? [], cwd: cmd.cwd, pid: term.pid, cols, rows, status: "running", createdAt: Date.now() },
    term,
    chunks: [],
    bytes: 0,
    subscribers: new Set(),
  };
  sessions.set(cmd.id, s);
  term.onData((data) => {
    s.chunks.push(data);
    s.bytes += data.length;
    while (s.bytes > SCROLLBACK_BYTES && s.chunks.length > 1) s.bytes -= s.chunks.shift()!.length;
    const msg: ServerMessage = { op: "data", id: cmd.id, data };
    for (const c of s.subscribers) send(c, msg);
  });
  term.onExit(({ exitCode, signal }) => onExit(s, exitCode, signal));
  log(`session ${cmd.id} spawned ${cmd.command} pid ${term.pid} in ${cmd.cwd}`);
  send(conn, { op: "spawned", id: cmd.id, pid: term.pid });
  broadcastSessions();
}

function handle(conn: Conn, msg: ClientMessage): void {
  if (!msg || typeof msg !== "object" || typeof (msg as { op?: unknown }).op !== "string") {
    return send(conn, { op: "error", message: "message must be an object with a string op" });
  }
  const s = "id" in msg && typeof msg.id === "string" ? sessions.get(msg.id) : undefined;
  switch (msg.op) {
    case "hello":
      return send(conn, { op: "error", message: "already said hello" });
    case "spawn":
      return spawn(conn, msg);
    case "write":
      if (!s) return send(conn, { op: "error", id: msg.id, message: "unknown session" });
      if (!s.term) return send(conn, { op: "error", id: msg.id, message: "session has exited" });
      s.term.write(String(msg.data ?? ""));
      return;
    case "resize":
      if (!s) return send(conn, { op: "error", id: msg.id, message: "unknown session" });
      if (s.term && msg.cols > 0 && msg.rows > 0) {
        s.term.resize(msg.cols, msg.rows);
        s.summary.cols = msg.cols;
        s.summary.rows = msg.rows;
      }
      return;
    case "kill":
      if (!s) return send(conn, { op: "error", id: msg.id, message: "unknown session" });
      if (s.term) {
        log(`session ${msg.id}: ${msg.signal ?? "SIGHUP"}`);
        try {
          hangup(s.term, msg.signal);
        } catch (e) {
          send(conn, { op: "error", id: msg.id, message: `kill failed: ${(e as Error).message}` });
        }
      } else {
        forget(msg.id);
        broadcastSessions();
      }
      return;
    case "attach":
      if (!s) return send(conn, { op: "error", id: msg.id, message: "unknown session" });
      s.subscribers.add(conn);
      send(conn, { op: "scrollback", id: msg.id, data: s.chunks.join("") });
      if (s.summary.status === "exited") send(conn, { op: "exit", id: msg.id, exitCode: s.summary.exitCode ?? 0 });
      return;
    case "detach":
      s?.subscribers.delete(conn);
      return;
    case "list":
      return send(conn, { op: "sessions", sessions: summaries() });
    case "ping":
      return send(conn, { op: "pong" });
    case "shutdown":
      if (msg.when === "now") {
        log("shutdown now: hanging up every running session");
        for (const x of sessions.values()) {
          try {
            if (x.term) hangup(x.term, "SIGHUP");
          } catch {}
        }
        setTimeout(() => exit(0), 150);
      } else {
        draining = true;
        log(`shutdown when idle (${runningCount()} running)`);
        if (runningCount() === 0) setTimeout(() => exit(0), 50);
      }
      return;
    default:
      return send(conn, { op: "error", message: `unknown op ${(msg as { op: string }).op}` });
  }
}

// ---- server ----

const token = randomBytes(32).toString("hex");

function onConnection(socket: Socket): void {
  const conn: Conn = { socket, authed: false };
  conns.add(conn);
  log(`client connected (${conns.size} open)`);
  socket.setNoDelay(true);
  socket.on("error", (e) => log(`client socket error: ${e.message}`));
  socket.on("close", () => {
    conns.delete(conn);
    for (const s of sessions.values()) s.subscribers.delete(conn);
    log(`client closed (${conns.size} open)`);
  });
  createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
    if (!line) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      send(conn, { op: "error", message: "invalid JSON" });
      if (!conn.authed) socket.destroy();
      return;
    }
    if (!conn.authed) {
      if (!msg || msg.op !== "hello" || msg.token !== token || typeof msg.protocolVersion !== "number") {
        send(conn, { op: "error", message: "first message must be hello with a valid token" });
        socket.destroy();
        return;
      }
      conn.authed = true;
      if (msg.protocolVersion !== PROTOCOL_VERSION) log(`client speaks protocol ${msg.protocolVersion}, this sessiond speaks ${PROTOCOL_VERSION}`);
      send(conn, { op: "hello", protocolVersion: PROTOCOL_VERSION, pid: process.pid, sessions: summaries() });
      return;
    }
    try {
      handle(conn, msg);
    } catch (e) {
      log(`handling ${(msg as { op?: string }).op} failed: ${(e as Error).stack ?? e}`);
      send(conn, { op: "error", id: (msg as { id?: string }).id, message: (e as Error).message });
    }
  });
}

function readInfo(): SessiondInfo | undefined {
  try {
    return JSON.parse(readFileSync(infoPath, "utf8"));
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True if the sessiond described by `info` accepts a hello. */
function answersHello(info: SessiondInfo, timeoutMs = 1500): Promise<boolean> {
  return new Promise((res) => {
    const sock = createConnection({ host: "127.0.0.1", port: info.port });
    const done = (ok: boolean) => {
      clearTimeout(t);
      sock.destroy();
      res(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    sock.on("error", () => done(false));
    sock.on("connect", () => sock.write(JSON.stringify({ op: "hello", token: info.token, protocolVersion: PROTOCOL_VERSION }) + "\n"));
    createInterface({ input: sock }).once("line", (line) => {
      try {
        done(JSON.parse(line).op === "hello");
      } catch {
        done(false);
      }
    });
  });
}

function writeInfo(port: number): void {
  const info: SessiondInfo = { port, token, pid: process.pid, protocolVersion: PROTOCOL_VERSION, startedAt: Date.now() };
  const tmp = `${infoPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, infoPath);
}

let exiting = false;
function exit(code: number): void {
  if (exiting) return;
  exiting = true;
  try {
    if (readInfo()?.pid === process.pid) unlinkSync(infoPath);
  } catch {}
  log(`exit ${code}`);
  process.exit(code);
}

async function main(): Promise<void> {
  mkdirSync(henryHome, { recursive: true });
  if (process.argv.includes("--daemon")) {
    // Double fork. The daemon that starts us runs under `bun --watch`, which reloads in
    // place and keeps its pid, so a direct child it stops tracking would linger as a
    // zombie after exit. This short-lived process is reaped at once; the real sessiond
    // is its detached child and gets reparented to init/launchd. execArgv carries the
    // type-stripping flag on Node versions that need it; windowsHide keeps Windows from
    // opening a console window for the detached child.
    const child = spawnProcess(process.execPath, [...process.execArgv, process.argv[1]!], { detached: true, stdio: "ignore", env: process.env, windowsHide: true });
    child.unref();
    process.exit(0);
  }
  const existing = readInfo();
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid) && (await answersHello(existing))) {
    // Only one sessiond per HENRY_HOME. Not an error: the daemon spawns speculatively.
    process.exit(0);
  }
  fixSpawnHelper();

  const server = createServer(onConnection);
  server.on("error", (e) => {
    log(`server error: ${e.message}`);
    exit(1);
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  writeInfo(port);
  log(`listening on 127.0.0.1:${port} (home ${henryHome}, protocol ${PROTOCOL_VERSION})`);

  // Exited sessions keep their scrollback for a day, then go.
  setInterval(() => {
    const cutoff = Date.now() - EXITED_RETENTION_MS;
    let changed = false;
    for (const s of sessions.values()) {
      if (s.summary.status === "exited" && (s.summary.endedAt ?? 0) < cutoff) {
        forget(s.summary.id);
        changed = true;
      }
    }
    if (changed) broadcastSessions();
  }, SWEEP_INTERVAL_MS).unref();
  server.ref();
}

process.on("SIGHUP", () => log("SIGHUP ignored"));
process.on("SIGTERM", () => {
  const n = runningCount();
  if (n === 0) {
    log("SIGTERM with no running sessions; exiting");
    exit(0);
  } else {
    log(`SIGTERM ignored: ${n} session(s) still running (use \`henry sessiond restart --now\`, or SIGKILL)`);
  }
});
// Only a foreground run (bun run sessiond) has a terminal to send SIGINT; treat it as "shutdown now".
process.on("SIGINT", () => {
  log("SIGINT: hanging up every running session");
  for (const s of sessions.values()) {
    try {
      if (s.term) hangup(s.term, "SIGHUP");
    } catch {}
  }
  setTimeout(() => exit(0), 150);
});
process.on("uncaughtException", (e) => log(`uncaught exception: ${e.stack ?? e}`));
process.on("unhandledRejection", (e) => log(`unhandled rejection: ${(e as Error)?.stack ?? e}`));

main().catch((e) => {
  log(`startup failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
