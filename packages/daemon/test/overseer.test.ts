// bun test — overseer with a fake backend. HENRY_HOME points at a scratch dir so the real
// ~/.henry is never touched; no server is started and no port is used.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Flag, HenryEvent, PlaybookEntry, RepoState, ServerMessage, Session } from "@henry/shared";

const home = mkdtempSync(join(tmpdir(), "henry-overseer-test-"));
process.env.HENRY_HOME = home;
delete process.env.HENRY_PORT;

const overseer = await import("../src/overseer");
const db = await import("../src/db");
type BackendRequest = import("../src/overseer").BackendRequest;

afterAll(() => rmSync(home, { recursive: true, force: true }));

// ---- fixtures ----

const SECRET_SOURCE = "function SUPER_SECRET_FUNCTION_BODY() { return 42; }";
const PAYLOAD_CODE = "const PAYLOAD_ONLY_TOKEN = 'never-in-prompt';";

function makeSession(title = "off-chain"): Session {
  const cwd = mkdtempSync(join(home, "cwd-"));
  mkdirSync(join(cwd, ".git"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "secret.ts"), SECRET_SOURCE);
  writeFileSync(join(cwd, "ACTIVE-WORK.md"), ["# Active work", "", "- Ship the overseer (ACTIVE_WORK_MARKER_LINE)", ...Array.from({ length: 120 }, (_, i) => `- filler line ${i}`)].join("\n"));
  const s: Session = { id: crypto.randomUUID(), cwd, title, createdAt: Date.now() - 60_000, status: "running", command: "claude" };
  db.insertSession(s);
  return s;
}

function addEvent(sessionId: string, i: number, extra: Partial<HenryEvent> = {}): HenryEvent {
  const e: HenryEvent = {
    id: crypto.randomUUID(), sessionId, ts: Date.now() - 10_000 + i, kind: "hook", hookEvent: "PostToolUse", toolName: "Edit",
    payload: { tool_input: { new_string: PAYLOAD_CODE } }, severity: "info", summary: `Edit src/file${i}.ts (EVENT_MARKER_${i})`, ...extra,
  };
  db.insertEvent(e);
  return e;
}

function addFlag(sessionId: string, summary: string, severity: Flag["severity"] = "alarm"): Flag {
  const ev = addEvent(sessionId, 999, { toolName: "Bash", severity, summary });
  const f: Flag = { id: crypto.randomUUID(), eventId: ev.id, sessionId, ts: Date.now(), severity, rule: "alarm:git push --force", summary, read: false };
  db.insertFlag(f);
  return f;
}

const repo: RepoState = {
  path: "/tmp/fake/off-chain", name: "off-chain", branch: "feat/overseer", head: "deadbeef", upstream: "origin/feat/overseer",
  ahead: 2, behind: 0, dirty: 3, isWorktree: false, baseline: "0123456789abcdef", commitsSinceBaseline: 2,
};

let calls: BackendRequest[] = [];
let broadcasts: ServerMessage[] = [];
const reply = (entry: string, now = "Right now the session is mid-task.") => `ENTRY:\n${entry}\nNOW:\n${now}`;

beforeEach(async () => {
  await overseer.idle();
  overseer.resetForTests();
  calls = [];
  broadcasts = [];
  overseer.setBroadcastForTests((m) => broadcasts.push(m));
  overseer.setGitForTests({
    getSessionRepos: () => [repo],
    // Same shape as git.logSinceBaseline (milestone 3).
    logSinceBaseline: async () => ({ baseline: "0123456789abcdef", commits: [{ sha: "a1b2c3d", ts: Date.now(), subject: "Add overseer prompt builder (COMMIT_MARKER)" }, { sha: "e4f5a6b", ts: Date.now(), subject: "Wire playbook endpoints" }] }),
  });
  overseer.setTimingForTests({ stopDebounceMs: 30, globalIntervalMs: Infinity, timeoutMs: 5_000, promptChars: 22_000 });
  overseer.setBackendForTests(async (req) => {
    calls.push(req);
    return reply(`Entry ${calls.length}.`);
  });
});

// ---- tests ----

