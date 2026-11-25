// Topics: membership, the context a member's prompt carries, suggestions, a coordinator's prompts
// to members, what a resumed session inherits, and the coordinator's own tool list.
// Run: cd packages/daemon && bun test test/topics.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, Session, Topic } from "@henry/shared";
import type { CreateOptions } from "../src/sessions";
import type { PeerTarget } from "../src/topics";
import { rmScratch } from "./sessiond-helper";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "henry-topics-test-")));
const home = join(tmp, "home");
mkdirSync(home, { recursive: true });
process.env.HENRY_HOME = home;
process.env.HENRY_PORT = "0";

type Topics = typeof import("../src/topics");
type Mcp = typeof import("../src/mcp");
type Hooks = typeof import("../src/hooks");
let topics: Topics;
let mcp: Mcp;
let hooks: Hooks;

let live: Session[] = [];
let written: { id: string; data: string }[] = [];
let killed: string[] = [];
let launched: CreateOptions[] = [];
let sent: ServerMessage[] = [];
let replies: Record<string, string> = {};
/** What each session's input shows unsent, and whether a key was pressed just now. */
let drafts: Record<string, string> = {};
let typing = false;

function session(id: string, extra: Partial<Session> = {}): Session {
  return { id, cwd: join(tmp, "code", "app"), title: id, createdAt: live.length, status: "running", kind: "claude", activity: "waiting", ...extra };
}

beforeAll(async () => {
  topics = await import("../src/topics");
  mcp = await import("../src/mcp");
  hooks = await import("../src/hooks");
  mcp.setSessionsForTests(() => live.filter((s) => s.status === "running"));
});

afterAll(() => rmScratch(tmp));

beforeEach(() => {
  live = [];
  written = [];
  killed = [];
  launched = [];
  sent = [];
  replies = {};
  drafts = {};
  typing = false;
  topics.setBroadcast((m) => sent.push(m));
  topics.setTimingForTests({ settleMs: 0, quietMs: 0, confirmMs: 0 });
  topics.setDepsForTests({
    list: () => live,
    setTopic: (id, topicId, coordinator) => {
      const s = live.find((x) => x.id === id);
      if (s) Object.assign(s, { topicId, coordinator: coordinator || undefined });
    },
    write: (id, data) => written.push({ id, data }),
    kill: (id) => killed.push(id),
    reply: (id) => replies[id],
    inputText: (id) => drafts[id] ?? "",
    typedSince: () => typing,
    create: async (opts) => {
      launched.push(opts);
      const s = session(`coord-${launched.length}`, { cwd: opts.cwd, title: opts.title ?? "", topicId: opts.topicId, coordinator: opts.coordinator });
      live.push(s);
      return s;
    },
  });
  for (const t of topics.list()) topics.close(t.id);
  topics.resetForTests();
});

