// bun test packages/daemon/test/activity.test.ts
// The session activity state machine (src/activity.ts) over a throwaway HENRY_HOME. No PTYs:
// sessions are registered as "external" rows, which is what a claude started outside Henry is.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HenryEvent, Session } from "@henry/shared";
import { rmScratch, stopSessiond } from "./sessiond-helper";

const scratch = mkdtempSync(join(tmpdir(), "henry-activity-"));
process.env.HENRY_HOME = join(scratch, "home");
process.env.HENRY_PORT = "0";

// Imported after HENRY_HOME is set (static imports would hoist above the assignment).
const activity = await import("../src/activity");
const db = await import("../src/db");
const { sessions } = await import("../src/sessions");

const MIN = 60_000;
let n = 0;

function register(): Session {
  const s: Session = {
    id: `s${++n}-${crypto.randomUUID()}`,
    claudeSessionId: crypto.randomUUID(),
    cwd: scratch,
    title: `session ${n}`,
    createdAt: Date.now(),
    status: "running",
    command: "external",
  };
  sessions.registerExternal(s);
  return sessions.get(s.id)!;
}

const hook = (sessionId: string, hookEvent: string, payload: unknown, ts: number): HenryEvent => ({
  id: crypto.randomUUID(),
  sessionId,
  ts,
  kind: "hook",
  hookEvent,
  payload,
  severity: "info",
  summary: hookEvent,
});

afterAll(async () => {
  await stopSessiond(join(scratch, "home"));
  await rmScratch(scratch);
});

