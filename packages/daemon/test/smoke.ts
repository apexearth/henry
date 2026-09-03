// Smoke test: boots a daemon on a scratch port/home, creates a shell session over WS,
// sends input, checks the echo, kills the session. Run: bun run smoke
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, ServerMessage } from "@henry/shared";

const PORT = 47110 + Math.floor(Math.random() * 100);
const home = mkdtempSync(join(tmpdir(), "henry-smoke-"));
const daemonDir = join(import.meta.dir, "..");

const daemon = Bun.spawn(["bun", "src/index.ts", "start"], {
  cwd: daemonDir,
  env: { ...process.env, HENRY_HOME: home, HENRY_PORT: String(PORT) },
  stdout: "inherit",
  stderr: "inherit",
});

const log = (...a: unknown[]) => console.log("[smoke]", ...a);
const fail = (why: string): never => {
  log("FAIL:", why);
  cleanup();
  process.exit(1);
};
function cleanup() {
  daemon.kill();
  rmSync(home, { recursive: true, force: true });
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, ms = 10000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v !== undefined) return v;
    await Bun.sleep(50);
  }
  return fail(`timeout waiting for ${what}`);
}

await waitFor("daemon http", async () => {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok || undefined;
  } catch {
    return undefined;
  }
});
log("daemon up on", PORT);

const inbox: ServerMessage[] = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
const sendMsg = (m: ClientMessage) => ws.send(JSON.stringify(m));
await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });

const next = <T extends ServerMessage["type"]>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true) =>
  waitFor(type, () => {
    const i = inbox.findIndex((m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
    return i >= 0 ? (inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>) : undefined;
  });

const state = await next("state");
log("initial state:", state.sessions.length, "sessions; defaultRepo =", state.config.defaultRepo);

sendMsg({ type: "session:create", cwd: process.env.HOME!, title: "smoke", command: "/bin/sh", args: [], requestId: "r1" });
const created = await next("session:update", (m) => m.requestId === "r1");
const id = created.session.id;
log("created session", id, "status", created.session.status, "cmd", created.session.command);

sendMsg({ type: "attach", sessionId: id });
const sb = await next("pty:scrollback", (m) => m.sessionId === id);
log("scrollback bytes:", sb.data.length);

sendMsg({ type: "pty:resize", sessionId: id, cols: 100, rows: 30 });
sendMsg({ type: "pty:input", sessionId: id, data: "echo smoke-$((40+2))\r" });
let seen = "";
await waitFor("pty:data containing smoke-42", () => {
  for (const m of inbox.splice(0)) if (m.type === "pty:data" && m.sessionId === id) seen += m.data;
  return seen.includes("smoke-42") || undefined;
});
log("echo ok:", JSON.stringify(seen.slice(-80)));

// A second window attaching should get the same scrollback, including our echo.
const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const sb2 = await new Promise<string>((res) => {
  ws2.onopen = () => ws2.send(JSON.stringify({ type: "attach", sessionId: id } satisfies ClientMessage));
  ws2.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as ServerMessage;
    if (m.type === "pty:scrollback" && m.sessionId === id) res(m.data);
  };
});
if (!sb2.includes("smoke-42")) fail("second window scrollback missing echo");
log("second window scrollback ok:", sb2.length, "bytes");
ws2.close();

sendMsg({ type: "session:kill", sessionId: id });
const exit = await next("pty:exit", (m) => m.sessionId === id);
log("exit code", exit.exitCode);
const upd = await next("session:update", (m) => m.session.id === id && m.session.status === "exited");
log("session status:", upd.session.status);

const rest = await fetch(`http://127.0.0.1:${PORT}/api/state`).then((r) => r.json()) as { sessions: { id: string; status: string }[] };
log("/api/state sessions:", rest.sessions.map((s) => `${s.id.slice(0, 8)}:${s.status}`).join(", "));
const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json()) as { name: string }[];
log("/api/repos:", repos.length, "repos");

ws.close();
cleanup();
log("PASS");
process.exit(0);