async function topic(name: string, sessionId?: string) {
  const r = await topics.create(name, sessionId);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

describe("topics", () => {
  test("making a topic starts its coordinator with the coordinator's flags", async () => {
    live.push(session("a"));
    const t = await topic("auth migration", "a");
    expect(live.find((s) => s.id === "a")?.topicId).toBe(t.id);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.coordinator).toBe(true);
    expect(launched[0]!.topicId).toBe(t.id);
    expect(launched[0]!.cwd).toBe(topics.coordinatorDir());
    expect(launched[0]!.extraArgs).toContain("--append-system-prompt-file");
    expect(launched[0]!.extraArgs!.some((a) => a.startsWith("--disallowed-tools=") && a.includes("Read") && a.includes("Bash"))).toBe(true);
    expect(sent.some((m) => m.type === "topics:update")).toBe(true);
  });

  test("names are one line and unique, whatever the case", async () => {
    await topic("Voice");
    expect((await topics.create("  voice ")).ok).toBe(false);
    expect((await topics.create("")).ok).toBe(false);
    expect((await topics.create("x".repeat(topics.MAX_NAME + 1))).ok).toBe(false);
  });

  test("coordinators and a paired machine's sessions cannot be moved", async () => {
    live.push(session("far", { peer: "laptop" }));
    const t = await topic("t1");
    const coord = topics.coordinatorOf(t.id)!;
    const other = await topic("t2");
    expect(topics.join(coord.id, other.id).ok).toBe(false);
    expect(topics.join("far", t.id).ok).toBe(false);
  });

  test("a member's prompt carries the topic once per change, and the coordinator's never", async () => {
    live.push(session("a"), session("b", { title: "ui login", activity: "working" }));
    const t = await topic("auth", "a");
    topics.join("b", t.id);
    const first = topics.contextFor("a");
    expect(first).toContain('topic "auth"');
    expect(first).toContain('"ui login" (working)');
    expect(first).not.toContain("henry_fetch_file");
    expect(first).toContain("Brief: (none yet)");
    expect(topics.contextFor("a")).toBeUndefined();

    // Another member's activity is not news.
    live.find((s) => s.id === "b")!.activity = "waiting";
    expect(topics.contextFor("a")).toBeUndefined();

    topics.setBrief(t.id, "Rotate tokens on restart. b owns the UI.");
    expect(topics.contextFor("a")).toContain("Rotate tokens on restart.");
    topics.addNote(t.id, "churning packages/shared for an hour", 60);
    expect(topics.contextFor("a")).toContain("churning packages/shared");

    expect(topics.contextFor(topics.coordinatorOf(t.id)!.id)).toBeUndefined();
    topics.join("a", null);
    expect(topics.contextFor("a")).toBeUndefined();
  });

  test("the hook answers a prompt with Claude Code's additionalContext shape", () => {
    expect(hooks.hookOutput({})).toBeUndefined();
    expect(hooks.hookOutput({ context: "x" })).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "x" } });
  });

  test("the hook script prints the daemon's hook output and nothing else", async () => {
    let answer: unknown = { ok: true };
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(answer) });
    try {
      const script = process.platform === "win32" ? ["node", join(import.meta.dir, "../hooks/henry-hook.mjs")] : ["sh", join(import.meta.dir, "../hooks/henry-hook.sh")];
      // Not spawnSync: that would hold this process's event loop, and with it the stub server.
      const run = async () => {
        const p = Bun.spawn([...script, "UserPromptSubmit"], { stdin: Buffer.from('{"prompt":"hi"}'), stdout: "pipe", env: { ...process.env, HENRY_HOME: join(tmp, "no-daemon-here"), HENRY_PORT: String(srv.port) } });
        const out = await new Response(p.stdout).text();
        await p.exited;
        return out.trim();
      };
      expect(await run()).toBe("");
      answer = hooks.hookOutput({ context: "topic text" });
      expect(JSON.parse(await run())).toEqual(answer);
    } finally {
      srv.stop(true);
    }
  });

  test("notes expire, and a topic holds a dozen at most", async () => {
    const t = await topic("notes");
    const now = Date.now();
    topics.addNote(t.id, "short-lived", 1, now);
    expect(topics.notesOf(t.id, now + 30_000)).toHaveLength(1);
    expect(topics.notesOf(t.id, now + 61_000)).toHaveLength(0);
    for (let i = 0; i < topics.MAX_NOTES - 1; i++) expect(topics.addNote(t.id, `n${i}`).ok).toBe(true);
    expect(topics.addNote(t.id, "one too many", undefined, now).ok).toBe(false);
  });

  test("a suggestion shows until it is answered, and a dismissed one stays dismissed", async () => {
    live.push(session("loose"), session("shell", { kind: "shell" }));
    const t = await topic("sugg");
    expect(topics.suggest(t.id, "shell", "a terminal").ok).toBe(false);
    expect(topics.suggest(t.id, "loose", "same files").ok).toBe(true);
    expect(topics.list().find((x) => x.id === t.id)!.suggestions.map((s) => s.sessionId)).toEqual(["loose"]);
    expect(topics.answerSuggestion(t.id, "loose", false).ok).toBe(true);
    expect(topics.list().find((x) => x.id === t.id)!.suggestions).toHaveLength(0);
    expect(topics.suggest(t.id, "loose", "really").ok).toBe(false);

    live.push(session("other"));
    topics.suggest(t.id, "other", "also");
    expect(topics.answerSuggestion(t.id, "other", true).ok).toBe(true);
    expect(live.find((s) => s.id === "other")!.topicId).toBe(t.id);
    expect(topics.suggest(t.id, "other", "again").ok).toBe(false);
  });

  test("a coordinator's prompt is a draft unless sent, and waits for the turn to end", async () => {
    live.push(session("m", { title: "member" }), session("busy", { activity: "working" }), session("out"));
    const t = await topic("relay");
    topics.join("m", t.id);
    topics.join("busy", t.id);
    const coord = topics.coordinatorOf(t.id)!;

    const draft = await topics.prompt(coord.id, "m", "the endpoint\nmoved", false);
    expect(draft).toEqual({ ok: true, value: "drafted" });
    expect(written).toEqual([{ id: "m", data: '[from the "relay" coordinator; your reply goes back to it] the endpoint moved' }]);

    written = [];
    expect(await topics.prompt(coord.id, "m", "go", true)).toEqual({ ok: true, value: "sent" });
    await Bun.sleep(250);
    expect(written.map((w) => w.data)).toEqual(['[from the "relay" coordinator; your reply goes back to it] go', "\r"]);

    written = [];
    expect(await topics.prompt(coord.id, "busy", "later", true)).toEqual({ ok: true, value: "queued" });
    expect(written).toHaveLength(0);
    topics.flush("busy");
    expect(written).toHaveLength(0);
    live.find((s) => s.id === "busy")!.activity = "needsInput";
    topics.flush("busy");
    expect(written).toHaveLength(0);
    live.find((s) => s.id === "busy")!.activity = "waiting";
    topics.flush("busy");
    expect(written[0]?.data).toContain("later");

    expect((await topics.prompt(coord.id, "out", "not a member", false)).ok).toBe(false);
    expect((await topics.prompt("m", "busy", "members cannot", false)).ok).toBe(false);
  });

  test("nothing is typed the instant a turn ends, and an Enter that starts no turn is pressed again", async () => {
    topics.setTimingForTests({ quietMs: 200, confirmMs: 400 });
    try {
      live.push(session("q", { title: "member", activity: "working" }));
      const t = await topic("quiet");
      topics.join("q", t.id);
      const coord = topics.coordinatorOf(t.id)!;
      const typed = () => written.filter((w) => w.id === "q").map((w) => w.data);
      expect(await topics.prompt(coord.id, "q", "go", true)).toEqual({ ok: true, value: "queued" });

      // Its Stop hooks may still be running: the prompt waits for the turn to have been over a while.
      const q = live.find((s) => s.id === "q")!;
      Object.assign(q, { activity: "waiting", activitySince: Date.now() });
      topics.flush("q");
      expect(typed()).toEqual([]);
      await Bun.sleep(300);
      expect(typed()).toEqual(['[from the "quiet" coordinator; your reply goes back to it] go']);
      await Bun.sleep(200);
      expect(typed()).toHaveLength(2);
      // That Enter started nothing, so it is pressed again; once a turn starts, no more.
      await Bun.sleep(300);
      expect(typed()).toEqual(['[from the "quiet" coordinator; your reply goes back to it] go', "\r", "\r"]);
      Object.assign(q, { activity: "working", activitySince: Date.now() });
      await Bun.sleep(500);
      expect(typed()).toHaveLength(3);
    } finally {
      topics.setTimingForTests({ quietMs: 0, confirmMs: 0 });
    }
  });

  test("nothing is typed over a draft of yours; it goes in once the input is empty", async () => {
    drafts.d = "half a thought";
    topics.setTimingForTests({ draftRecheckMs: 50 });
    try {
      live.push(session("d", { title: "member" }));
      const t = await topic("drafts");
      topics.join("d", t.id);
      const coord = topics.coordinatorOf(t.id)!;
      const typed = () => written.filter((w) => w.id === "d").map((w) => w.data);
      expect(await topics.prompt(coord.id, "d", "go", false)).toEqual({ ok: true, value: "queued" });
      await Bun.sleep(150);
      expect(typed()).toEqual([]);
      drafts.d = "";
      await Bun.sleep(150);
      expect(typed()).toEqual(['[from the "drafts" coordinator; your reply goes back to it] go']);
    } finally {
      topics.setTimingForTests({ draftRecheckMs: 2_000 });
    }
  });

  test("a key pressed just now holds a delivery even before the screen shows it", async () => {
    typing = true;
    topics.setTimingForTests({ draftRecheckMs: 50 });
    try {
      live.push(session("k", { title: "member" }));
      const t = await topic("keys");
      topics.join("k", t.id);
      const coord = topics.coordinatorOf(t.id)!;
      expect(await topics.prompt(coord.id, "k", "go", false)).toEqual({ ok: true, value: "queued" });
      typing = false;
      await Bun.sleep(150);
      expect(written.filter((w) => w.id === "k")).toHaveLength(1);
    } finally {
      topics.setTimingForTests({ draftRecheckMs: 2_000 });
    }
  });

  test("a turn the coordinator started answers back into the coordinator; the user's own turns do not", async () => {
    live.push(session("m", { title: "member" }));
    const t = await topic("talk");
    topics.join("m", t.id);
    const coord = topics.coordinatorOf(t.id)!;
    coord.activity = "waiting";
    replies.m = "Done: the endpoint moved to /v2.\nTests pass.";

    // The user typed this one: nothing goes back.
    topics.onPrompt("m", "fix the flaky test");
    expect(await topics.onStop("m")).toBeUndefined();

    written = [];
    topics.onPrompt("m", '[from the "talk" coordinator; your reply goes back to it] move the endpoint');
    expect(await topics.onStop("m")).toBe("sent");
    await Bun.sleep(250);
    // Only the coordinator's: the test before this one may still have an Enter on its timer.
    expect(written.filter((w) => w.id === coord.id)).toEqual([
      { id: coord.id, data: '[reply from "member" [m] to your prompt] Done: the endpoint moved to /v2. Tests pass.' },
      { id: coord.id, data: "\r" },
    ]);
    // One reply per turn the coordinator started.
    expect(await topics.onStop("m")).toBeUndefined();

    // A coordinator mid-turn gets it when its turn ends.
    written = [];
    coord.activity = "working";
    topics.onPrompt("m", '[from the "talk" coordinator] an older draft the user sent');
    expect(await topics.onStop("m")).toBe("queued");
    expect(written).toHaveLength(0);
    coord.activity = "waiting";
    topics.flush(coord.id);
    expect(written[0]?.data).toContain("[reply from \"member\"");
  });

  test("past the hourly cap a topic's replies go in as drafts", async () => {
    live.push(session("m", { title: "member" }));
    const t = await topic("loop");
    topics.join("m", t.id);
    topics.coordinatorOf(t.id)!.activity = "waiting";
    replies.m = "again";
    const outcomes: (string | undefined)[] = [];
    for (let i = 0; i <= topics.REPLIES_PER_HOUR; i++) {
      topics.onPrompt("m", '[from the "loop" coordinator; your reply goes back to it] go on');
      outcomes.push(await topics.onStop("m"));
    }
    expect(outcomes.filter((o) => o === "sent")).toHaveLength(topics.REPLIES_PER_HOUR);
    expect(outcomes.at(-1)).toBe("drafted");
  });

  test("a resumed coordinator coordinates again; a fork is only a member", async () => {
    const t = await topic("inherit");
    const coord = topics.coordinatorOf(t.id)!;
    expect(topics.inherit({ topicId: t.id }, false)).toEqual({ topicId: t.id });
    expect(topics.inherit({ topicId: t.id, coordinator: true }, true)).toEqual({});
    coord.status = "exited";
    const again = topics.inherit({ topicId: t.id, coordinator: true }, true);
    expect(again.coordinator).toBe(true);
    expect(again.extraArgs).toContain("--append-system-prompt-file");
    expect(topics.inherit({ topicId: t.id, coordinator: true }, false)).toEqual({});
    topics.close(t.id);
    expect(topics.inherit({ topicId: t.id }, true)).toEqual({});
  });

  test("closing a topic stops its coordinator and leaves its sessions in no topic", async () => {
    live.push(session("a"));
    const t = await topic("closing", "a");
    const coord = topics.coordinatorOf(t.id)!;
    expect(topics.close(t.id).ok).toBe(true);
    expect(killed).toEqual([coord.id]);
    expect(live.find((s) => s.id === "a")!.topicId).toBeUndefined();
    expect(topics.list().some((x) => x.id === t.id)).toBe(false);
  });

  test("a topic survives a daemon restart", async () => {
    const t = await topic("durable");
    topics.setBrief(t.id, "kept");
    topics.addNote(t.id, "still here");
    topics.resetForTests();
    const back = topics.list().find((x) => x.id === t.id);
    expect(back?.brief).toBe("kept");
    expect(back?.notes.map((n) => n.text)).toEqual(["still here"]);
  });
});

