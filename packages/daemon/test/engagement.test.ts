// bun test packages/daemon/test/engagement.test.ts
// Your side of a session (src/engagement.ts): prompt history and last keystroke, over a
// throwaway HENRY_HOME. Sessions are registered as "external" rows, like activity.test.ts.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HenryEvent, Session } from "@henry/shared";
import { rmScratch, stopSessiond } from "./sessiond-helper";

const scratch = mkdtempSync(join(tmpdir(), "henry-engagement-"));
process.env.HENRY_HOME = join(scratch, "home");
process.env.HENRY_PORT = "0";

const engagement = await import("../src/engagement");
const db = await import("../src/db");
const { sessions } = await import("../src/sessions");

const MIN = 60_000;
let n = 0;

function register(): Session {
  const s: Session = {
    id: `e${++n}-${crypto.randomUUID()}`,
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

const hook = (sessionId: string, hookEvent: string, ts: number): HenryEvent => ({
  id: crypto.randomUUID(),
  sessionId,
  ts,
  kind: "hook",
  hookEvent,
  payload: {},
  severity: "info",
  summary: hookEvent,
});

afterAll(async () => {
  await stopSessiond(join(scratch, "home"));
  await rmScratch(scratch);
});

describe("engagement", () => {
  let s: Session;
  beforeEach(() => {
    s = register();
  });

  test("prompts accumulate, ascending, and move lastInputAt", () => {
    const t0 = Date.now();
    engagement.note(s.id, "UserPromptSubmit", t0);
    engagement.note(s.id, "PreToolUse", t0 + 1);
    engagement.note(s.id, "UserPromptSubmit", t0 + 5 * MIN);
    expect(s.prompts).toEqual([t0, t0 + 5 * MIN]);
    expect(s.lastInputAt).toBe(t0 + 5 * MIN);
  });

  test("prompts older than the window are dropped on the next write", () => {
    const t0 = Date.now();
    engagement.note(s.id, "UserPromptSubmit", t0);
    engagement.note(s.id, "UserPromptSubmit", t0 + engagement.PROMPT_WINDOW_MS + MIN);
    expect(s.prompts).toEqual([t0 + engagement.PROMPT_WINDOW_MS + MIN]);
  });

  test("keystrokes move lastInputAt, throttled, and terminal replies do not count", () => {
    const t0 = Date.now();
    engagement.input(s.id, "\x1b[?1;2c", t0);
    engagement.input(s.id, "\x1b[24;80R", t0);
    expect(s.lastInputAt).toBeUndefined();
    engagement.input(s.id, "h", t0);
    expect(s.lastInputAt).toBe(t0);
    engagement.input(s.id, "i", t0 + 5_000);
    expect(s.lastInputAt).toBe(t0);
    engagement.input(s.id, "\r", t0 + engagement.INPUT_THROTTLE_MS);
    expect(s.lastInputAt).toBe(t0 + engagement.INPUT_THROTTLE_MS);
    expect(s.prompts).toBeUndefined();
  });

  test("a pasted block and arrow keys are human; a bare focus report is not", () => {
    expect(engagement.isHumanInput("\x1b[200~hello\x1b[201~")).toBe(true);
    expect(engagement.isHumanInput("\x1b[A")).toBe(false);
    expect(engagement.isHumanInput("\x1b[I")).toBe(false);
    expect(engagement.isHumanInput("\x1b\r")).toBe(true);
  });

  test("SessionEnd forgets the history; the session's exit clears the fields", () => {
    const t0 = Date.now();
    engagement.note(s.id, "UserPromptSubmit", t0);
    engagement.note(s.id, "SessionEnd", t0 + 1);
    engagement.note(s.id, "UserPromptSubmit", t0 + 2);
    expect(s.prompts).toEqual([t0 + 2]);
    sessions.kill(s.id);
    expect(s.status).toBe("exited");
    expect(s.prompts).toBeUndefined();
    expect(s.lastInputAt).toBeUndefined();
  });

  test("restore rebuilds the prompt history from the event log, inside the window only", () => {
    const now = Date.now();
    db.insertEvent(hook(s.id, "UserPromptSubmit", now - engagement.PROMPT_WINDOW_MS - MIN));
    db.insertEvent(hook(s.id, "UserPromptSubmit", now - 30 * MIN));
    db.insertEvent(hook(s.id, "PreToolUse", now - 29 * MIN));
    db.insertEvent(hook(s.id, "UserPromptSubmit", now - 2 * MIN));
    engagement.stop();
    engagement.restore(now);
    expect(s.prompts).toEqual([now - 30 * MIN, now - 2 * MIN]);
    expect(s.lastInputAt).toBe(now - 2 * MIN);
  });
});
