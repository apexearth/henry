// You, not Claude. Presence is measured in whole minutes: a minute counts if there is
// evidence you were there for it, and the evidence has three kinds — you sent a prompt, you
// typed into a terminal, or you were reading and moving around Henry's own windows. The
// daemon records minutes as they happen (daemon/human.ts, POST /api/presence); prompts also
// back-fill minutes from the event log, so days from before any of this existed, and
// sessions driven from outside Henry, still show up. Only the minute is stored, never what
// was on the screen.

export const MINUTE = 60_000;
/** A gap longer than this is not thinking time, it is you having left the desk. */
export const IDLE_MS = 15 * 60_000;

/** Why a minute counted. A minute can have several; they are bits in one mask. */
export const SRC = { prompt: 1, terminal: 2, reading: 4 } as const;
export type PresenceSource = keyof typeof SRC;
export const SOURCES = Object.keys(SRC) as PresenceSource[];

/** Epoch ms → the minute it falls in (epoch ms, floored). */
export const minuteOf = (ts: number): number => Math.floor(ts / MINUTE) * MINUTE;

/** Minute (epoch ms) → source mask. The one currency the maths below deals in. */
export type Minutes = Map<number, number>;

export interface Presence {
  prompts: number;
  /** Minutes with any evidence at all, as ms. */
  activeMs: number;
  /** Of those, the ones you were only reading or moving around in: no prompt, no typing. */
  readingMs: number;
  /** Longest run with no idle-length hole in it. */
  longestMs: number;
  /** Runs separated by a hole longer than IDLE_MS: how many times you sat down. */
  stretches: number;
  firstAt?: number;
  lastAt?: number;
  /** Median gap between prompts inside a stretch: your cadence when you are here. */
  medianGapMs?: number;
}

/** Fold `b` into `a` (mutates and returns `a`), OR-ing the masks of shared minutes. */
export function mergeMinutes(a: Minutes, b: Minutes): Minutes {
  for (const [m, mask] of b) a.set(m, (a.get(m) ?? 0) | mask);
  return a;
}

/**
 * The minutes a list of prompt timestamps (ascending) implies. Every minute between two
 * consecutive prompts counts when they are less than IDLE_MS apart — that is the reading and
 * waiting either side of a turn. A longer hole is you having left, and only the prompt's own
 * minute counts. `now` extends the last prompt the same way, so the clock keeps moving.
 */
export function minutesFromPrompts(times: number[], now?: number): Minutes {
  const out: Minutes = new Map();
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    const prev = i > 0 ? times[i - 1]! : undefined;
    const from = prev !== undefined && t - prev <= IDLE_MS ? prev : t;
    for (let m = minuteOf(from); m <= minuteOf(t); m += MINUTE) out.set(m, (out.get(m) ?? 0) | SRC.prompt);
  }
  const last = times[times.length - 1];
  if (last !== undefined && now !== undefined && now > last && now - last <= IDLE_MS) {
    for (let m = minuteOf(last); m <= minuteOf(now); m += MINUTE) out.set(m, (out.get(m) ?? 0) | SRC.prompt);
  }
  return out;
}

/** A day's recorded minutes, as stored and sent: 1440 hex digits, one per minute, "0" = away. */
export function packDay(dayStart: number, minutes: Minutes): string {
  const out = new Array<string>(1440).fill("0");
  for (const [m, mask] of minutes) {
    const i = Math.floor((m - dayStart) / MINUTE);
    if (i >= 0 && i < 1440) out[i] = (mask & 15).toString(16);
  }
  return out.join("");
}

export function unpackDay(dayStart: number, packed: string | undefined): Minutes {
  const out: Minutes = new Map();
  if (!packed) return out;
  for (let i = 0; i < packed.length && i < 1440; i++) {
    const mask = parseInt(packed[i]!, 16);
    if (mask) out.set(dayStart + i * MINUTE, mask);
  }
  return out;
}

/** Everything the UI shows about a span of your time, from its minutes and its prompts. */
export function presence(minutes: Minutes, prompts: number[] = []): Presence {
  const out: Presence = { prompts: prompts.length, activeMs: 0, readingMs: 0, longestMs: 0, stretches: 0 };
  const keys = [...minutes.keys()].sort((a, b) => a - b);
  out.activeMs = keys.length * MINUTE;
  for (const m of keys) if (!(minutes.get(m)! & (SRC.prompt | SRC.terminal))) out.readingMs += MINUTE;

  let runStart: number | undefined;
  let prev: number | undefined;
  for (const m of keys) {
    if (prev === undefined || m - prev > IDLE_MS) {
      out.stretches++;
      runStart = m;
    }
    out.longestMs = Math.max(out.longestMs, m - runStart! + MINUTE);
    prev = m;
  }
  if (keys.length) {
    out.firstAt = keys[0];
    out.lastAt = prev! + MINUTE;
  }
  if (prompts.length) {
    out.firstAt = Math.min(out.firstAt ?? prompts[0]!, prompts[0]!);
    out.lastAt = Math.max(out.lastAt ?? 0, prompts[prompts.length - 1]!);
    const gaps: number[] = [];
    for (let i = 1; i < prompts.length; i++) {
      const g = prompts[i]! - prompts[i - 1]!;
      if (g <= IDLE_MS) gaps.push(g);
    }
    if (gaps.length) {
      gaps.sort((a, b) => a - b);
      out.medianGapMs = gaps[Math.floor(gaps.length / 2)];
    }
  }
  return out;
}

/** Local midnight for a timestamp, in the clock's own timezone (DST-safe). */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** One local day of your side of the work. */
export interface HumanDay extends Presence {
  dayStart: number;
  /** Sessions you prompted that day. */
  sessions: number;
}

/** GET /api/human. Days are local to the daemon's clock, oldest first, today last. */
export interface HumanStats {
  /** Local midnight "today" is measured from. */
  dayStart: number;
  /** Today's prompt timestamps, ascending; the UI derives its own live numbers from these. */
  today: number[];
  /** Today's minutes, packed (see packDay), so the UI can draw the shape of the day. */
  todayMinutes: string;
  days: HumanDay[];
  /** Oldest evidence the DB still holds: history retention truncates the rest. */
  since?: number;
  idleMs: number;
}

/** POST /api/presence: a window saying you are here, once every `PRESENCE_BEAT_MS`. */
export interface PresenceBeat {
  source: PresenceSource;
  /** Minutes the window was here but could not report (asleep, offline), oldest first. */
  backfill?: number[];
}
export const PRESENCE_BEAT_MS = 30_000;