describe("a topic across machines", () => {
  type Call = { to: PeerTarget; method: string; path: string; body?: unknown };
  let far: Session[];
  let calls: Call[];
  let joins: { sessionId: string; topicId: string | null }[];
  let answer: (c: Call) => Response;
  const farTopic: Topic = { id: "far-topic", name: "shared", peer: "laptop", brief: "Ship v2 together.", notes: [{ id: "n1", text: "laptop owns the API", ts: Date.now() }], suggestions: [], createdAt: 0, updatedAt: 0 };

  beforeEach(() => {
    far = [];
    calls = [];
    joins = [];
    answer = () => Response.json({ outcome: "sent" });
    topics.setDepsForTests({
      list: () => live,
      setTopic: (id, topicId, coordinator) => {
        const s = live.find((x) => x.id === id);
        if (s) Object.assign(s, { topicId, coordinator: coordinator || undefined });
      },
      write: (id, data) => written.push({ id, data }),
      kill: (id) => killed.push(id),
      reply: (id) => replies[id],
      create: async (opts) => {
        launched.push(opts);
        const s = session(`coord-${launched.length}`, { cwd: opts.cwd, title: opts.title ?? "", topicId: opts.topicId, coordinator: opts.coordinator });
        live.push(s);
        return s;
      },
      peerSessions: () => far,
      peerTopic: (id) => (id === farTopic.id ? farTopic : undefined),
      peerHttp: (to, method, path, body) => {
        const c = { to, method, path, body };
        calls.push(c);
        return Promise.resolve(answer(c));
      },
      peerJoin: (sessionId, topicId) => {
        joins.push({ sessionId, topicId });
        return true;
      },
    });
  });

  test("a session here joins a peer's topic and its prompts carry that topic's brief", () => {
    live.push(session("a"));
    far.push(session("api", { peer: "laptop", title: "api work", topicId: farTopic.id, activity: "working" }));
    expect(topics.join("a", "no-such-topic").ok).toBe(false);
    expect(topics.join("a", farTopic.id).ok).toBe(true);
    const text = topics.contextFor("a")!;
    expect(text).toContain('topic "shared"');
    expect(text).toContain("its coordinator runs on laptop");
    expect(text).toContain("Ship v2 together.");
    expect(text).toContain("laptop owns the API");
    expect(text).toContain('"api work" on laptop (working)');
    expect(text).toContain("henry_fetch_file");
    expect(topics.inherit({ topicId: farTopic.id }, true)).toEqual({ topicId: farTopic.id });
    expect(topics.inherit({ topicId: farTopic.id, coordinator: true }, true)).toEqual({});
  });

  test("a coordinator here prompts a member on a peer through that machine", async () => {
    const t = await topic("spread");
    const coord = topics.coordinatorOf(t.id)!;
    far.push(session("remote", { peer: "laptop", title: "remote member", topicId: t.id }));
    expect(topics.membersOf(t.id).map((s) => s.id)).toEqual(["remote"]);
    expect(await topics.prompt(coord.id, "remote", "rebase\nplease", true)).toEqual({ ok: true, value: "sent" });
    expect(calls).toEqual([{ to: { session: "remote" }, method: "POST", path: "/api/topic/deliver", body: { topicId: t.id, sessionId: "remote", text: '[from the "spread" coordinator; your reply goes back to it] rebase please', send: true } }]);
    expect(written).toHaveLength(0);

    answer = () => Response.json({ error: "that session is not in this topic" }, { status: 409 });
    const refused = await topics.prompt(coord.id, "remote", "again", false);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toContain("laptop: that session is not in this topic");
  });

  test("a peer's coordinator reaches only its own members here, and only with its label", () => {
    live.push(session("m", { topicId: farTopic.id }), session("other"));
    const label = '[from the "shared" coordinator; your reply goes back to it] ';
    expect(topics.deliverFromPeer(farTopic.id, "other", label + "hi", false).ok).toBe(false);
    expect(topics.deliverFromPeer(farTopic.id, "m", "unlabelled", false).ok).toBe(false);
    expect(topics.deliverFromPeer(farTopic.id, "m", label + "hi", false)).toEqual({ ok: true, value: "drafted" });
    expect(written).toEqual([{ id: "m", data: label + "hi" }]);
  });

  test("a member here answers a peer's coordinator over the link", async () => {
    live.push(session("m", { topicId: farTopic.id }));
    replies.m = "Rebased onto main.";
    topics.onPrompt("m", '[from the "shared" coordinator; your reply goes back to it] rebase');
    expect(await topics.onStop("m")).toBe("sent");
    expect(calls).toEqual([{ to: { topic: farTopic.id }, method: "POST", path: "/api/topic/reply", body: { topicId: farTopic.id, sessionId: "m", text: "Rebased onto main." } }]);
  });

  test("a peer member's reply reaches the coordinator here, named as this machine sees it", async () => {
    const t = await topic("answers");
    const coord = topics.coordinatorOf(t.id)!;
    far.push(session("remote", { peer: "laptop", title: "remote member", topicId: t.id }));
    expect(topics.replyFromPeer(t.id, "stranger", "hi").ok).toBe(false);
    expect(topics.replyFromPeer(t.id, "remote", "done\nall green")).toEqual({ ok: true, value: "sent" });
    expect(written[0]).toEqual({ id: coord.id, data: '[reply from "remote member" on laptop [remote] to your prompt] done all green' });
  });

  test("closing a topic takes its members on peers out too", async () => {
    const t = await topic("ending");
    far.push(session("remote", { peer: "laptop", topicId: t.id }), session("elsewhere", { peer: "laptop" }));
    topics.close(t.id);
    expect(joins).toEqual([{ sessionId: "remote", topicId: null }]);
  });

  test("henry_topic reads a peer's members from their own machine", async () => {
    const t = await topic("wide");
    const coord = topics.coordinatorOf(t.id)!;
    far.push(session("remote", { peer: "laptop", title: "remote member", topicId: t.id }));
    answer = () => Response.json({ lines: ['"remote member" [remote] waiting', '  asked 2m ago: "split the parser"'], reply: "split done" });
    const url = new URL(`http://127.0.0.1/mcp?as=session&session=${coord.id}`);
    const call = async (name: string, args: Record<string, unknown>) => {
      const req = new Request(url.toString(), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      return ((await (await mcp.handleMcp(req, url)).json()) as { result: { content: { text: string }[] } }).result.content[0]!.text;
    };
    const view = await call("henry_topic", {});
    expect(view).toContain('"remote member" [remote]');
    expect(view).toContain("on laptop");
    expect(view).toContain('asked 2m ago: "split the parser"');
    expect(calls[0]!.path).toBe("/api/topic/member?session=remote&prompts=1");
    expect(await call("henry_session", { session: "remote member" })).toContain('last reply: "split done"');
    expect(await call("henry_membership", { session: "remote member", action: "remove" })).toContain("asked laptop");
    expect(joins).toEqual([{ sessionId: "remote", topicId: null }]);
  });
});

describe("the coordinator's tools", () => {
  async function rpc(sessionId: string, method: string, params?: Record<string, unknown>) {
    const url = new URL(`http://127.0.0.1/mcp?as=session&session=${sessionId}`);
    const req = new Request(url.toString(), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return (await (await mcp.handleMcp(req, url)).json()) as { result: { tools?: { name: string }[]; content?: { text: string }[] } };
  }

  test("only a coordinator is served them", async () => {
    live.push(session("plain"));
    const t = await topic("tools");
    const coord = topics.coordinatorOf(t.id)!;
    const plain = (await rpc("plain", "tools/list")).result.tools!.map((x) => x.name);
    expect(plain).toEqual(["henry_activity", "henry_attention", "henry_sessions", "henry_message"]);
    const mine = (await rpc(coord.id, "tools/list")).result.tools!.map((x) => x.name);
    expect(mine).toEqual(["henry_activity", "henry_attention", "henry_topic", "henry_session", "henry_brief", "henry_membership", "henry_prompt"]);
    const refused = await rpc("plain", "tools/call", { name: "henry_topic", arguments: {} });
    expect(JSON.stringify(refused)).toContain("unknown tool");
  });

  test("henry_topic reads the brief, the members and the loose sessions; henry_brief writes", async () => {
    live.push(session("m1", { title: "daemon tokens" }), session("l1", { title: "docs pass" }));
    const t = await topic("view", "m1");
    const coord = topics.coordinatorOf(t.id)!;
    const call = async (name: string, args: Record<string, unknown>) => (await rpc(coord.id, "tools/call", { name, arguments: args })).result.content![0]!.text;

    expect(await call("henry_brief", { brief: "Ship rotation.", note: "freeze main", minutes: 30 })).toContain("brief saved");
    const view = await call("henry_topic", {});
    expect(view).toContain('You coordinate the topic "view"');
    expect(view).toContain("Ship rotation.");
    expect(view).toContain("freeze main");
    expect(view).toContain('"daemon tokens" [m1]');
    expect(view).toContain("In no topic (1)");
    expect(view).toContain('"docs pass"');

    expect(await call("henry_membership", { session: "docs pass", action: "suggest", reason: "same repo" })).toContain("suggested");
    expect(await call("henry_membership", { session: "docs pass", action: "add" })).toContain('is in "view" now');
    expect(await call("henry_prompt", { session: "docs pass", text: "hello" })).toContain("unsent");
  });
});
