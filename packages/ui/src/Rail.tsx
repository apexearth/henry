import { useEffect, useState } from "react";
import { isClaudeSession, type Session, type SessionActivity } from "@henry/shared";
import { RepoPicker } from "./RepoPicker";
import { inShell, onMenu } from "./shell";
import { showSession } from "./dock";
import { killSession, railGroups, railOrder, resumeSession, setActive, setGroupBy, toggleShowClosed, useStore, type GroupBy } from "./ws";

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
};

export function Rail() {
  const list = useStore(railOrder);
  const groups = useStore(railGroups);
  const groupBy = useStore((s) => s.groupBy);
  const sessions = useStore((s) => s.sessions);
  const showClosed = useStore((s) => s.showClosed);
  const active = useStore((s) => s.activeSessionId);
  const flags = useStore((s) => s.flags);
  const [picker, setPicker] = useState(false);
  const now = useNow(15000);

  // In the native shell the File menu owns ⌘N and calls us through onMenu. In a browser tab
  // Chrome keeps ⌘N for itself (new window) and never delivers it, so ⌃N is the one that fires.
  useEffect(() => onMenu("new-session", () => setPicker(true)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key !== "n" && e.key !== "N") return;
      e.preventDefault();
      setPicker(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

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
                <span className="name">{g.label}</span>
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
              const i = list.indexOf(s);
              const what = external ? "Claude Code, started outside Henry" : s.kind === "shell" ? (claude ? "terminal, Claude Code running in it" : "terminal") : "Claude Code";
              const state = on ? "running" : `exited${s.exitCode !== undefined ? ` (${s.exitCode})` : ""}${s.endedAt ? ` ${new Date(s.endedAt).toLocaleString()}` : ""}`;
              const ago = on && s.activity ? since(s.activitySince, now) : "";
              return (
                <div key={g.key + "\n" + s.id} className={"rail-item" + (s.id === active ? " active" : "") + (on ? "" : " off")} onClick={() => { setActive(s.id); showSession(s.id); }}
                  title={`${what}, ${state}${on && s.activity ? ` — ${ACTIVITY_TEXT[s.activity]}${ago ? ` for ${ago}` : ""}` : ""}\n${s.cwd}${s.host ? `\non ${s.host}` : ""}${i >= 0 && i < 9 ? `\n⌘${i + 1}` : ""}`}>
                  {claude ? <ClaudeMark on={on} activity={on ? s.activity : undefined} /> : <ShellMark on={on} />}
                  <span className="title">{s.title}</span>
                  {s.title !== repo && <span className="sub">{repo}</span>}
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
      <button className="rail-new" title={`new session (${inShell ? "⌘N" : "⌃N"})`} onClick={() => setPicker(true)}>+ new</button>
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