describe("prompt assembly", () => {
  test("includes events, flags, git summary and ACTIVE-WORK head; excludes source and payloads", async () => {
    const s = makeSession();
    for (let i = 0; i < 5; i++) addEvent(s.id, i);
    addFlag(s.id, "git push --force origin main (FLAG_MARKER)");

    const entry = await overseer.writeManual(s.id, "what is going on? (QUESTION_MARKER)");
    expect(entry?.text).toBe("Entry 1.");
    expect(calls).toHaveLength(1);
    const { system, user } = calls[0];

    expect(system).toBe(overseer.SYSTEM_PROMPT);
    expect(system).toContain("never see source code or diffs");
    for (let i = 0; i < 5; i++) expect(user).toContain(`EVENT_MARKER_${i}`);
    expect(user).toContain("FLAG_MARKER");
    expect(user).toContain("[alarm]");
    expect(user).toContain("feat/overseer");
    expect(user).toContain("ahead 2 / behind 0");
    expect(user).toContain("COMMIT_MARKER");
    expect(user).toContain("ACTIVE_WORK_MARKER_LINE");
    expect(user).toContain("filler line 76"); // line 80 of the file
    expect(user).not.toContain("filler line 77"); // beyond the 80-line head
    expect(user).toContain("QUESTION_MARKER");
    expect(user).toContain(`Session: "off-chain"`);

    expect(user).not.toContain("SUPER_SECRET_FUNCTION_BODY");
    expect(user).not.toContain("PAYLOAD_ONLY_TOKEN");
    expect(user).not.toContain("secret.ts");
    expect(user.length).toBeLessThan(24_000);
  });

  test("keeps the prompt under budget by dropping the oldest events first", async () => {
    const s = makeSession("busy");
    for (let i = 0; i < 40; i++) addEvent(s.id, i, { summary: `EV_${i} ` + "x".repeat(900) });
    overseer.setTimingForTests({ promptChars: 8_000 }); // event lines are capped at ~200 chars, so shrink the budget to force truncation
    await overseer.writeManual(s.id, "?");
    const user = calls[0].user;
    expect(user.length).toBeLessThan(8_000);
    expect(user).toContain("EV_39"); // newest survives
    expect(user).not.toContain("EV_0 "); // oldest dropped
    expect(user).toMatch(/Recent events \(oldest first; \d+ of the last 40\)/);
  });

  test("feeds the previous entries and summary back for continuity", async () => {
    const s = makeSession();
    await overseer.writeManual(s.id, "first");
    await overseer.writeManual(s.id, "second");
    const user = calls[1].user;
    expect(user).toContain("Entry 1.");
    expect(user).toContain('Previous "right now" summary: Right now the session is mid-task.');
  });
});

describe("persistence and broadcast", () => {
  test("writes an entry and a summary row and broadcasts both", async () => {
    const s = makeSession();
    const entry = await overseer.writeManual(s.id, "status?");
    expect(entry).toBeDefined();
    const rows = db.listPlaybook(s.id);
    expect(rows).toHaveLength(2);
    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(["entry", "summary"]);
    const summary = rows.find((r) => r.kind === "summary")!;
    expect(summary.text).toBe("Right now the session is mid-task.");
    expect(summary.trigger).toBe("manual");
    expect(rows.find((r) => r.kind === "entry")!.model).toBe(overseer.overseerStatus().model);

    const updates = broadcasts.filter((m): m is Extract<ServerMessage, { type: "playbook:update" }> => m.type === "playbook:update");
    expect(updates.map((u) => u.entry.kind).sort()).toEqual(["entry", "summary"]);
    expect(overseer.overseerStatus().lastRunAt).toBeGreaterThan(0);
    expect(overseer.overseerStatus().lastError).toBeUndefined();
  });

  test("latestSummary returns the newest summary; entries accumulate", async () => {
    const s = makeSession();
    overseer.setBackendForTests(async () => reply("E1", "NOW one"));
    await overseer.writeManual(s.id, "a");
    overseer.setBackendForTests(async () => reply("E2", "NOW two"));
    await overseer.writeManual(s.id, "b");
    expect(overseer.latestSummary(s.id)?.text).toBe("NOW two");
    expect(db.listPlaybook(s.id).filter((p) => p.kind === "entry")).toHaveLength(2);
    expect(db.listPlaybook(s.id).filter((p) => p.kind === "summary")).toHaveLength(2);
  });

  test("a flag-triggered run records trigger 'flag' and leads the prompt with the flag", async () => {
    const s = makeSession();
    const f = addFlag(s.id, "rm -rf build (FLAGTRIG_MARKER)");
    const entry = await overseer.onFlag(f);
    expect(entry?.trigger).toBe("flag");
    expect(calls[0].user.split("\n")[0]).toContain("FLAGTRIG_MARKER");
  });

  test("backend failure stores lastError, writes nothing and does not throw", async () => {
    const s = makeSession();
    overseer.setBackendForTests(async () => {
      throw new Error("boom (ERR_MARKER)");
    });
    const entry = await overseer.writeManual(s.id, "x");
    expect(entry).toBeUndefined();
    expect(db.listPlaybook(s.id)).toHaveLength(0);
    expect(overseer.overseerStatus().lastError).toContain("ERR_MARKER");
  });

  test("a refusal (backend returns undefined) writes nothing", async () => {
    const s = makeSession();
    overseer.setBackendForTests(async () => undefined);
    expect(await overseer.writeManual(s.id, "x")).toBeUndefined();
    expect(db.listPlaybook(s.id)).toHaveLength(0);
  });

  test("a plain-text reply without the ENTRY/NOW shape becomes an entry with no summary", async () => {
    const s = makeSession();
    overseer.setBackendForTests(async () => "Just a paragraph.");
    const e = await overseer.writeManual(s.id, "x");
    expect(e?.text).toBe("Just a paragraph.");
    expect(db.listPlaybook(s.id)).toHaveLength(1);
  });
});

