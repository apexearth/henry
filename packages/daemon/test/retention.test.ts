// bun test — db.pruneHistory against a scratch HENRY_HOME. No server, no port.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Flag, HenryEvent, PlaybookEntry } from "@henry/shared";
import { rmScratch } from "./sessiond-helper";

const home = mkdtempSync(join(tmpdir(), "henry-retention-"));
process.env.HENRY_HOME = home;
delete process.env.HENRY_PORT;

const db = await import("../src/db");

afterAll(async () => {
  await rmScratch(home);
});

const DAY = 24 * 60 * 60_000;
const now = Date.now();

function event(id: string, ts: number): HenryEvent {
  return { id, sessionId: "s1", ts, kind: "hook", hookEvent: "PostToolUse", payload: {}, severity: "info", summary: id };
}
function flag(id: string, ts: number): Flag {
  return { id, eventId: id, sessionId: "s1", ts, severity: "notable", rule: "test", summary: id, read: false };
}
function entry(id: string, ts: number): PlaybookEntry {
  return { id, sessionId: "s1", ts, text: id, trigger: "stop", kind: "entry" };
}

describe("pruneHistory", () => {
  test("drops rows older than the window and keeps the rest", () => {
    for (const [id, age] of [["old", 40], ["edge", 31], ["fresh", 2]] as const) {
      db.insertEvent(event(id, now - age * DAY));
      db.insertFlag(flag(id, now - age * DAY));
      db.insertPlaybook(entry(id, now - age * DAY));
    }
    db.markPresence([now - 40 * DAY, now - 2 * DAY], 1);
    // An ask is swept on its age like everything else, but only once it is over: a live one
    // is held by its deadline, not by the window.
    db.upsertAttention({ id: "asked", sessionId: "s1", ts: now - 40 * DAY, message: "come here", deadline: now - 39 * DAY, done: "expired", doneAt: now - 39 * DAY });
    db.upsertAttention({ id: "asking", sessionId: "s1", ts: now - 40 * DAY, message: "still here", deadline: now + DAY });
    const counts = db.pruneHistory(30);
    expect(counts).toEqual({ events: 2, flags: 2, playbook: 2, snapshots: 0, presence: 1, attention: 1 });
    expect(db.listOpenAttention().map((a) => a.id)).toEqual(["asking"]);
    expect(db.listEvents({ sessionId: "s1" }).map((e) => e.id)).toEqual(["fresh"]);
    expect(db.listFlags({ sessionId: "s1" }).map((f) => f.id)).toEqual(["fresh"]);
    expect(db.listPlaybook("s1").map((p) => p.id)).toEqual(["fresh"]);
  });

  test("0 days keeps everything", () => {
    db.insertEvent(event("ancient", now - 400 * DAY));
    expect(db.pruneHistory(0)).toBeUndefined();
    expect(db.listEvents({ sessionId: "s1" }).map((e) => e.id)).toEqual(["fresh", "ancient"]);
  });

  test("the newest usage snapshot survives however old it is", () => {
    db.insertUsageSnapshot({ perSession: {}, updatedAt: 0 }, now - 90 * DAY);
    db.insertUsageSnapshot({ perSession: {}, updatedAt: 1 }, now - 60 * DAY);
    const counts = db.pruneHistory(30);
    expect(counts?.snapshots).toBe(1);
    expect(db.latestUsageSnapshot()?.ts).toBe(now - 60 * DAY);
  });
});
