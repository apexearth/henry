import { useEffect, useState } from "react";
import { isClaudeSession, type Session, type SessionActivity } from "@henry/shared";
import { FilesSection } from "./RailFiles";
import { RepoPicker } from "./RepoPicker";
import { inShell, onMenu } from "./shell";
import { hueText, nameHue } from "./theme";
import { showSession } from "./dock";
import { activeRowIndex, duplicateSession, killSession, railGroups, railRows, resumeSession, setActive, setGroupBy, toggleShowClosed, useStore, type GroupBy } from "./ws";

function base(p: string) {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

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

/** How stale your attention is: only while the session is waiting on you, in three steps
 * (5 min, 15 min, 1 h) so the row fades instead of the label just growing. */
function neglect(s: Session, now: number): 0 | 1 | 2 | 3 {
  if (s.status !== "running" || !s.activity || s.activity === "working") return 0;
  const since = now - (s.lastInputAt ?? s.activitySince ?? now);
  return since >= 60 * 60_000 ? 3 : since >= 15 * 60_000 ? 2 : since >= 5 * 60_000 ? 1 : 0;
}

/** Compact time in state. Blank under a minute: a row that changes every second is noise. */
function since(ts: number | undefined, now: number): string {
  if (!ts) return "";
  const m = Math.floor((now - ts) / 60000);
  if (m < 1) return "";
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

/** Re-render slowly so the "4m" labels age; activity itself arrives over the WS. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

const GROUP_LABEL: Record<GroupBy, string> = {
  none: "no grouping",
  cwd: "by folder",
  repos: "by repo",
  attention: "by attention",
  host: "by machine",
};

export function Rail() {
  const rows = useStore(railRows);
  const here = useStore(activeRowIndex);
  const groups = useStore(railGroups);
  const groupBy = useStore((s) => s.groupBy);
  const sessions = useStore((s) => s.sessions);
  const showClosed = useStore((s) => s.showClosed);
  const active = useStore((s) => s.activeSessionId);
  const flags = useStore((s) => s.flags);
  const [picker, setPicker] = useState(false);
  const now = useNow(15000);

  // In the native shell the File menu owns ⌘N / ⌘D and calls us through onMenu. In a browser tab
  // Chrome keeps ⌘N for itself (new window) and never delivers it, so ⌃N is the one that fires.
  // ⌘D (bookmark) is overridable, so it works in both. ⌃D is EOF in the terminal: never bound.
  useEffect(() => onMenu("new-session", () => setPicker(true)), []);
  useEffect(() => onMenu("duplicate-session", duplicateSession), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.shiftKey) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        setPicker(true);
      } else if (e.metaKey && !e.ctrlKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        duplicateSession();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // The repo sub-label repeats the header under "by folder" / "by repo", so it only shows
  // where it is the row's only repo cue.
  const showSub = groupBy === "none" || groupBy === "attention" || groupBy === "host";
  // The peer chip repeats the header under "by machine".
  const showPeer = groupBy !== "host";
  const unread = (id: string) => flags.filter((f) => f.sessionId === id && !f.read);
  // Counted off the sessions themselves: under "by repo" a session can appear in several groups.
  const running = sessions.filter((s) => s.status === "running").length;
  const closed = sessions.length - running;
  const needsInput = sessions.filter((s) => s.activity === "needsInput" && s.status === "running").length;
  const working = sessions.filter((s) => s.activity === "working" && s.status === "running").length;

  return (
    <div className="rail">
      <div className="rail-list">
        {groups.map((g) => (
          <div key={g.key} className="rail-group">
            {g.label && (
              <div className="rail-group-h" title={g.title}>
                <span className="name" style={g.hue !== undefined ? { color: hueText(g.hue) } : undefined}>{g.label}</span>
                <span className="n">{g.sessions.length}</span>
              </div>
            )}
            {g.sessions.map((s: Session) => {
              const u = unread(s.id);
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
              const ago = on && s.activity ? since(s.activity === "working" ? s.activitySince : s.lastInputAt ?? s.activitySince, now) : "";
              const typed = on && claude ? since(s.lastInputAt, now) : "";
              const nPrompts = on && claude ? bucketPrompts(s.prompts, now).reduce((a, b) => a + b, 0) : 0;
              const yours = on && claude ? `\nyou: ${nPrompts} prompt${nPrompts === 1 ? "" : "s"} in the last 4 h${typed ? `, last typed ${typed} ago` : s.lastInputAt ? ", typing now" : ""}` : "";
              const fade = neglect(s, now);
              return (
                <div key={g.key + "\n" + s.id} className={"rail-item" + mark + (on ? "" : " off") + (fade ? " neglect-" + fade : "")} onClick={() => { setActive(s.id, g.key); showSession(s.id); }}
                  title={`${what}, ${state}${on && s.activity ? ` — ${ACTIVITY_TEXT[s.activity]}${ago && s.activity === "working" ? ` for ${ago}` : ""}` : ""}${yours}\n${s.cwd}${s.peer ? `\non ${s.peer} (remote, via its own Henry daemon)` : s.host ? `\non ${s.host}` : ""}${i >= 0 && i < 9 ? `\n⌘${i + 1}` : ""}`}>
                  {on && claude && <Spark prompts={s.prompts} now={now} />}
                  {claude ? <ClaudeMark on={on} activity={on ? s.activity : undefined} /> : <ShellMark on={on} />}
                  <span className="title">{s.title}</span>
                  {s.title !== repo && showSub && <span className="sub" style={{ color: hueText(nameHue(repo)) }}>{repo}</span>}
                  {s.peer && showPeer && <span className="peer" style={{ color: hueText(nameHue(s.peer)), borderColor: hueText(nameHue(s.peer)) }}>{s.peer}</span>}
                  {ago && <span className={"act act-" + s.activity}>{ago}</span>}
                  {u.length > 0 && <span className={"badge flag" + (hasAlarm ? " alarm" : "")}>⚑ {u.length}</span>}
                  {!on && s.claudeSessionId && !external && (
                    <button className="close" title="resume this Claude session in a new tab"
                      onClick={(e) => { e.stopPropagation(); resumeSession(s); }}>↻</button>
                  )}
                  <button className="close" title={on ? "kill session" : "close"}
                    onClick={(e) => { e.stopPropagation(); killSession(s.id); }}>×</button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <FilesSection />
      <div className="rail-new-wrap">
        <button className="rail-new" title={`new session (${inShell ? "⌘N" : "⌃N"})`} onClick={() => setPicker(true)}>+ new session</button>
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
      {picker && <RepoPicker onClose={() => setPicker(false)} />}
    </div>
  );
}