describe("debounce and coalescing", () => {
  test("several Stop hooks within the debounce window produce one run", async () => {
    const s = makeSession();
    const p1 = overseer.onStop(s.id);
    const p2 = overseer.onStop(s.id);
    const p3 = overseer.onStop(s.id);
    const [e1, e2, e3] = await Promise.all([p1, p2, p3]);
    expect(calls).toHaveLength(1);
    expect(calls[0].user).toContain("Stop hook");
    expect(e1?.id).toBe(e2?.id);
    expect(e2?.id).toBe(e3?.id);
    expect(e1?.trigger).toBe("stop");
  });

  test("a Stop and a flag arriving during a run coalesce into one follow-up run led by the flag", async () => {
    const s = makeSession();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    overseer.setBackendForTests(async (req) => {
      calls.push(req);
      if (++n === 1) await gate; // first run blocks
      return reply(`Entry ${n}.`);
    });

    const first = overseer.onFlag(addFlag(s.id, "first flag (F1_MARKER)"));
    await Bun.sleep(10);
    expect(overseer.overseerStatus().running).toBe(1);

    const stop = overseer.onStop(s.id);
    const second = overseer.onFlag(addFlag(s.id, "second flag (F2_MARKER)"));
    await Bun.sleep(80); // past the debounce; still blocked on the first run
    expect(calls).toHaveLength(1);

    release();
    const [e1, e2, e3] = await Promise.all([first, stop, second]);
    await overseer.idle();
    expect(calls).toHaveLength(2);
    expect(calls[1].user.split("\n")[0]).toContain("F2_MARKER");
    expect(e1?.text).toBe("Entry 1.");
    expect(e2?.id).toBe(e3?.id); // the folded Stop resolves with the follow-up's entry
    expect(e3?.trigger).toBe("flag");
  });

  test("a pending Stop folds into a flag that arrives before the debounce fires", async () => {
    const s = makeSession();
    const stop = overseer.onStop(s.id);
    const flag = overseer.onFlag(addFlag(s.id, "fold me"));
    const [a, b] = await Promise.all([stop, flag]);
    await overseer.idle();
    expect(calls).toHaveLength(1);
    expect(a?.id).toBe(b?.id);
    expect(a?.trigger).toBe("flag");
  });

  test("onStop/onFlag are no-ops when disabled in config", async () => {
    const { config } = await import("../src/config");
    const s = makeSession();
    const was = { ...config.overseer };
    config.overseer.onStop = false;
    config.overseer.onFlag = false;
    try {
      expect(await overseer.onStop(s.id)).toBeUndefined();
      expect(await overseer.onFlag(addFlag(s.id, "ignored"))).toBeUndefined();
      expect(calls).toHaveLength(0);
    } finally {
      Object.assign(config.overseer, was);
    }
  });
});

describe("global playbook", () => {
  const isGlobal = (r: BackendRequest) => r.user.includes("Running sessions (");

  test("writes a global entry after a session entry, at most once per interval", async () => {
    overseer.setTimingForTests({ globalIntervalMs: 10 * 60_000 });
    const a = makeSession("alpha");
    const b = makeSession("beta");
    await overseer.writeManual(a.id, "1");
    await overseer.idle();
    await overseer.writeManual(b.id, "2");
    await overseer.idle();
    const globals = calls.filter(isGlobal);
    expect(globals).toHaveLength(1);
    expect(globals[0].user).toContain('"alpha"');
    expect(globals[0].user).toContain('"beta"');
    const rows = db.listPlaybook(null);
    expect(rows.filter((r) => r.kind === "entry")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "summary")).toHaveLength(1);
    expect(rows[0].sessionId).toBeNull();

    // Interval elapsed -> another global entry.
    overseer.setTimingForTests({ globalIntervalMs: 0 });
    await overseer.writeManual(a.id, "3");
    await overseer.idle();
    expect(calls.filter(isGlobal)).toHaveLength(2);
  });

  test("manual global question runs against all sessions without touching the throttle", async () => {
    makeSession("gamma");
    const e = await overseer.writeManual(null, "how are things? (GQ_MARKER)");
    expect(e?.sessionId).toBeNull();
    expect(e?.trigger).toBe("manual");
    expect(calls).toHaveLength(1);
    expect(isGlobal(calls[0])).toBe(true);
    expect(calls[0].user).toContain("GQ_MARKER");
    expect(calls[0].user).toContain('"gamma"');
    expect(calls[0].user).not.toContain("SUPER_SECRET_FUNCTION_BODY");
  });
});

describe("parseResponse", () => {
  test("splits ENTRY/NOW and tolerates missing NOW", () => {
    expect(overseer.parseResponse("ENTRY:\nA b.\nNOW:\nC d.")).toEqual({ entry: "A b.", summary: "C d." });
    expect(overseer.parseResponse("  ENTRY: only this")).toEqual({ entry: "only this" });
    expect(overseer.parseResponse("ENTRY:\nA\nNOW:\n")).toEqual({ entry: "A", summary: undefined });
  });
});
