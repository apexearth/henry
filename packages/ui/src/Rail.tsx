import { useEffect, useState } from "react";
import { isClaudeSession, type Session, type SessionActivity } from "@henry/shared";
import { RepoPicker } from "./RepoPicker";
import { MOD, baseName, isMac } from "./platform";
import { inShell, onMenu } from "./shell";
import { hueText, nameHue } from "./theme";
import { popOutSession, showSession } from "./dock";
import { isPoppedOut, usePoppedOut } from "./popout";
import { markUnread } from "./seen";
import { activeRowIndex, answerAttention, busy, canFork, duplicateSession, forkSession, hiddenCount, hideSessions, isUnseen, killSession, markSeen, railGroups, railRows, remindSession, resumeSession, setActive, setGroupBy, showAllSessions, terminalHere, toggleMachine, toggleShowClosed, useStore, type GroupBy } from "./ws";

const base = baseName;

/** Clawd in twelve pixels: body, two eyes, two legs. Solid while running, an outline once exited. */
function ClaudeMark({ on, activity }: { on: boolean; activity?: SessionActivity }) {
  return (
    <svg className={"mark claude" + (on ? " on" : "") + (activity ? " act-" + activity : "")} viewBox="0 0 12 12" width="14" height="14" aria-hidden>
      <rect className="body" x="1.5" y="1.5" width="9" height="7" rx="1.2" />
      <rect className="leg" x="2.5" y="8.5" width="2" height="2.5" />
      <rect className="leg" x="7.5" y="8.5" width="2" height="2.5" />
      <rect className="eye" x="4" y="3.8" width="1.2" height="2.4" />
      <rect className="eye" x="6.8" y="3.8" width="1.2" height="2.4" />
    </svg>
  );
}

function ShellMark({ on }: { on: boolean }) {
  return <span className={"mark shell" + (on ? " on" : "")} aria-hidden>&gt;_</span>;
}

const ACTIVITY_TEXT: Record<SessionActivity, string> = {
  working: "working",
  needsInput: "needs your answer",
  background: "waiting on its background work",
  waiting: "waiting for you",
  idle: "idle",
};

/** Prompt sparkline drawn across the whole row's background: 4 h in 15-minute bars, one
 * series, so it is faint ink under the text with the current bucket in the accent. Bar
 * height is sqrt(count) so one burst does not flatten the rest of the strip. */
const SPARK_BUCKETS = 16;
const SPARK_BUCKET_MS = 15 * 60_000;
const SPARK_FULL = 6;
const SPARK_H = 10;

export function bucketPrompts(prompts: number[] | undefined, now: number): number[] {
  const counts = new Array<number>(SPARK_BUCKETS).fill(0);
  const start = now - SPARK_BUCKETS * SPARK_BUCKET_MS;
  for (const t of prompts ?? []) {
    if (t < start || t > now) continue;
    counts[Math.min(SPARK_BUCKETS - 1, Math.floor((t - start) / SPARK_BUCKET_MS))]!++;
  }
  return counts;
}

