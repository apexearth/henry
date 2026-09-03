// bun test packages/daemon/test/activity.test.ts
// The session activity state machine (src/activity.ts) over a throwaway HENRY_HOME. No PTYs:
// sessions are registered as "external" rows, which is what a claude started outside Henry is.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HenryEvent, Session } from "@henry/shared";
import { stopSessiond } from "./sessiond-helper";

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
  rmSync(scratch, { recursive: true, force: true });
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
    for (const ev of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStop", "PreCompact"]) {
      activity.note(s.id, "Stop", {}, t0);
      activity.note(s.id, ev, {}, t0 + 1);
      expect(s.activity).toBe("working");
    }
    activity.note(s.id, "Stop", { stop_hook_active: false }, t0 + 2);
    expect(s.activity).toBe("waiting");
    expect(s.activitySince).toBe(t0 + 2);
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

  test("restore does not resurrect a state older than the idle window", () => {
    const now = Date.now();
    db.insertEvent(hook(s.id, "Stop", {}, now - 2 * activity.IDLE_AFTER_MS));
    activity.restore(now);
    expect(s.activity).toBe("idle");
  });
});
