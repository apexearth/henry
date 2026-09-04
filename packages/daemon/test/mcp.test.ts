// Henry's MCP server: the JSON-RPC envelope, the two tool lists, and henry_activity over
// real git repos. Run: cd packages/daemon && bun test test/mcp.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@henry/shared";
import { rmScratch, stopSessiond } from "./sessiond-helper";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "henry-mcp-test-")));
const home = join(tmp, "home");
const root = join(tmp, "code");
const repo = join(root, "app");
const other = join(root, "lib");
mkdirSync(home, { recursive: true });
mkdirSync(root, { recursive: true });
process.env.HENRY_HOME = home;
process.env.HENRY_PORT = "0";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function g(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

type Mcp = typeof import("../src/mcp");
type Git = typeof import("../src/git");
type Db = typeof import("../src/db");
let mcp: Mcp;
let git: Git;
let db: Db;

/** A PreToolUse write, the record Henry uses to say which session is editing which file. */
function wrote(sessionId: string, cwd: string, filePath: string): void {
  db.insertEvent({
    id: crypto.randomUUID(),
    sessionId,
    ts: Date.now(),
    kind: "hook",
    hookEvent: "PreToolUse",
    toolName: "Edit",
    cwd,
    payload: { tool_input: { file_path: filePath } },
    severity: "info",
    summary: `Edit ${filePath}`,
  });
}

const fakeSessions: Session[] = [];
const session = (over: Partial<Session> & { id: string; cwd: string }): Session => ({
  title: over.id,
  createdAt: Date.now() - 60_000,
  status: "running",
  kind: "claude",
  ...over,
});

/** One JSON-RPC request against the handler, as a hosted session or as the wide client. */
async function rpc(method: string, params?: Record<string, unknown>, as: "session" | "full" = "session"): Promise<any> {
  const url = new URL(`http://127.0.0.1/mcp${as === "session" ? "?as=session" : ""}`);
  const res = await mcp.handleMcp(new Request(url.href, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), url);
  return res.status === 202 ? undefined : await res.json();
}

const callActivity = async (repoArg?: string): Promise<string> => {
  mcp.resetCacheForTests();
  const r = await rpc("tools/call", { name: "henry_activity", arguments: repoArg ? { repo: repoArg } : {} });
  return r.result.content[0].text as string;
};

beforeAll(async () => {
  g(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");
  g(root, "init", "-q", "-b", "main", other);
  writeFileSync(join(other, "c.txt"), "c\n");
  g(other, "add", ".");
  g(other, "commit", "-q", "-m", "init");

  const { config } = await import("../src/config");
  config.reposRoot = root;
  git = await import("../src/git");
  db = await import("../src/db");
  mcp = await import("../src/mcp");
  mcp.setSessionsForTests(() => fakeSessions);
});

afterAll(async () => {
  mcp?.setSessionsForTests(null);
  git?.stop();
  await stopSessiond(home);
  await rmScratch(tmp);
});

describe("mcp envelope", () => {
  test("initialize echoes a supported protocol version and advertises tools", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-03-26" });
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toBe("henry");
    // An unknown version falls back to ours rather than failing the handshake.
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-06-18");
  });

  test("a notification gets 202 and no body", async () => {
    const url = new URL("http://127.0.0.1/mcp?as=session");
    const res = await mcp.handleMcp(
      new Request(url.href, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }),
      url,
    );
    expect(res.status).toBe(202);
  });

  test("a hosted session sees exactly one tool", async () => {
    const r = await rpc("tools/list");
    expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual(["henry_activity"]);
    // The definition rides in every request's system prompt, so its size is part of the contract.
    expect(JSON.stringify(r.result.tools).length).toBeLessThan(900);
  });

  test("unknown methods and tools fail without throwing", async () => {
    expect((await rpc("tools/nope")).error.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "henry_write" })).error.code).toBe(-32602);
  });

  test("a batch is answered as a batch", async () => {
    const url = new URL("http://127.0.0.1/mcp?as=session");
    const body = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    const out = (await (await mcp.handleMcp(new Request(url.href, { method: "POST", body }), url)).json()) as unknown[];
    expect(out).toHaveLength(2);
  });
});

describe("henry_activity", () => {
  test("no live session in a repo says so", async () => {
    expect(await callActivity()).toContain("No live session");
  });

  test("an unknown repo name is reported, not thrown", async () => {
    expect(await callActivity("nosuchrepo")).toContain("nosuchrepo");
  });

  test("reports what another session is editing, its state, and recent commits", async () => {
    git.noteSessionPath("s1", join(repo, "a.txt"));
    await Bun.sleep(200); // noteSessionPath records the baseline off the event loop
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "new.txt"), "fresh\n");
    wrote("s1", repo, join(repo, "a.txt"));
    fakeSessions.push(session({ id: "s1", cwd: repo, title: "rail fix", activity: "working", activitySince: Date.now() - 120_000 }));

    const text = await callActivity("app");
    expect(text).toContain("app");
    expect(text).toContain("main");
    expect(text).toContain('"rail fix" working 2m');
    expect(text).toContain("editing: a.txt (M");
    // Dirty but with no write on record: reported, and not pinned on the session.
    expect(text).toContain("not traced to a live session: new.txt (?");
    expect(text).not.toContain("b.txt"); // untouched and clean
    expect(text).toContain('"init"'); // recent commits
  });

  test("a dirty repo with nobody in it reports the files and says so", async () => {
    writeFileSync(join(other, "c.txt"), "c changed\n");
    const text = await callActivity(other);
    expect(text).toContain("live here: none");
    expect(text).toContain("not traced to a live session: c.txt (M");
  });

  test("a write by another session is not attributed to this one", async () => {
    wrote("s2", repo, join(repo, "new.txt"));
    const text = await callActivity("app");
    // s2 is not live, so its file stays out of s1's line.
    expect(text).toContain("editing: a.txt (M");
    expect(text).not.toContain("editing: new.txt");
  });

  test("a parked session reads as parked, so its files are not mistaken for in-flight", async () => {
    fakeSessions[0].activity = "waiting";
    fakeSessions[0].activitySince = Date.now() - 45 * 60_000;
    expect(await callActivity("app")).toContain("waiting on the human 45m");
  });

  test("with no repo argument, every repo a live session is in is covered", async () => {
    const text = await callActivity();
    expect(text).toContain("app");
    expect(text).not.toContain("live here: none"); // `lib` has no session, so it is not listed
  });

  test("the answer stays small enough to read mid-task", async () => {
    const text = await callActivity("app");
    expect(text.split("\n").length).toBeLessThan(16);
  });
});