function Spark({ prompts, now }: { prompts: number[] | undefined; now: number }) {
  const counts = bucketPrompts(prompts, now);
  if (!counts.some(Boolean)) return null;
  // Unit-per-bucket viewBox stretched to the row (preserveAspectRatio none), so the strip
  // fills whatever width the rail has; a 0.15 unit gap keeps adjacent bars apart.
  return (
    <svg className="spark" viewBox={`0 0 ${SPARK_BUCKETS} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden>
      {counts.map((n, i) => {
        if (!n) return null;
        // Anchored to the row's midline, growing both ways, so the strip reads as a symmetric pulse.
        const h = Math.max(1, SPARK_H * Math.min(1, Math.sqrt(n / SPARK_FULL)));
        return <rect key={i} className={i === SPARK_BUCKETS - 1 ? "bar now" : "bar"} x={i + 0.075} y={(SPARK_H - h) / 2} width={0.85} height={h} />;
      })}
    </svg>
  );
}

/** When you were last with the session: typed into it, or had it in view. */
const lastWith = (s: Session): number | undefined => Math.max(s.lastInputAt ?? 0, s.lastSeenAt ?? 0) || undefined;

/** How long you have left a session waiting on you, in three steps (1 h, 3 h, 8 h) so the row
 * fades instead of the label just growing. Looking counts as much as typing: the sessions you
 * have been with this past hour are your working set, answered or not, and stay bright. */
function neglect(s: Session, now: number): 0 | 1 | 2 | 3 {
  // Unseen work stays bright: fading is for what you have seen and left, not what you missed.
  if (s.status !== "running" || !s.activity || busy(s) || isUnseen(s)) return 0;
  const since = now - (lastWith(s) ?? s.activitySince ?? now);
  return since >= 8 * 60 * 60_000 ? 3 : since >= 3 * 60 * 60_000 ? 2 : since >= 60 * 60_000 ? 1 : 0;
}

/** How long an ask has left before Henry drops it. */
function until(deadline: number, now: number): string {
  const m = Math.round((deadline - now) / 60000);
  return m < 1 ? "going now" : m < 60 ? `${m}m left` : `${Math.floor(m / 60)}h left`;
}

/** Compact time in state. Blank under a minute: a row that changes every second is noise. */
function since(ts: number | undefined, now: number): string {
  if (!ts) return "";
  const m = Math.floor((now - ts) / 60000);
  if (m < 1) return "";
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

/** A reminder's time: the clock today, the weekday and clock after that. */
function clock(ts: number, now: number): string {
  const d = new Date(ts);
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? t : `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
}

/** The right-click menu's reminder choices, as a time from now. */
const REMIND: [label: string, at: (now: number) => number][] = [
  ["in 15 minutes", (now) => now + 15 * 60_000],
  ["in 1 hour", (now) => now + 60 * 60_000],
  ["in 3 hours", (now) => now + 3 * 60 * 60_000],
  ["tomorrow at 9:00", (now) => {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  }],
];

/** Re-render slowly so the "4m" labels age; activity itself arrives over the WS. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

const FORK_KEY = isMac ? "⌘⇧D" : "Alt+Shift+D";

/** A rail row's right-click menu: read / unread, a fork, and a reminder to come back. */
function RowMenu({ x, y, session, now, onClose }: { x: number; y: number; session: Session; now: number; onClose: () => void }) {
  // The row's session as the store has it now, not as it was when the menu opened.
  const s = useStore((st) => st.sessions.find((v) => v.id === session.id)) ?? session;
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <>
      <div className="pop-bg" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="pop files-menu rail-menu" style={{ left: x, top: y }}>
        {isUnseen(s)
          ? <button onClick={act(() => markSeen(s.id, true))}>mark as read</button>
          : <button onClick={act(() => markUnread(s.id))}>mark as unread</button>}
        <button onClick={act(() => popOutSession(s.id))}>{isPoppedOut(s.id) ? "bring its window forward" : "open in its own window"}</button>
        {canFork(s) && (
          <button onClick={act(() => forkSession(s))} title="a new tab that starts from a copy of this conversation; this one carries on untouched">
            fork into a new tab ({FORK_KEY})
          </button>
        )}
        <div className="menu-sep" />
        {REMIND.map(([label, at]) => (
          <button key={label} onClick={act(() => remindSession(s.id, at(Date.now())))} title="it leaves the unread pile now and comes back, with a notification, then">
            remind me {label}
          </button>
        ))}
        {s.remindAt !== undefined && (
          <button onClick={act(() => remindSession(s.id, null))}>cancel the reminder at {clock(s.remindAt, now)}</button>
        )}
      </div>
    </>
  );
}

const GROUP_LABEL: Record<GroupBy, string> = {
  none: "no grouping",
  cwd: "by folder",
  repos: "by repo",
  attention: "by attention",
};

/**
 * The left pane: the session list, and the window-wide session bindings. ⌘N, ⌘D and ⌃` live
 * here rather than in `Rail` so they are one mount, not one per render of the list.
 */
export function LeftPane() {
  const [picker, setPicker] = useState(false);

  // In the macOS shell the File menu owns ⌘N / ⌘D and calls us through onMenu; the Windows shell
  // has no menu, so Ctrl+N lands here like in a tab (WebView2 reserves nothing). In a browser tab
  // Chrome keeps ⌘N for itself (new window) and never delivers it, so ⌃N is the one that fires.
  // ⌘D (bookmark) is overridable, so it works in both. ⌃D is EOF in the terminal: never bound.
  // Off macOS Chrome reserves Ctrl+N too, so Alt+N opens the picker there, and Ctrl+Shift+D duplicates.
  // Fork is ⌘⇧D on macOS; off it Ctrl+Shift+D is taken, so Alt+Shift+D.
  // ⌘` is the macOS window-cycling chord: the shell's menu item claims it, but a browser tab never
  // sees it, so ⌃` stands in there. Off macOS nothing reserves Ctrl+`, and the terminal makes no
  // control character out of it, so it is bound everywhere.
  useEffect(() => onMenu("new-session", () => setPicker(true)), []);
  useEffect(() => onMenu("duplicate-session", duplicateSession), []);
  useEffect(() => onMenu("new-terminal", terminalHere), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = e.key === "n" || e.key === "N";
      const d = e.key === "d" || e.key === "D";
      const tick = e.code === "Backquote" || e.key === "`";
      if (n && !e.shiftKey && ((e.metaKey || e.ctrlKey) && !e.altKey || (!isMac && e.altKey && !e.ctrlKey && !e.metaKey))) {
        e.preventDefault();
        setPicker(true);
      } else if (d && !e.altKey && (isMac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey)) {
        e.preventDefault();
        duplicateSession();
      } else if (d && e.shiftKey && !e.ctrlKey && (isMac ? e.metaKey && !e.altKey : e.altKey && !e.metaKey)) {
        e.preventDefault();
        forkSession();
      } else if (tick && !e.altKey && !e.shiftKey && (isMac ? e.metaKey !== e.ctrlKey : e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        terminalHere();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <>
      <Rail onNew={() => setPicker(true)} />
      {picker && <RepoPicker onClose={() => setPicker(false)} />}
    </>
  );
}

function Rail({ onNew }: { onNew: () => void }) {
  const rows = useStore(railRows);
  const here = useStore(activeRowIndex);
  const groups = useStore(railGroups);
  const groupBy = useStore((s) => s.groupBy);
  const host = useStore((s) => s.host);
  const sessions = useStore((s) => s.sessions);
  const showClosed = useStore((s) => s.showClosed);
  const hidden = useStore(hiddenCount);
  const active = useStore((s) => s.activeSessionId);
  const flags = useStore((s) => s.flags);
  const attention = useStore((s) => s.attention);
  const now = useNow(15000);
  const [menu, setMenu] = useState<{ x: number; y: number; session: Session } | null>(null);
  const out = usePoppedOut();

  // The repo sub-label repeats the header under "by folder" / "by repo", so it only shows
  // where it is the row's only repo cue.
  const showSub = groupBy === "none" || groupBy === "attention";
  // Machines are delimited only once a paired machine's sessions are listed; on its own,
  // this machine's list has no header to carry.
  const relayed = groups.some((g) => g.peer);
  const machineCount = (peer: string | undefined) => new Set(groups.filter((g) => g.peer === peer).flatMap((g) => g.sessions.map((x) => x.id))).size;
  const unread = (id: string) => flags.filter((f) => f.sessionId === id && !f.read);
  const asks = (id: string) => attention.filter((a) => a.sessionId === id);
  // Counted off the sessions themselves: under "by repo" a session can appear in several groups.
  const running = sessions.filter((s) => s.status === "running").length;
  const closed = sessions.length - running;
  const needsInput = sessions.filter((s) => s.activity === "needsInput" && s.status === "running").length;
  const working = sessions.filter((s) => busy(s) && s.status === "running").length;

  return (
    <div className="rail">
      {hidden > 0 && (
        <div className="rail-hidden">
          <span>{hidden} session{hidden === 1 ? "" : "s"} hidden</span>
          <button className="rail-toggle" onClick={showAllSessions} title="bring every hidden session back into the list">show all</button>
        </div>
      )}
      <div className="rail-list">
        {groups.map((g, gi) => (
          <div key={g.key} className="rail-group">
            {relayed && (gi === 0 || groups[gi - 1]!.peer !== g.peer) && (
              <button className={"rail-machine-h" + (g.peer ? " remote" : "")}
                onClick={() => toggleMachine(g.peer)}
                title={`${g.peer ? `sessions on ${g.peer} (remote, via its own Henry daemon)` : "sessions on this machine"} — click to ${g.hidden ? "show" : "hide"} them`}>
                <span className="name" style={g.peer ? { color: hueText(nameHue(g.peer)) } : undefined}>{g.peer ?? host ?? "this machine"}</span>
                <span className="n">{machineCount(g.peer)}</span>
                <span className="fold" aria-hidden>{g.hidden ? "▸" : "▾"}</span>
              </button>
            )}
            {g.label && (
              <div className="rail-group-h" title={g.title}>
                <span className="name" style={g.hue !== undefined ? { color: hueText(g.hue) } : undefined}>{g.label}</span>
                <span className="n">{g.sessions.length}</span>
                <button className="hide" title={"hide " + (g.sessions.length === 1 ? "this session" : "these " + g.sessions.length + " sessions") + " — they leave the rail everywhere, not just here"}
                  onClick={() => hideSessions(g.sessions.map((x) => x.id))}>⊘</button>
              </div>
            )}
            {!g.hidden && g.sessions.map((s: Session) => {
              const u = unread(s.id);
              const ask = asks(s.id);
              const hasAlarm = u.some((f) => f.severity === "alarm");
              const claude = isClaudeSession(s);
              const external = s.command === "external";
              const on = s.status === "running";
              const repo = base(s.cwd);
              const i = rows.findIndex((r) => r.group === g.key && r.session === s);
              // The row you are on gets the full mark; the same session listed under another
              // repo is an echo, marked at half strength so ⌘↑/↓ has one obvious "here".
              const mark = i === here ? " active" : s.id === active ? " echo" : "";
              const what = external ? "Claude Code, started outside Henry" : s.kind === "shell" ? (claude ? "terminal, Claude Code running in it" : "terminal") : "Claude Code";
              const state = on ? "running" : `exited${s.exitCode !== undefined ? ` (${s.exitCode})` : ""}${s.endedAt ? ` ${new Date(s.endedAt).toLocaleString()}` : ""}`;
              // Working: time in state. Waiting on you: time since you typed, which is what neglect is.
              const ago = on && s.activity ? since(busy(s) ? s.activitySince : s.lastInputAt ?? s.activitySince, now) : "";
              const typed = on && claude ? since(s.lastInputAt, now) : "";
              const nPrompts = on && claude ? bucketPrompts(s.prompts, now).reduce((a, b) => a + b, 0) : 0;
              const yours = on && claude ? `\nyou: ${nPrompts} prompt${nPrompts === 1 ? "" : "s"} in the last 4 h${typed ? `, last typed ${typed} ago` : s.lastInputAt ? ", typing now" : ""}${s.lastSeenAt ? `, last looked ${since(s.lastSeenAt, now) ? `${since(s.lastSeenAt, now)} ago` : "just now"}` : ""}` : "";
              const fade = neglect(s, now);
              const fresh = isUnseen(s);
              const remindAt = on ? s.remindAt : undefined;
              // The parent's title when it is still listed; a fork outliving it still says it is one.
              const forkedFrom = s.parentSessionId ? sessions.find((x) => x.id === s.parentSessionId)?.title ?? "an earlier session" : undefined;
              return (
                <div key={g.key + "\n" + s.id} className={"rail-item" + mark + (on ? "" : " off") + (fade ? " neglect-" + fade : "") + (ask.length ? " asking" : "") + (fresh ? " unseen" : "")} onClick={() => { setActive(s.id, g.key); showSession(s.id); }}
                  onContextMenu={(e) => {
                    // Exited rows have nothing to mark: the browser's own menu stays.
                    if (!on) return;
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, session: s });
                  }}
                  title={`${ask.map((a) => `asking you: ${a.message} (${until(a.deadline, now)})\n`).join("")}${fresh ? `not seen yet${since(s.unseenSince, now) ? `, for ${since(s.unseenSince, now)}` : ""}\n` : ""}${remindAt ? `reminder at ${clock(remindAt, now)}\n` : ""}${forkedFrom ? `forked from ${forkedFrom}\n` : ""}${what}, ${state}${on && s.activity ? ` — ${ACTIVITY_TEXT[s.activity]}${ago && busy(s) ? ` for ${ago}` : ""}` : ""}${yours}\n${s.cwd}${s.peer ? `\non ${s.peer} (remote, via its own Henry daemon)` : s.host ? `\non ${s.host}` : ""}${i >= 0 && i < 9 ? `\n${MOD}${i + 1}` : ""}${on ? `\nright click: mark unread, ${canFork(s) ? "fork, " : ""}remind me later` : ""}`}>
                  {on && claude && <Spark prompts={s.prompts} now={now} />}
                  {/* Idle greys Clawd only once the row has begun to fade: in your working set it is still your move. */}
                  {claude ? <ClaudeMark on={on} activity={on ? (s.activity === "idle" && !fade ? "waiting" : s.activity) : undefined} /> : <ShellMark on={on} />}
                  {fresh && <span className="unseen-dot" aria-label="not seen yet" />}
                  {forkedFrom && <span className="forked" aria-label={`forked from ${forkedFrom}`}>⑂</span>}
                  <span className="title">{s.title}</span>
                  {s.title !== repo && showSub && <span className="sub" style={{ color: hueText(nameHue(repo)) }}>{repo}</span>}
                  {/* The time is in the tooltip: the rail is narrow and the title matters more. */}
                  {remindAt && <span className="remind" aria-label={`reminder at ${clock(remindAt, now)}`}>⏰</span>}
                  {ago && <span className={"act act-" + s.activity}>{ago}</span>}
                  {ask.length > 0 && (
                    <button className="badge ask" title={`${ask.map((a) => `“${a.message}” — ${until(a.deadline, now)}`).join("\n")}\nclick: open it and tell the session you have seen it`}
                      onClick={(e) => { e.stopPropagation(); setActive(s.id, g.key); showSession(s.id); answerAttention(ask.map((a) => a.id)); }}>
                      ❗{ask.length > 1 ? ` ${ask.length}` : ""}
                    </button>
                  )}
                  {u.length > 0 && <span className={"badge flag" + (hasAlarm ? " alarm" : "")}>⚑ {u.length}</span>}
                  {!on && s.claudeSessionId && !external && (
                    <button className="close" title="resume this Claude session in a new tab"
                      onClick={(e) => { e.stopPropagation(); resumeSession(s); }}>↻</button>
                  )}
                  {on && (
                    <button className={"close popout" + (out.includes(s.id) ? " out" : "")}
                      title={out.includes(s.id) ? "in its own window: bring that window forward" : "open in its own window; closing that window brings it back here"}
                      onClick={(e) => { e.stopPropagation(); popOutSession(s.id); }}>⧉</button>
                  )}
                  <button className="close hide" title="hide this session from the rail; it keeps running"
                    onClick={(e) => { e.stopPropagation(); hideSessions([s.id]); }}>⊘</button>
                  <button className="close" title={on ? "kill session" : "close"}
                    onClick={(e) => { e.stopPropagation(); killSession(s.id); }}>×</button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {menu && <RowMenu {...menu} now={Date.now()} onClose={() => setMenu(null)} />}
      <div className="rail-new-wrap">
        <button className="rail-new" title={`new session (${isMac ? (inShell ? "⌘N" : "⌃N") : inShell ? "Ctrl+N" : "Alt+N"})`} onClick={onNew}>+ new session</button>
      </div>
      <div className="rail-foot">
        <span title={`${working} working`}>
          {running} running
          {needsInput > 0 && <span className="needs"> · {needsInput} needs you</span>}
        </span>
        <select className="rail-groupby" value={groupBy} title="group the session list" aria-label="group sessions"
          onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
          {(Object.keys(GROUP_LABEL) as GroupBy[]).map((k) => (
            <option key={k} value={k}>{GROUP_LABEL[k]}</option>
          ))}
        </select>
        {closed > 0 && (
          <button className="rail-toggle" onClick={toggleShowClosed} title={showClosed ? "hide exited sessions" : "list exited sessions below, newest first"}>
            {closed} closed {showClosed ? "▾" : "▸"}
          </button>
        )}
      </div>
    </div>
  );
}
