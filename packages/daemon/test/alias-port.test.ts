// The daemon keeps answering on the ports its live sessions were launched against.
//
// A hook re-reads <henry home>/port on every call, so it follows the daemon (port.test.ts).
// An MCP client cannot: installer.ts bakes the port into launch-mcp.json, Claude Code reads
// it once at session start, and a running process has no way to re-resolve the url. So the
// daemon goes to the session instead, and stops once the last session naming that port exits.
//
// Boots daemons as child processes under a scratch HENRY_HOME on random ports; never touches
// ~/.henry or :14711. Run: bun test test/alias-port.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, ServerMessage, StateSnapshot } from "@henry/shared";
import { rmScratch, stopSessiond, waitFor } from "./sessiond-helper";
import { testShell } from "./shell";

const home = mkdtempSync(join(tmpdir(), "henry-alias-"));
const cwd = mkdtempSync(join(home, "cwd-"));
const daemonDir = join(import.meta.dir, "..");
const PORT_A = 48600 + Math.floor(Math.random() * 150);
const PORT_B = PORT_A + 150;

const daemons: ReturnType<typeof Bun.spawn>[] = [];

/** true once the port answers /api/state, undefined while it does not (for waitFor). */
async function answers(port: number): Promise<true | undefined> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/state`)).ok || undefined;
  } catch {
    return undefined;
  }
}

const silent = async (port: number): Promise<true | undefined> => ((await answers(port)) ? undefined : true);

async function startDaemon(port: number): Promise<ReturnType<typeof Bun.spawn>> {
  const proc = Bun.spawn(["bun", "src/index.ts", "start"], {
    cwd: daemonDir,
    env: { ...process.env, HENRY_HOME: home, HENRY_PORT: String(port), CLAUDE_CONFIG_DIR: join(home, "claude-config") },
    stdout: "pipe",
    stderr: "pipe",
  });
  daemons.push(proc);
  const drain = async (s: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
    for await (const chunk of s) if (process.env.HENRY_TEST_VERBOSE) to.write(chunk);
  };
  void drain(proc.stdout as ReadableStream<Uint8Array>, process.stdout);
  void drain(proc.stderr as ReadableStream<Uint8Array>, process.stderr);
  await waitFor(`daemon on ${port}`, () => answers(port), 15000);
  return proc;
}

/** A window, just long enough to say one thing and hear the answer. */
async function withWindow<T>(port: number, fn: (send: (m: ClientMessage) => void, inbox: ServerMessage[]) => Promise<T>): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox: ServerMessage[] = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)) as ServerMessage);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(e);
  });
  try {
    return await fn((m) => ws.send(JSON.stringify(m)), inbox);
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

const state = (port: number) => fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json()) as Promise<StateSnapshot>;

afterAll(async () => {
  for (const d of daemons) {
    try {
      d.kill();
      await d.exited;
    } catch {}
  }
  await stopSessiond(home);
  await rmScratch(home);
});

describe("a moved port still answers its live sessions", () => {
  let sessionId = "";

  test("a session starts against the port the daemon bound", async () => {
    await startDaemon(PORT_A);
    expect(readFileSync(join(home, "port"), "utf8").trim()).toBe(String(PORT_A));
    sessionId = await withWindow(PORT_A, async (send, inbox) => {
      send({ type: "session:create", cwd, title: "alias", command: testShell.command, args: testShell.args, requestId: "r1" });
      const created = await waitFor(
        "session:update",
        () => inbox.find((m) => m.type === "session:update" && m.requestId === "r1") as Extract<ServerMessage, { type: "session:update" }> | undefined,
      );
      expect(created.session.status).toBe("running");
      return created.session.id;
    });
    expect(sessionId).toBeTruthy();
  }, 30000);

  test("after the daemon moves, the old port comes back for it", async () => {
    daemons[0].kill();
    await daemons[0].exited;
    await waitFor("old daemon gone", () => silent(PORT_A));

    await startDaemon(PORT_B);
    // The session outlived the daemon in sessiond, so it is still running and still names A.
    const live = (await state(PORT_B)).sessions.find((s) => s.id === sessionId);
    expect(live?.status).toBe("running");
    expect(readFileSync(join(home, "port"), "utf8").trim()).toBe(String(PORT_B));

    await waitFor("alias on the old port", () => answers(PORT_A), 15000);
  }, 45000);

  test("the alias serves MCP, which is the whole point of holding it", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT_A}/mcp?as=session&session=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { result: { serverInfo: { name: string }; protocolVersion: string } };
    expect(body.result.serverInfo.name).toBe("henry");
    expect(body.result.protocolVersion).toBe("2025-03-26");
  });

  test("it closes once the last session naming it exits", async () => {
    await withWindow(PORT_B, async (send) => {
      send({ type: "session:kill", sessionId });
    });
    await waitFor("session exited", async () => ((await state(PORT_B)).sessions.find((s) => s.id === sessionId)?.status === "exited" ? true : undefined), 15000);
    await waitFor("alias closed", () => silent(PORT_A), 15000);
    // The daemon itself is untouched by the alias going away.
    expect(await answers(PORT_B)).toBe(true);
  }, 30000);
});
