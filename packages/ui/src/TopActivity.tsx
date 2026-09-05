// The topbar strip. Two halves: what the sessions are doing (working / needs you / waiting,
// and how much uncommitted work is lying around), then what *you* have been doing — hours at
// the keyboard, prompts sent, and the cadence you sent them at. The human half comes from
// GET /api/human: whole minutes you were here, from beats this window sends while you read
// (presence.ts) and from the spacing of your prompts. Today's minutes and prompts come down
// raw so the same maths can run here with the current minute added, which is what keeps the
// clock moving while you sit and read instead of freezing until your next prompt.
import { useEffect, useState } from "react";
import {
  mergeMinutes,
  minuteOf,
  minutesFromPrompts,
  presence,
  SRC,
  startOfDay,
  unpackDay,
  type Attention,
  type HumanStats,
  type Minutes,
  type RepoState,
  type Session,
} from "@henry/shared";
import { showSession, showTool } from "./dock";
import { isHere } from "./presence";
import { useAskTitle } from "./title";
import { answerAttention, setActive, useStore } from "./ws";

/** The cadence sparkline: 10-minute buckets over the last four hours. */
const BUCKET_MS = 10 * 60_000;
const BUCKETS = 24;
const SPARK_H = 10;

/** Re-render slowly so the clock ages; prompts themselves arrive over the WS. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** "3h 12m", "47m", "2m", "just started". */
function dur(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return "just started";
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Cadence, as a person would say it: "4m" between prompts, "40s" when you are on a roll. */
function gap(ms: number | undefined): string {
  if (ms === undefined) return "–";
  return ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60000)}m`;
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function bucket(times: number[], now: number): number[] {
  const counts = new Array<number>(BUCKETS).fill(0);
  const start = now - BUCKETS * BUCKET_MS;
  for (const t of times) {
    if (t < start || t > now) continue;
    counts[Math.min(BUCKETS - 1, Math.floor((t - start) / BUCKET_MS))]!++;
  }
  return counts;
}

/** Oldest first: the session that has been waiting on you longest is the one to jump to. */
function jump(list: Session[]) {
  const s = [...list].sort((a, b) => (a.activitySince ?? a.createdAt) - (b.activitySince ?? b.createdAt))[0];
  if (!s) return;
  setActive(s.id);
  showSession(s.id);
}

/** Go to the session that asked (asks are oldest first) and tell every session you have seen
 * theirs: the messages are in the tooltip you just read, so one click answers the lot. */
function answer(asks: Attention[]) {
  const to = asks.find((a) => a.sessionId);
  if (to) {
    setActive(to.sessionId);
    showSession(to.sessionId);
  }
  answerAttention(asks.map((a) => a.id));
}

/** "in 3m" / "now": how long the user has before Henry drops the ask. */
function inTime(deadline: number, now: number): string {
  const m = Math.round((deadline - now) / 60000);
  return m < 1 ? "going now" : m < 60 ? `${m}m left` : `${Math.floor(m / 60)}h left`;
}

function names(list: { title: string }[]): string {
  return list.slice(0, 6).map((s) => s.title).join(", ") + (list.length > 6 ? ", …" : "");
}

/** Today's minutes as this window sees them: what the daemon has recorded, what your prompts
 *  imply, and — since you are looking at this — the minute you are in right now. */
function todayMinutes(human: HumanStats | null, now: number): Minutes {
  if (!human) return new Map();
  const minutes = mergeMinutes(unpackDay(human.dayStart, human.todayMinutes), minutesFromPrompts(human.today, now));
  if (isHere()) minutes.set(minuteOf(now), (minutes.get(minuteOf(now)) ?? 0) | SRC.reading);
  return minutes;
}

export function TopActivity() {
  const sessions = useStore((s) => s.sessions);
  const repos = useStore((s) => s.repos);
  const asks = useStore((s) => s.attention);
  // Your own prompt lands as an event first; refetching on it makes the strip answer instantly.
  const lastPrompt = useStore((s) => s.events.find((e) => e.hookEvent === "UserPromptSubmit")?.id ?? "");
  const [human, setHuman] = useState<HumanStats | null>(null);
  const [open, setOpen] = useState(false);
  const now = useNow(30_000);

  useEffect(() => {
    let on = true;
    fetch("/api/human")
      .then((r) => r.json())
      .then((h: HumanStats) => on && setHuman(h))
      .catch(() => {});
    return () => {
      on = false;
    };
    // The 30 s tick doubles as the poll: a prompt from another window shows up within it.
  }, [lastPrompt, Math.floor(now / 60_000)]);

  const running = sessions.filter((s) => s.status === "running");
  const working = running.filter((s) => s.activity === "working");
  const needs = running.filter((s) => s.activity === "needsInput");
  const waiting = running.filter((s) => s.activity === "waiting");
  // Repos are tracked per session, so the same checkout under two sessions must count once.
  const byPath = new Map<string, RepoState>();
  for (const list of Object.values(repos)) for (const r of list) byPath.set(r.path, r);
  const tracked = [...byPath.values()];
  const dirtyRepos = tracked.filter((r) => r.dirty > 0);
  const dirty = dirtyRepos.reduce((n, r) => n + r.dirty, 0);
  const ahead = tracked.reduce((n, r) => n + r.ahead, 0);

  // Today, recomputed here rather than taken from the payload: the minute you are in counts
  // as soon as you are in it, so "2h 41m" becomes "2h 42m" without waiting for a round trip.
  const fresh = human && human.dayStart === startOfDay(now) ? human : null;
  const today = fresh?.today ?? [];
  const minutes = todayMinutes(fresh, now);
  const me = presence(minutes, today);
  const counts = bucket(today, now);
  const busy = minutes.size > 0;

  useAskTitle();

  const title = (s: Session | undefined) => s?.title ?? "a session";

  return (
    <div className="topbar-act">
      {asks.length > 0 && (
        <button className="act-chip asking" onClick={() => answer(asks)}
          title={`${asks.map((a) => `${title(sessions.find((s) => s.id === a.sessionId))}: ${a.message} (${inTime(a.deadline, now)})`).join("\n")}\nclick: go there, and tell the session${asks.length > 1 ? "s" : ""} you have seen it`}>
          <span className="dot" />
          {/* One ask says its piece; several are a count, since the bar has room for one sentence. */}
          <span className="msg">{asks.length === 1 ? asks[0]!.message : `${asks.length} asks for you`}</span>
        </button>
      )}
      {working.length > 0 && (
        <button className="act-chip working" onClick={() => jump(working)} title={`working now: ${names(working)}`}>
          <span className="dot" />
          {working.length} working
        </button>
      )}
      {needs.length > 0 && (
        <button className="act-chip needs" onClick={() => jump(needs)} title={`blocked on a prompt: ${names(needs)}`}>
          {needs.length} needs you
        </button>
      )}
      {waiting.length > 0 && (
        <button className="act-chip waiting" onClick={() => jump(waiting)} title={`turn is over, your move: ${names(waiting)}`}>
          {waiting.length} waiting
        </button>
      )}
      {dirty > 0 && (
        <button className="act-chip dirty" onClick={() => showTool("repos")}
          title={`${dirty} uncommitted path${dirty === 1 ? "" : "s"} across ${dirtyRepos.length} repo${dirtyRepos.length === 1 ? "" : "s"}: ${names(dirtyRepos.map((r) => ({ title: r.name })))}${ahead ? `\n${ahead} commit${ahead === 1 ? "" : "s"} not pushed` : ""}`}>
          ±{dirty}
          {ahead > 0 && <span className="ahead"> ↑{ahead}</span>}
        </button>
      )}
      {me.activeMs > 0 && (
        <>
          <span className="act-sep" />
          <button className="act-chip you" onClick={() => setOpen((o) => !o)}
            title={`${dur(me.activeMs)} here today, since ${clock(me.firstAt!)} — ${dur(me.readingMs)} of it reading and moving around rather than typing\nlongest stretch ${dur(me.longestMs)} · ${me.stretches} sit-down${me.stretches === 1 ? "" : "s"}\nclick for the fortnight`}>
            ⏱ {dur(me.activeMs)}
          </button>
          <button className="act-chip you" onClick={() => setOpen((o) => !o)}
            title={`${me.prompts} prompt${me.prompts === 1 ? "" : "s"} sent today, one every ${gap(me.medianGapMs)} while you were here\nclick for the fortnight`}>
            ✎ {me.prompts}
          </button>
          {busy && (
            <button className="act-chip cadence" onClick={() => setOpen((o) => !o)}
              title={`your last 4 h, in 10-minute bars — cadence right now is one prompt every ${gap(me.medianGapMs)}\nclick for the week`}>
              <svg viewBox={`0 0 ${BUCKETS} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden>
                {counts.map((n, i) => {
                  if (!n) return null;
                  const h = Math.max(1.5, SPARK_H * Math.min(1, Math.sqrt(n / 4)));
                  return <rect key={i} className={i === BUCKETS - 1 ? "bar now" : "bar"} x={i + 0.1} y={SPARK_H - h} width={0.8} height={h} />;
                })}
              </svg>
              {gap(me.medianGapMs)}
            </button>
          )}
        </>
      )}
      {open && human && (
        <>
          <div className="pop-bg" onClick={() => setOpen(false)} />
          <div className="pop you-pop">
            <You human={human} minutes={minutes} now={now} />
          </div>
        </>
      )}
    </div>
  );
}

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

