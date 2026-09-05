// How a hook finds the daemon. A PTY outlives the daemon, so the HENRY_PORT baked into a
// session's environment goes stale when the daemon moves (4711 -> 14711 stranded live
// sessions on a dead port). The daemon publishes its bound port in <henry home>/port and the
// hook scripts read that first, falling back to $HENRY_PORT and then 14711.
// Run: bun test test/port.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch, stopSessiond, waitFor } from "./sessiond-helper";
import { isWindows } from "./shell";

const PORT = 48200 + Math.floor(Math.random() * 300);
const STUB_A = PORT + 1;
const STUB_B = PORT + 2;
const home = mkdtempSync(join(tmpdir(), "henry-port-"));
const daemonDir = join(import.meta.dir, "..");
const hooksDir = join(daemonDir, "hooks");

let daemon: ReturnType<typeof Bun.spawn>;

interface Hit {
  path: string;
  body: string;
}

/** A daemon stand-in: records what a hook posted and answers with its own name. */
function stub(port: number, name: string): { hits: Hit[]; stop: () => void } {
  const hits: Hit[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      hits.push({ path: new URL(req.url).pathname, body: await req.text() });
      return new Response(name);
    },
  });
  return { hits, stop: () => server.stop(true) };
}

const a = stub(STUB_A, "stub-a");
const b = stub(STUB_B, "stub-b");

/** A scratch Henry home, optionally holding a port file with `contents`. */
function scratchHome(name: string, contents?: string): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  if (contents !== undefined) writeFileSync(join(dir, "port"), contents);
  return dir;
}

/** Run the real hook (or statusline) script the way Claude Code would, and return its stdout. */
async function runHook(kind: "hook" | "statusline", env: Record<string, string | undefined>): Promise<string> {
  const script = join(hooksDir, isWindows ? `henry-${kind}.mjs` : `henry-${kind}.sh`);
  const cmd = isWindows ? ["node", script] : ["/bin/sh", script];
  if (kind === "hook") cmd.push("PreToolUse");
  // Built explicitly: the point of the test is which port the script picks, so this process's
  // own HENRY_* (bun test may itself be running inside a Henry session) may not leak in.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "HENRY_HOME" && k !== "HENRY_PORT") childEnv[k] = v;
  childEnv.HENRY_SESSION = "sess-1";
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  const child = Bun.spawn(cmd, {
    env: childEnv,
    stdin: Buffer.from('{"hello":"world"}'),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return out;
}

beforeAll(async () => {
  daemon = Bun.spawn(["bun", "src/index.ts", "start"], {
    cwd: daemonDir,
    env: { ...process.env, HENRY_HOME: home, HENRY_PORT: String(PORT), CLAUDE_CONFIG_DIR: join(home, "claude-config") },
    stdout: "pipe",
    stderr: "inherit",
  });
  void (async () => {
    for await (const chunk of daemon.stdout as ReadableStream<Uint8Array>) if (process.env.HENRY_TEST_VERBOSE) process.stdout.write(chunk);
  })();
  await waitFor("daemon http", async () => {
    try {
      return (await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok || undefined;
    } catch {
      return undefined;
    }
  });
});

afterAll(async () => {
  daemon?.kill();
  await daemon?.exited;
  await stopSessiond(home);
  a.stop();
  b.stop();
  await rmScratch(home);
});

describe("the daemon publishes its port", () => {
  test("<henry home>/port holds the bound port", () => {
    expect(readFileSync(join(home, "port"), "utf8").trim()).toBe(String(PORT));
  });
});

describe("hook port resolution", () => {
  test("the port file wins over a stale HENRY_PORT", async () => {
    const dir = scratchHome("file-wins", `${STUB_A}\n`);
    await runHook("hook", { HENRY_HOME: dir, HENRY_PORT: String(STUB_B) });
    const hit = await waitFor("stub a", () => a.hits.at(-1));
    expect(hit.path).toBe("/hook");
    expect(JSON.parse(hit.body)).toMatchObject({ henrySession: "sess-1", henryHookEvent: "PreToolUse", payload: { hello: "world" } });
    expect(b.hits).toHaveLength(0);
  });

  test("no port file falls back to HENRY_PORT", async () => {
    const dir = scratchHome("no-file");
    await runHook("hook", { HENRY_HOME: dir, HENRY_PORT: String(STUB_B) });
    const hit = await waitFor("stub b", () => b.hits.at(-1));
    expect(hit.path).toBe("/hook");
  });

  test("an unreadable or junk port file falls back to HENRY_PORT", async () => {
    for (const junk of ["", "  \n", "not-a-port", "14711 extra"]) {
      const before = b.hits.length;
      const dir = scratchHome(`junk-${before}`, junk);
      await runHook("hook", { HENRY_HOME: dir, HENRY_PORT: String(STUB_B) });
      await waitFor(`stub b after ${JSON.stringify(junk)}`, () => (b.hits.length > before ? true : undefined));
    }
  });

  test("with no HENRY_HOME the default home's port file is used", async () => {
    // The stale-session case: a session started before the port moved carries neither
    // HENRY_HOME nor a current HENRY_PORT, and still has to find the daemon.
    const fakeHome = join(home, "default-home");
    mkdirSync(join(fakeHome, ".henry"), { recursive: true });
    writeFileSync(join(fakeHome, ".henry", "port"), `${STUB_A}\n`);
    const before = a.hits.length;
    await runHook("hook", { HOME: fakeHome, USERPROFILE: fakeHome, HENRY_PORT: "4711" });
    await waitFor("stub a via default home", () => (a.hits.length > before ? true : undefined));
  });

  test("the statusline script reaches the same daemon and prints its answer", async () => {
    const dir = scratchHome("statusline", `${STUB_A}\n`);
    const out = await runHook("statusline", { HENRY_HOME: dir, HENRY_PORT: String(STUB_B) });
    expect(out.trim()).toBe("stub-a");
    expect(a.hits.at(-1)?.path).toBe("/statusline");
  });

  test("a dead daemon still costs the session nothing", async () => {
    // Nothing listens on the port file's port: the script must exit 0 and print nothing.
    const dir = scratchHome("dead", `${PORT + 3}\n`);
    expect(await runHook("statusline", { HENRY_HOME: dir })).toBe("");
    await runHook("hook", { HENRY_HOME: dir });
  });
});

describe("all four hook entry points stay in sync", () => {
  for (const script of ["henry-hook.sh", "henry-statusline.sh", "henry-hook.mjs", "henry-statusline.mjs"]) {
    test(script, () => {
      const text = readFileSync(join(hooksDir, script), "utf8");
      expect(text).toContain("HENRY_HOME");
      expect(text).toContain('port"');
      expect(text).toContain("HENRY_PORT");
      expect(text).toContain("14711");
    });
  }
});
