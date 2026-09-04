// bun test packages/daemon/test/human.test.ts
// Your hours (shared/human.ts + src/human.ts): presence measured in whole minutes, from
// minutes recorded as they happen and from the spacing of prompts, rolled up by local day
// over a throwaway HENRY_HOME.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HenryEvent, Minutes } from "@henry/shared";
import { IDLE_MS, MINUTE, mergeMinutes, minuteOf, minutesFromPrompts, packDay, presence, SRC, startOfDay, unpackDay } from "@henry/shared";
import { rmScratch, stopSessiond } from "./sessiond-helper";

const scratch = mkdtempSync(join(tmpdir(), "henry-human-"));
process.env.HENRY_HOME = join(scratch, "home");
process.env.HENRY_PORT = "0";

const db = await import("../src/db");
const { humanStats, notePresence } = await import("../src/human");

function prompt(sessionId: string, ts: number): void {
  const e: HenryEvent = { id: crypto.randomUUID(), sessionId, ts, kind: "hook", hookEvent: "UserPromptSubmit", payload: {}, severity: "info", summary: "prompt" };
  db.insertEvent(e);
}

/** A run of minutes with one source, the way a window's beats land. */
function span(from: number, count: number, mask: number): Minutes {
  const out: Minutes = new Map();
  for (let i = 0; i < count; i++) out.set(minuteOf(from) + i * MINUTE, mask);
  return out;
}

afterAll(async () => {
  await stopSessiond(join(scratch, "home"));
  await rmScratch(scratch);
});

describe("presence", () => {
  test("nothing recorded, no time", () => {
    expect(presence(new Map())).toEqual({ prompts: 0, activeMs: 0, readingMs: 0, longestMs: 0, stretches: 0 });
  });

  test("minutes are the unit, and reading is the ones you did not type in", () => {
    const t = startOfDay(Date.now()) + 9 * 60 * MINUTE;
    const minutes = mergeMinutes(span(t, 20, SRC.reading), span(t + 5 * MINUTE, 3, SRC.terminal));
    const p = presence(minutes, [t + 5 * MINUTE]);
    expect(p.activeMs).toBe(20 * MINUTE);
    expect(p.readingMs).toBe(17 * MINUTE);
    expect(p.stretches).toBe(1);
    expect(p.longestMs).toBe(20 * MINUTE);
  });

  test("a hole longer than the idle window is a second sit-down", () => {
    const t = startOfDay(Date.now()) + 9 * 60 * MINUTE;
    const minutes = mergeMinutes(span(t, 10, SRC.reading), span(t + 10 * MINUTE + IDLE_MS + MINUTE, 5, SRC.reading));
    const p = presence(minutes);
    expect(p.stretches).toBe(2);
    expect(p.activeMs).toBe(15 * MINUTE);
    expect(p.longestMs).toBe(10 * MINUTE);
  });

  test("prompts fill the minutes between them, up to the idle window", () => {
    const t = minuteOf(Date.now());
    const close = minutesFromPrompts([t, t + 4 * MINUTE]);
    expect(close.size).toBe(5);
    const far = minutesFromPrompts([t, t + IDLE_MS + MINUTE]);
    expect(far.size).toBe(2);
    // `now` extends the last prompt the same way, and stops at the idle window.
    expect(minutesFromPrompts([t], t + 3 * MINUTE).size).toBe(4);
    expect(minutesFromPrompts([t], t + IDLE_MS + MINUTE).size).toBe(1);
  });

  test("a day packs to 1440 hex digits and back", () => {
    const day = startOfDay(Date.now());
    const packed = packDay(day, mergeMinutes(span(day + 60 * MINUTE, 2, SRC.reading), span(day + 60 * MINUTE, 1, SRC.prompt)));
    expect(packed).toHaveLength(1440);
    expect(packed[60]).toBe("5"); // reading | prompt
    expect(packed[61]).toBe("4");
    expect(unpackDay(day, packed).get(day + 60 * MINUTE)).toBe(SRC.reading | SRC.prompt);
  });
});

describe("humanStats", () => {
  test("unions recorded minutes with prompt minutes, by local day", () => {
    const noon = startOfDay(Date.now()) + 12 * 60 * MINUTE;
    const yesterday = noon - 24 * 60 * MINUTE;
    prompt("s1", yesterday);
    prompt("s1", yesterday + 6 * MINUTE);
    prompt("s1", noon);
    prompt("s2", noon + 5 * MINUTE);
    // Twenty minutes of reading before the first prompt of the day, no typing in them.
    db.markPresence([...span(noon - 20 * MINUTE, 20, 0).keys()], SRC.reading);

    const h = humanStats(14, noon + 6 * MINUTE);
    expect(h.dayStart).toBe(startOfDay(noon));
    expect(h.today).toEqual([noon, noon + 5 * MINUTE]);
    expect(h.todayMinutes).toHaveLength(1440);

    const today = h.days[h.days.length - 1]!;
    // 20 read + the 6 minutes spanned by the two prompts and the live tail, one stretch.
    expect(today.activeMs).toBe(27 * MINUTE);
    expect(today.readingMs).toBe(20 * MINUTE);
    expect(today.prompts).toBe(2);
    expect(today.sessions).toBe(2);
    expect(today.stretches).toBe(1);
    // Yesterday has prompts only: seven minutes, since they are six minutes apart.
    expect(h.days[h.days.length - 2]!.activeMs).toBe(7 * MINUTE);
    expect(h.idleMs).toBe(IDLE_MS);
  });

  test("the first beat claims one minute; later ones bridge the silence since the last", () => {
    // Yesterday at 04:00: well clear of the minutes the rollup test above wrote.
    const t = startOfDay(Date.now()) - 20 * 60 * MINUTE;
    const seen = (from: number, to: number) => db.listPresence(from).filter((r) => r.minute <= to).map((r) => r.minute);
    notePresence("reading", t);
    notePresence("reading", t + 1_000); // same minute: no second write
    expect(seen(minuteOf(t) - 5 * MINUTE, minuteOf(t))).toEqual([minuteOf(t)]);

    // Two minutes later (a missed beat): the gap is bridged, not left as a hole.
    notePresence("reading", t + 2 * MINUTE);
    expect(seen(minuteOf(t), minuteOf(t) + 2 * MINUTE)).toEqual([minuteOf(t), minuteOf(t) + MINUTE, minuteOf(t) + 2 * MINUTE]);

    // An hour later: only that minute, because you were not here for the hour.
    notePresence("reading", t + 62 * MINUTE);
    expect(seen(minuteOf(t) + 3 * MINUTE, minuteOf(t) + 62 * MINUTE)).toEqual([minuteOf(t) + 62 * MINUTE]);
    expect(db.listPresence(minuteOf(t)).every((r) => r.mask === SRC.reading)).toBe(true);
  });
});