/** The popover: today in detail, today's shape by the hour, and the fortnight behind it. */
function You({ human, minutes, now }: { human: HumanStats; minutes: Minutes; now: number }) {
  const me = presence(minutes, human.today);
  const sessionsToday = human.days.find((d) => d.dayStart === human.dayStart)?.sessions ?? 0;

  // Hour of day, in minutes present, split by what you were doing with them: where your day
  // actually sits, not where you think it sits.
  const hours = Array.from({ length: 24 }, () => ({ all: 0, typed: 0 }));
  for (const [m, mask] of minutes) {
    const h = hours[new Date(m).getHours()]!;
    h.all++;
    if (mask & (SRC.prompt | SRC.terminal)) h.typed++;
  }
  const peakHour = hours.reduce((best, h, i) => (h.all > hours[best]!.all ? i : best), 0);
  const peakHourMinutes = Math.max(1, ...hours.map((h) => h.all));

  // Every day in the window, including the ones you did not show up (they are the point).
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(human.dayStart);
    d.setDate(d.getDate() - i);
    const key = d.getTime();
    days.push(human.days.find((x) => x.dayStart === key) ?? { dayStart: key, prompts: 0, activeMs: 0, readingMs: 0, longestMs: 0, stretches: 0, sessions: 0 });
  }
  const shown = days.filter((d) => !human.since || d.dayStart + 86_400_000 > human.since);
  const peakMs = Math.max(1, ...shown.map((d) => d.activeMs));
  const total = shown.reduce((n, d) => n + d.activeMs, 0);
  const totalPrompts = shown.reduce((n, d) => n + d.prompts, 0);
  const showedUp = shown.filter((d) => d.activeMs > 0).length;

  return (
    <>
      <h4>you, today</h4>
      <div className="you-grid">
        <span>here</span><b>{dur(me.activeMs)}</b>
        <span>of that, reading</span><b>{dur(me.readingMs)}</b>
        <span>prompts sent</span><b>{me.prompts}</b>
        <span>cadence</span><b>one every {gap(me.medianGapMs)}</b>
        <span>arrived</span><b>{me.firstAt ? clock(me.firstAt) : "–"}</b>
        <span>last touched</span><b>{me.lastAt ? clock(Math.min(me.lastAt, now)) : "–"}</b>
        <span>longest stretch</span><b>{dur(me.longestMs)}</b>
        <span>sit-downs</span><b>{me.stretches}</b>
        <span>sessions</span><b>{sessionsToday}</b>
      </div>

      <h4>your day, by the hour</h4>
      <div className="you-hours">
        {hours.map((h, i) => (
          <span key={i} className={"h" + (h.all ? " on" : "") + (i === peakHour && h.all ? " peak" : "")}
            title={`${i % 12 || 12}${i < 12 ? "am" : "pm"} — ${h.all} min here${h.all ? `, ${h.typed} of them typing` : ""}`}>
            <i style={{ height: `${(h.all / peakHourMinutes) * 100}%` }}>
              <u style={{ height: `${h.all ? (h.typed / h.all) * 100 : 0}%` }} />
            </i>
          </span>
        ))}
      </div>
      <div className="you-axis"><span>12a</span><span>6a</span><span>noon</span><span>6p</span><span>12a</span></div>

      <h4>the last {shown.length} day{shown.length === 1 ? "" : "s"}</h4>
      <div className="you-days">
        {shown.map((d) => (
          <span key={d.dayStart} className={"d" + (d.dayStart === human.dayStart ? " today" : "") + (d.activeMs ? "" : " off")}
            title={`${new Date(d.dayStart).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}\n${d.activeMs ? `${dur(d.activeMs)} here (${dur(d.readingMs)} reading), ${d.prompts} prompts across ${d.sessions} session${d.sessions === 1 ? "" : "s"}` : "you were not here"}`}>
            <i style={{ height: `${d.activeMs ? Math.max(8, (d.activeMs / peakMs) * 100) : 0}%` }} />
            <em>{WEEKDAY[new Date(d.dayStart).getDay()]}</em>
          </span>
        ))}
      </div>
      <div className="dim">
        {dur(total)} over {showedUp} day{showedUp === 1 ? "" : "s"} · {totalPrompts} prompts · about {dur(total / Math.max(1, showedUp))} on a day you show up.
      </div>
      <div className="dim" style={{ marginTop: 6 }}>
        A minute counts when a Henry window is in front of you, when you type into a terminal, or when it sits between two prompts
        less than {Math.round(human.idleMs / 60_000)} min apart. Only the minute is stored, never what was in it. Untouched windows stop
        counting after {Math.round(human.idleMs / 60_000)} min, work outside Henry never counts, and history only reaches as far back as retention keeps.
      </div>
    </>
  );
}