describe("activity", () => {
  let s: Session;
  beforeEach(() => {
    s = register();
  });

  test("a fresh session has no activity until it posts a hook", () => {
    expect(s.activity).toBeUndefined();
    expect(s.activitySince).toBeUndefined();
  });

  test("tool calls and prompts mean working; a plain Stop hands the turn back", () => {
    const t0 = Date.now();
    for (const ev of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
      activity.note(s.id, "Stop", {}, t0);
      activity.note(s.id, ev, {}, t0 + 1);
      expect(s.activity).toBe("working");
    }
    activity.note(s.id, "Stop", { stop_hook_active: false }, t0 + 2);
    expect(s.activity).toBe("waiting");
    expect(s.activitySince).toBe(t0 + 2);
  });

  test("a SubagentStop after the turn ended (away summary, plugin workers) does not restart it", () => {
    const t0 = Date.now();
    activity.note(s.id, "Stop", { stop_hook_active: false }, t0);
    activity.note(s.id, "SubagentStop", { stop_hook_active: false }, t0 + 3 * MIN);
    expect(s.activity).toBe("waiting");
    expect(s.activitySince).toBe(t0);
    // Mid-turn it is a heartbeat: the session stays working and does not age out.
    activity.note(s.id, "PreToolUse", { tool_name: "Agent" }, t0 + 4 * MIN);
    activity.note(s.id, "SubagentStop", {}, t0 + 4 * MIN + activity.SILENT_AFTER_MS - MIN);
    activity.age(t0 + 4 * MIN + activity.SILENT_AFTER_MS + MIN);
    expect(s.activity).toBe("working");
  });

  test("compaction keeps the state it interrupted", () => {
    const t0 = Date.now();
    activity.note(s.id, "PreToolUse", {}, t0);
    activity.note(s.id, "PreCompact", { trigger: "auto" }, t0 + 1);
    activity.note(s.id, "SessionStart", { source: "compact" }, t0 + 2);
    expect(s.activity).toBe("working");
    activity.note(s.id, "Stop", {}, t0 + 3);
    activity.note(s.id, "PreCompact", { trigger: "manual" }, t0 + 4);
    activity.note(s.id, "SessionStart", { source: "compact" }, t0 + 5);
    expect(s.activity).toBe("waiting");
  });

  test("a Stop that another hook forced is still working", () => {
    activity.note(s.id, "Stop", { stop_hook_active: true }, Date.now());
    expect(s.activity).toBe("working");
  });

  test("a permission notification blocks on the user; the idle nudge only waits", () => {
    activity.note(s.id, "Notification", { message: "Claude needs your permission to use Bash" }, Date.now());
    expect(s.activity).toBe("needsInput");
    activity.note(s.id, "Notification", { message: "Claude is waiting for your input" }, Date.now());
    expect(s.activity).toBe("waiting");
  });

  test("a prompt blocks on every call in flight; one approval does not end it", () => {
    // Two Bash calls in one message: Claude Code prompts for each but notifies once. The
    // first approval's PostToolUse must not read as working while the second prompt is up.
    const t0 = Date.now();
    activity.note(s.id, "PreToolUse", { tool_name: "Bash", tool_use_id: "a" }, t0);
    activity.note(s.id, "PreToolUse", { tool_name: "Bash", tool_use_id: "b" }, t0 + 1);
    activity.note(s.id, "Notification", { message: "Claude needs your permission", notification_type: "permission_prompt" }, t0 + 2);
    expect(s.activity).toBe("needsInput");
    activity.note(s.id, "PostToolUse", { tool_name: "Bash", tool_use_id: "a" }, t0 + 3);
    expect(s.activity).toBe("needsInput");
    expect(s.activitySince).toBe(t0 + 2);
    activity.note(s.id, "PostToolUse", { tool_name: "Bash", tool_use_id: "b" }, t0 + 4);
    expect(s.activity).toBe("working");
  });

  test("PermissionRequest names the call by tool and input, once per prompt", () => {
    const t0 = Date.now();
    const a = { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "a" };
    const b = { tool_name: "Bash", tool_input: { command: "rm x" }, tool_use_id: "b" };
    activity.note(s.id, "PreToolUse", a, t0);
    activity.note(s.id, "PreToolUse", b, t0 + 1);
    activity.note(s.id, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" } }, t0 + 2);
    expect(s.activity).toBe("needsInput");
    activity.note(s.id, "PostToolUse", a, t0 + 3);
    expect(s.activity).toBe("working"); // b was auto-approved and is still running
    activity.note(s.id, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm x" } }, t0 + 4);
    // The batch notification 6 s later is the same prompt, not a wider one.
    activity.note(s.id, "Notification", { message: "Claude needs your permission" }, t0 + 10);
    expect(s.activity).toBe("needsInput");
    expect(s.activitySince).toBe(t0 + 4);
    activity.note(s.id, "PostToolUse", b, t0 + 11);
    expect(s.activity).toBe("working");
  });

  test("a denied call leaves no hook: the transcript prunes it, the thread's next call releases it", () => {
    const t0 = Date.now();
    // The auto-mode classifier denied "x" before the prompt; only the transcript says so.
    activity.note(s.id, "PreToolUse", { tool_name: "Bash", tool_use_id: "x" }, t0);
    activity.toolResult(s.id, "x");
    activity.note(s.id, "PreToolUse", { tool_name: "Bash", tool_use_id: "a" }, t0 + 1);
    activity.note(s.id, "Notification", { message: "Claude needs your permission" }, t0 + 2);
    activity.note(s.id, "PostToolUse", { tool_name: "Bash", tool_use_id: "a" }, t0 + 3);
    expect(s.activity).toBe("working");
    // I denied "y" at its prompt and the transcript has not caught up: Claude's next call
    // says the prompt is gone, so the stale id does not hold the session.
    activity.note(s.id, "PreToolUse", { tool_name: "Bash", tool_use_id: "y" }, t0 + 4);
    activity.note(s.id, "Notification", { message: "Claude needs your permission" }, t0 + 5);
    expect(s.activity).toBe("needsInput");
    activity.note(s.id, "PreToolUse", { tool_name: "Bash", tool_use_id: "z" }, t0 + 6);
    expect(s.activity).toBe("working");
    activity.note(s.id, "PostToolUse", { tool_name: "Bash", tool_use_id: "z" }, t0 + 7);
    expect(s.activity).toBe("working");
  });

  test("a subagent's calls end with it, hooks or no hooks", () => {
    const t0 = Date.now();
    activity.note(s.id, "PreToolUse", { tool_name: "Bash", tool_use_id: "s1", agent_id: "sub" }, t0);
    activity.note(s.id, "SubagentStop", { agent_id: "sub" }, t0 + 1);
    activity.note(s.id, "PreToolUse", { tool_name: "Bash", tool_use_id: "b" }, t0 + 2);
    activity.note(s.id, "Notification", { message: "Claude needs your permission" }, t0 + 3);
    activity.note(s.id, "PostToolUse", { tool_name: "Bash", tool_use_id: "b" }, t0 + 4);
    expect(s.activity).toBe("working");
  });

  test("a prompt belongs to the thread that made the latest call; other threads are heartbeats", () => {
    const t0 = Date.now();
    // Main thread: an Agent call (never prompts) and a Bash that does. A subagent keeps reading.
    activity.note(s.id, "PreToolUse", { tool_name: "Agent", tool_use_id: "agent" }, t0);
    activity.note(s.id, "PreToolUse", { tool_name: "Bash", tool_use_id: "b" }, t0 + 1);
    activity.note(s.id, "Notification", { message: "Claude needs your permission" }, t0 + 2);
    activity.note(s.id, "PreToolUse", { tool_name: "Read", tool_use_id: "s1", agent_id: "sub" }, t0 + 3);
    activity.note(s.id, "PostToolUse", { tool_name: "Read", tool_use_id: "s1", agent_id: "sub" }, t0 + 4);
    expect(s.activity).toBe("needsInput");
    activity.note(s.id, "PostToolUse", { tool_name: "Bash", tool_use_id: "b" }, t0 + 5);
    expect(s.activity).toBe("working");
    // Subagent 1 is minutes into a test run when subagent 2's Bash prompts: only 2's calls block.
    activity.note(s.id, "PreToolUse", { tool_name: "Bash", tool_use_id: "long", agent_id: "sub1" }, t0 + 6);
    activity.note(s.id, "PreToolUse", { tool_name: "Bash", tool_use_id: "s2", agent_id: "sub2" }, t0 + 7);
    activity.note(s.id, "Notification", { message: "Claude needs your permission" }, t0 + 8);
    expect(s.activity).toBe("needsInput");
    activity.note(s.id, "PostToolUse", { tool_name: "Bash", tool_use_id: "s2", agent_id: "sub2" }, t0 + 9);
    expect(s.activity).toBe("working");
  });

  test("SessionStart parks at the prompt; SessionEnd clears", () => {
    activity.note(s.id, "SessionStart", { source: "startup" }, Date.now());
    expect(s.activity).toBe("waiting");
    activity.note(s.id, "SessionEnd", { reason: "exit" }, Date.now());
    expect(s.activity).toBeUndefined();
  });

  test("activitySince only moves when the state does", () => {
    const t0 = Date.now() - 5 * MIN;
    activity.note(s.id, "PreToolUse", {}, t0);
    activity.note(s.id, "PostToolUse", {}, t0 + MIN);
    expect(s.activity).toBe("working");
    expect(s.activitySince).toBe(t0);
  });

  test("waiting ages into idle; a silent turn stops claiming to work; needsInput does not age", () => {
    const now = Date.now();
    const waiting = register();
    const working = register();
    const busy = register();
    const blocked = register();
    activity.note(waiting.id, "Stop", {}, now - activity.IDLE_AFTER_MS - MIN);
    activity.note(working.id, "PreToolUse", {}, now - activity.SILENT_AFTER_MS - MIN);
    activity.note(busy.id, "PreToolUse", {}, now - MIN);
    activity.note(blocked.id, "Notification", { message: "Claude needs your permission to use Bash" }, now - 2 * activity.IDLE_AFTER_MS);

    activity.age(now);
    expect(waiting.activity).toBe("idle");
    expect(working.activity).toBe("idle");
    expect(busy.activity).toBe("working");
    expect(blocked.activity).toBe("needsInput");
  });

  test("a statusline heartbeat keeps a long turn from going idle", () => {
    const now = Date.now();
    activity.note(s.id, "PreToolUse", {}, now - activity.SILENT_AFTER_MS - MIN);
    activity.seen(s.id, now - MIN);
    activity.age(now);
    expect(s.activity).toBe("working");
  });

  test("restore re-derives a running session's state from the last hook event", () => {
    const now = Date.now();
    // What a daemon restart sees: rows in the DB, nothing in memory.
    db.insertEvent(hook(s.id, "PreToolUse", {}, now - 3 * MIN));
    db.insertEvent(hook(s.id, "Stop", { stop_hook_active: false }, now - 2 * MIN));
    db.insertEvent({ ...hook(s.id, "", {}, now - MIN), kind: "git", hookEvent: undefined, summary: "branch changed" });
    expect(s.activity).toBeUndefined();

    activity.restore(now);
    expect(s.activity).toBe("waiting");
    expect(s.activitySince).toBe(now - 2 * MIN);
  });

  test("restore replays the turn, so a blocked prompt survives a restart", () => {
    const now = Date.now();
    db.insertEvent(hook(s.id, "PreToolUse", { tool_name: "Bash", tool_use_id: "a" }, now - 4 * MIN));
    db.insertEvent(hook(s.id, "PreToolUse", { tool_name: "Bash", tool_use_id: "b" }, now - 4 * MIN + 1));
    db.insertEvent(hook(s.id, "Notification", { message: "Claude needs your permission" }, now - 3 * MIN));
    db.insertEvent(hook(s.id, "PostToolUse", { tool_name: "Bash", tool_use_id: "a" }, now - 2 * MIN));
    activity.restore(now);
    expect(s.activity).toBe("needsInput");
    expect(s.activitySince).toBe(now - 3 * MIN);
    activity.note(s.id, "PostToolUse", { tool_name: "Bash", tool_use_id: "b" }, now);
    expect(s.activity).toBe("working");
  });

  test("restore does not resurrect a state older than the idle window", () => {
    const now = Date.now();
    db.insertEvent(hook(s.id, "Stop", {}, now - 2 * activity.IDLE_AFTER_MS));
    activity.restore(now);
    expect(s.activity).toBe("idle");
  });
});
