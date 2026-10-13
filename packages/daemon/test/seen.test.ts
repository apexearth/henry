// bun test packages/daemon/test/seen.test.ts
// Unseen marks and reminders (src/seen.ts, with notify.ts marking finished turns), over a
// throwaway HENRY_HOME. Sessions are registered as "external" rows, like engagement.test.ts.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notice, Session } from "@henry/shared";
import { rmScratch, stopSessiond } from "./sessiond-helper";

const scratch = mkdtempSync(join(tmpdir(), "henry-seen-"));
process.env.HENRY_HOME = join(scratch, "home");
process.env.HENRY_PORT = "0";

const seen = await import("../src/seen");
const notify = await import("../src/notify");
const engagement = await import("../src/engagement");
const db = await import("../src/db");
const { sessions } = await import("../src/sessions");

const notices: Notice[] = [];
notify.setBroadcast((m) => {
  if (m.type === "notify") notices.push(m.notice);
});

let n = 0;
function register(): Session {
  const s: Session = {
    id: `u${++n}-${crypto.randomUUID()}`,
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

afterAll(async () => {
  await stopSessiond(join(scratch, "home"));
  await rmScratch(scratch);
});

describe("seen", () => {
  let s: Session;
  beforeEach(() => {
    s = register();
    notices.length = 0;
  });

  test("a turn that worked ends unseen; a quick answer does not", () => {
    const t = Date.now();
    notify.onSessionUpdate({ ...s, activity: "working", activitySince: t - 60_000 }, t - 60_000);
    notify.onSessionUpdate({ ...s, activity: "waiting", activitySince: t }, t);
    expect(sessions.get(s.id)!.unseenSince).toBe(t);
    expect(db.getSession(s.id)!.unseenSince).toBe(t);

    const q = register();
    notify.onSessionUpdate({ ...q, activity: "working", activitySince: t - 2_000 }, t - 2_000);
    notify.onSessionUpdate({ ...q, activity: "waiting", activitySince: t }, t);
    expect(sessions.get(q.id)!.unseenSince).toBeUndefined();
  });

  test("the first unseen moment is kept until you look", () => {
    seen.unseen(s.id, 1_000);
    seen.unseen(s.id, 2_000);
    expect(sessions.get(s.id)!.unseenSince).toBe(1_000);
    seen.seen(s.id);
    expect(sessions.get(s.id)!.unseenSince).toBeUndefined();
    expect(db.getSession(s.id)!.unseenSince).toBeUndefined();
  });

  test("typing into the session or prompting it is seeing it", () => {
    seen.unseen(s.id);
    engagement.input(s.id, "y");
    expect(sessions.get(s.id)!.unseenSince).toBeUndefined();
    seen.unseen(s.id);
    engagement.note(s.id, "UserPromptSubmit", Date.now(), "go on");
    expect(sessions.get(s.id)!.unseenSince).toBeUndefined();
  });

  test("a reminder puts the session down, and brings it back unseen with a notice when due", () => {
    const t = Date.now();
    seen.unseen(s.id, t - 1_000);
    seen.remind(s.id, t + 60_000);
    expect(sessions.get(s.id)!.unseenSince).toBeUndefined();
    expect(db.getSession(s.id)!.remindAt).toBe(t + 60_000);

    seen.tick(t + 30_000);
    expect(notices.length).toBe(0);
    seen.tick(t + 61_000);
    expect(sessions.get(s.id)!.remindAt).toBeUndefined();
    expect(sessions.get(s.id)!.unseenSince).toBe(t + 61_000);
    expect(notices.map((x) => [x.kind, x.sessionId])).toEqual([["remind", s.id]]);
    seen.tick(t + 120_000);
    expect(notices.length).toBe(1);
  });

  test("a cancelled reminder never fires, and leaves the unseen mark alone", () => {
    const t = Date.now();
    seen.remind(s.id, t + 60_000);
    seen.unseen(s.id, t);
    seen.remind(s.id, null);
    seen.tick(t + 120_000);
    expect(notices.length).toBe(0);
    expect(sessions.get(s.id)!.unseenSince).toBe(t);
  });
});
