// Henry's MCP server: the JSON-RPC envelope, the two tool lists, and henry_activity over
// real git repos. Run: cd packages/daemon && bun test test/mcp.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, Session } from "@henry/shared";
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
type Attention = typeof import("../src/attention");
let mcp: Mcp;
let git: Git;
let db: Db;
let attention: Attention;

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

/** One JSON-RPC request against the handler, as a hosted session or as the wide client.
 * `session` is what launch-mcp.json puts in the URL: the caller naming itself. */
async function rpc(method: string, params?: Record<string, unknown>, as: "session" | "full" = "session", session?: string): Promise<any> {
  const url = new URL(`http://127.0.0.1/mcp${as === "session" ? "?as=session" : "?as=full"}${session === undefined ? "" : `&session=${encodeURIComponent(session)}`}`);
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
  attention = await import("../src/attention");
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
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-11-25");
  });

  test("a notification gets 202 and no body", async () => {
    const url = new URL("http://127.0.0.1/mcp?as=session");
    const res = await mcp.handleMcp(
      new Request(url.href, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }),
      url,
    );
    expect(res.status).toBe(202);
  });

  test("a hosted session sees the narrow list and nothing else", async () => {
    const r = await rpc("tools/list");
    expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual(["henry_activity", "henry_attention"]);
    // The definitions ride in every request's system prompt, so their size is part of the
    // contract: two tools, and adding a third has to be worth the same cost in every session.
    expect(JSON.stringify(r.result.tools).length).toBeLessThan(2200);
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

describe("how a session is given the server", () => {
  test("mcpServers stays out of launch-settings.json", async () => {
    // Claude Code ignores `mcpServers` in a --settings file (verified 2026-09-04 against the
    // CLI: the settings flag drew no connection, --mcp-config drew the full handshake). Putting
    // it there again would look right in the file and silently reach no session.
    const installer = await import("../src/installer");
    expect(installer.launchSettings().mcpServers).toBeUndefined();
    expect(installer.launchMcpConfig()).toHaveProperty("mcpServers.henry.type", "http");
    const url = (installer.launchMcpConfig() as any).mcpServers.henry.url as string;
    expect(url).toContain("/mcp?as=session");
    // How a call names its own session: Claude Code expands ${VAR} in an mcp config url
    // (verified 2026-09-04 against the CLI), and the `:-` default keeps a `claude` started
    // without HENRY_SESSION from failing to load the server at all.
    expect(url).toContain("session=${HENRY_SESSION:-}");
  });

  test("syncLaunchMcp writes the file when on and removes it when off", async () => {
    const installer = await import("../src/installer");
    const { config } = await import("../src/config");
    const path = join(home, "launch-mcp.json");

    config.mcp = { enabled: true, sessions: true };
    expect(installer.syncLaunchMcp(home)).toBe(path);
    expect(existsSync(path)).toBe(true);

    // Off has to remove it: the PATH shim decides by whether the file is there.
    config.mcp = { enabled: true, sessions: false };
    expect(installer.syncLaunchMcp(home)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    config.mcp = { enabled: true, sessions: true };
  });

  test("the PATH shim passes --mcp-config only when the file exists", async () => {
    const installer = await import("../src/installer");
    const bin = installer.writeLaunchBin(home);
    const shim = readFileSync(join(bin, "claude"), "utf8");
    expect(shim).toContain("--settings");
    expect(shim).toContain("--mcp-config");
    expect(shim).toContain('if [ -f "$self/../launch-mcp.json" ]');
    // --strict-mcp-config would drop the user's own servers; Henry adds to them.
    expect(shim).not.toContain("--strict-mcp-config");
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

describe("henry_attention", () => {
  const sent: ServerMessage[] = [];

  /** The tool as a session calls it. `session` is what launch-mcp.json puts in the URL. */
  const ask = async (args: Record<string, unknown>, session?: string): Promise<string> => {
    const r = await rpc("tools/call", { name: "henry_attention", arguments: args }, "session", session);
    return r.result.content[0].text as string;
  };

  beforeAll(() => {
    attention.setBroadcast((m) => sent.push(m));
    attention.setWindowCount(() => 2);
  });

  beforeEach(() => {
    for (const a of attention.open()) attention.finish(a.id, "withdrawn");
    sent.length = 0;
  });

  afterAll(() => {
    attention.stop();
    attention.setBroadcast(() => {});
  });

  test("an ask names the session that raised it and reaches the windows", async () => {
    const text = await ask({ message: "staging deploy window closes at 14:40 — confirm or I skip it", minutes: 10 }, "s1");
    const open = attention.open();
    expect(open).toHaveLength(1);
    expect(open[0]!.sessionId).toBe("s1");
    expect(open[0]!.message).toContain("staging deploy window");
    expect(text).toContain("asking the user");
    expect(text).toContain(open[0]!.id);
    // It says where it went: an ask nobody can see is worth knowing about.
    expect(text).toContain("all 2 open Henry windows");
    expect(sent).toEqual([{ type: "attention:update", attention: open[0]! }]);
  });

  test("the same words twice is a retry, not a second ask", async () => {
    await ask({ message: "same thing" }, "s1");
    const again = await ask({ message: "same thing" }, "s1");
    expect(attention.open()).toHaveLength(1);
    expect(again).toContain("already asking");
  });

  test("a session cannot pile up asks", async () => {
    for (const m of ["one", "two", "three"]) await ask({ message: m }, "s1");
    const fourth = await ask({ message: "four" }, "s1");
    expect(attention.open()).toHaveLength(3);
    expect(fourth).toContain("already 3 asks open");
  });

  test("a session withdraws its own ask and nobody else's", async () => {
    await ask({ message: "hold on" }, "s1");
    const id = attention.open()[0]!.id;

    fakeSessions.push(session({ id: "s2", cwd: other, title: "other" }));
    try {
      expect(await ask({ done: id }, "s2")).toContain("another session's ask");
      expect(attention.open()).toHaveLength(1);
    } finally {
      fakeSessions.pop();
    }

    expect(await ask({ done: id }, "s1")).toContain("withdrawn");
    expect(attention.open()).toHaveLength(0);
    expect(await ask({ done: id }, "s1")).toContain("was answered, withdrawn or timed out");
  });

  test("waiting returns the moment you show up, and says so", async () => {
    const pending = ask({ message: "approve the release?", wait: 30 }, "s1");
    await Bun.sleep(20);
    // What typing into the session (engagement.ts) or clicking the chip does.
    attention.answered("s1");
    expect(await pending).toContain("the user came to this session");
    expect(attention.open()).toHaveLength(0);
  });

  test("waiting gives up without dropping the ask", async () => {
    const text = await ask({ message: "still need you", wait: 0.05 }, "s1");
    expect(text).toContain("no sign of the user");
    expect(text).toContain("still up");
    expect(attention.open()).toHaveLength(1);
  });

  test("an unnamed caller is the only live Claude session, or nothing at all", async () => {
    // The URL carries `${HENRY_SESSION}` unexpanded, or a session Henry does not know.
    expect(await ask({ message: "who is this" }, "${HENRY_SESSION:-}")).not.toContain("could not tell");
    expect(attention.open()[0]!.sessionId).toBe("s1");

    fakeSessions.push(session({ id: "s2", cwd: other, title: "other" }));
    try {
      const text = await ask({ message: "two of us now" }, "nosuchsession");
      expect(text).toContain("could not tell which session");
      expect(attention.open().find((a) => a.message === "two of us now")!.sessionId).toBe("");
    } finally {
      fakeSessions.pop();
    }
  });

  test("an ask drops itself at its deadline", async () => {
    await ask({ message: "expiring", minutes: 1 }, "s1");
    const id = attention.open()[0]!.id;
    attention.sweep(Date.now() + 61_000);
    expect(attention.open()).toHaveLength(0);
    expect(sent.at(-1)).toMatchObject({ type: "attention:update", attention: { id, done: "expired" } });
  });

  test("a message is one line, and a blank one is refused", async () => {
    expect(await ask({ message: "   " }, "s1")).toContain("an ask needs a message");
    await ask({ message: "wrapped\nover\nlines " + "x".repeat(400) }, "s1");
    const a = attention.open()[0]!;
    expect(a.message).not.toContain("\n");
    expect(a.message.length).toBeLessThanOrEqual(200);
  });
});
