// Your side of the work, rolled up by local day. Two sources of truth, unioned per minute:
// minutes recorded as they happened (a window saying you are reading, a keystroke into a
// terminal, a prompt) and minutes implied by the spacing of prompts in the event log. The
// second is what makes days from before Henry recorded anything, and sessions driven from a
// terminal Henry cannot see, still count. The maths lives in shared/human.ts so the UI can
// run the same function live over today.
import {
  MINUTE,
  mergeMinutes,
  minuteOf,
  minutesFromPrompts,
  packDay,
  presence,
  SRC,
  startOfDay,
  type HumanDay,
  type HumanStats,
  type Minutes,
  type PresenceSource,
} from "@henry/shared";
import { IDLE_MS } from "@henry/shared";
import * as db from "./db";

/** How much history the topbar's popover draws. */
export const HUMAN_DAYS = 14;
/** A beat covers the minute it names and, at most, this much of the silence before it, so a
 *  window that missed a couple of beats (asleep laptop, a stall) does not punch holes. */
const BEAT_REACH_MS = 2 * MINUTE;

/** Last minute written per source: keystrokes arrive per keypress, the DB needs one write. */
const marked = new Map<PresenceSource, number>();

/** A window (or the daemon itself) saying you were here. Idempotent per minute: the first
 *  beat of a sitting claims only its own minute, later ones bridge the short silence since
 *  the last, so a missed beat does not punch a hole and arriving does not credit you time. */
export function notePresence(source: PresenceSource, ts = Date.now(), reach = BEAT_REACH_MS): void {
  const at = minuteOf(ts);
  const prev = marked.get(source);
  if (prev === at) return;
  marked.set(source, at);
  const from = prev !== undefined && at - prev <= reach ? prev : at;
  const minutes: number[] = [];
  for (let m = from; m <= at; m += MINUTE) minutes.push(m);
  db.markPresence(minutes, SRC[source]);
}

/** Minutes a window could not report while it was asleep or offline. */
export function backfillPresence(source: PresenceSource, minutes: number[], now = Date.now()): void {
  const floor = now - 24 * 60 * MINUTE;
  const clean = minutes.map(minuteOf).filter((m) => m >= floor && m <= now);
  db.markPresence([...new Set(clean)].slice(0, 1440), SRC[source]);
}

export function humanStats(days = HUMAN_DAYS, now = Date.now()): HumanStats {
  const today = startOfDay(now);
  const from = new Date(today);
  from.setDate(from.getDate() - (days - 1));
  const since = from.getTime();

  const prompts = db.listPromptTimes(since);
  const recorded: Minutes = new Map();
  for (const r of db.listPresence(since)) recorded.set(r.minute, r.mask);

  // Group both sources by the local day they fall in. A stretch across midnight is split by
  // the day line: days are what the popover draws, and a day has to end somewhere.
  const byDay = new Map<number, { times: number[]; sessions: Set<string>; minutes: Minutes }>();
  const day = (ts: number) => {
    const key = startOfDay(ts);
    let d = byDay.get(key);
    if (!d) byDay.set(key, (d = { times: [], sessions: new Set(), minutes: new Map() }));
    return d;
  };
  for (const p of prompts) {
    const d = day(p.ts);
    d.times.push(p.ts);
    d.sessions.add(p.sessionId);
  }
  for (const [m, mask] of recorded) day(m).minutes.set(m, mask);

  const out: HumanDay[] = [];
  for (const [dayStart, d] of [...byDay].sort((a, b) => a[0] - b[0])) {
    const live = dayStart === today ? now : undefined;
    const minutes = mergeMinutes(new Map(d.minutes), minutesFromPrompts(d.times, live));
    out.push({ dayStart, sessions: d.sessions.size, ...presence(minutes, d.times) });
  }

  const todayData = byDay.get(today);
  return {
    dayStart: today,
    today: todayData?.times ?? [],
    todayMinutes: packDay(today, todayData?.minutes ?? new Map()),
    days: out,
    since: oldest(),
    idleMs: IDLE_MS,
  };
}

/** The earliest thing either source still holds; nothing before it can be claimed. */
function oldest(): number | undefined {
  const candidates = [db.oldestEventTs(), db.oldestPresenceMinute()].filter((n): n is number => n !== undefined);
  return candidates.length ? Math.min(...candidates) : undefined;
}
