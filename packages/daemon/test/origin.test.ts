// A page on another site must not drive the daemon through loopback (origin.ts): no WebSocket,
// no text/plain POST, no DNS-rebound Host. Henry's own page and Origin-less local clients
// (hooks, CLI, MCP) still get in.
//
// Boots a daemon under a scratch HENRY_HOME on a random port; never touches ~/.henry or :14711.
// Run: bun test test/origin.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refusal } from "../src/origin";
import { rmScratch, stopSessiond, waitFor } from "./sessiond-helper";

const req = (headers: Record<string, string>) => new Request("http://127.0.0.1/", { headers });

describe("refusal", () => {
  test("loopback wants a loopback Host", () => {
    expect(refusal(req({ host: "127.0.0.1:14711" }), true, false)).toBeUndefined();
    expect(refusal(req({ host: "localhost:14711" }), true, false)).toBeUndefined();
    expect(refusal(req({ host: "[::1]:14711" }), true, false)).toBeUndefined();
    expect(refusal(req({ host: "henry.localhost:14711" }), true, false)).toBeUndefined();
    expect(refusal(req({ host: "localhost.:14711" }), true, false)).toBeUndefined();
    expect(refusal(req({ host: "localhost.evil.example" }), true, false)).toBe("foreign host");
    expect(refusal(req({ host: "rebind.evil.example:14711" }), true, false)).toBe("foreign host");
    expect(refusal(req({ host: "127.0.0.1.evil.example" }), true, false)).toBe("foreign host");
  });

  test("an Origin must be the listener's own", () => {
    expect(refusal(req({ host: "127.0.0.1:14711", origin: "http://127.0.0.1:14711" }), true, false)).toBeUndefined();
    // The Vite dev proxy passes its own Host through with the page's Origin.
    expect(refusal(req({ host: "127.0.0.1:14713", origin: "http://127.0.0.1:14713" }), true, false)).toBeUndefined();
    expect(refusal(req({ host: "127.0.0.1:14711", origin: "https://evil.example" }), true, false)).toBe("foreign origin");
    // Another local dev server is another site too.
    expect(refusal(req({ host: "127.0.0.1:14711", origin: "http://127.0.0.1:5173" }), true, false)).toBe("foreign origin");
    expect(refusal(req({ host: "127.0.0.1:14711", origin: "not a url" }), true, false)).toBe("foreign origin");
  });

  test("the phone listener takes any Host, but only its own Origin", () => {
    expect(refusal(req({ host: "100.95.0.1:14714", origin: "https://100.95.0.1:14714" }), false, false)).toBeUndefined();
    expect(refusal(req({ host: "100.95.0.1:14714" }), false, false)).toBeUndefined();
    expect(refusal(req({ host: "100.95.0.1:14714", origin: "https://evil.example" }), false, false)).toBe("foreign origin");
  });

  test("a sandboxed peek may load the files beside it, and nothing else", () => {
    expect(refusal(req({ host: "127.0.0.1:14711", origin: "null" }), true, true)).toBeUndefined();
    expect(refusal(req({ host: "127.0.0.1:14711", origin: "null" }), true, false)).toBe("sandboxed page");
  });
});

const home = mkdtempSync(join(tmpdir(), "henry-origin-"));
// Below the OS ephemeral range (49152 up) and clear of alias-port.test.ts's 48600-48899.
const PORT = 48900 + Math.floor(Math.random() * 250);
const base = `http://127.0.0.1:${PORT}`;
const SELF = base;
const EVIL = "https://evil.example";
let daemon: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
  daemon = Bun.spawn(["bun", "src/index.ts", "start"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, HENRY_NO_PUBLIC_LISTENERS: "1", HENRY_HOME: home, HENRY_PORT: String(PORT), CLAUDE_CONFIG_DIR: join(home, "claude-config") },
    stdout: process.env.HENRY_TEST_VERBOSE ? "inherit" : "ignore",
    stderr: process.env.HENRY_TEST_VERBOSE ? "inherit" : "ignore",
  });
  await waitFor(`daemon on ${PORT}`, async () => {
    try {
      return (await fetch(`${base}/api/state`)).ok || undefined;
    } catch {
      return undefined;
    }
  }, 15000);
});

afterAll(async () => {
  daemon?.kill();
  await daemon?.exited;
  await stopSessiond(home);
  await rmScratch(home);
});

/** Whether a WebSocket sent with this Origin is opened and handed the state. */
function wsGetsState(origin?: string): Promise<boolean> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, (origin ? { headers: { Origin: origin } } : {}) as never);
  return new Promise((res) => {
    const t = setTimeout(() => res(false), 5000);
    const done = (v: boolean) => {
      clearTimeout(t);
      try {
        ws.close();
      } catch {}
      res(v);
    };
    ws.onmessage = (e) => JSON.parse(String(e.data)).type === "state" && done(true);
    ws.onerror = () => done(false);
    ws.onclose = () => done(false);
  });
}

const plainPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", ...headers }, body: JSON.stringify(body) });

describe("the loopback listener", () => {
  test("a WebSocket from another site is refused; Henry's page and local clients get in", async () => {
    expect(await wsGetsState(EVIL)).toBe(false);
    expect(await wsGetsState(SELF)).toBe(true);
    expect(await wsGetsState()).toBe(true);
  });

  test("a text/plain POST from another site writes nothing", async () => {
    const target = join(home, "csrf.txt");
    const r = await plainPost("/api/file", { path: target, content: "x", create: true }, { Origin: EVIL });
    expect(r.status).toBe(403);
    expect(existsSync(target)).toBe(false);
    const own = await plainPost("/api/file", { path: target, content: "x", create: true }, { Origin: SELF });
    expect(own.status).toBe(200);
  });

  test("/mcp and /hook answer local clients, not other sites", async () => {
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await plainPost("/mcp", list, { Origin: EVIL })).status).toBe(403);
    expect((await plainPost("/mcp", list)).status).toBe(200);
    expect((await plainPost("/hook", { hook_event_name: "Noop" }, { Origin: EVIL })).status).toBe(403);
    expect((await plainPost("/hook", { hook_event_name: "Noop" })).status).toBe(200);
  });

  test("a DNS-rebound Host is refused", async () => {
    const r = await fetch(`${base}/api/state`, { headers: { Host: `rebind.evil.example:${PORT}` } });
    expect(r.status).toBe(403);
  });
});
