import { useState } from "react";
import { isClaudeSession, type Session } from "@henry/shared";
import { RepoPicker } from "./RepoPicker";
import { showSession } from "./dock";
import { killSession, railOrder, resumeSession, setActive, toggleShowClosed, useStore } from "./ws";

function base(p: string) {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

/** Clawd in twelve pixels: body, two eyes, two legs. Solid while running, an outline once exited. */
function ClaudeMark({ on }: { on: boolean }) {
  return (
    <svg className={"mark claude" + (on ? " on" : "")} viewBox="0 0 12 12" width="14" height="14" aria-hidden>
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

export function Rail() {
  const list = useStore(railOrder);
  const total = useStore((s) => s.sessions.length);
  const showClosed = useStore((s) => s.showClosed);
  const active = useStore((s) => s.activeSessionId);
  const flags = useStore((s) => s.flags);
  const [picker, setPicker] = useState(false);

  const unread = (id: string) => flags.filter((f) => f.sessionId === id && !f.read);
  const running = list.filter((s) => s.status === "running").length;
  const closed = total - running;

  return (
    <div className="rail">
      <div className="rail-list">
        {list.map((s: Session, i) => {
          const u = unread(s.id);
          const hasAlarm = u.some((f) => f.severity === "alarm");
          const claude = isClaudeSession(s);
          const external = s.command === "external";
          const on = s.status === "running";
          const repo = base(s.cwd);
          const what = external ? "Claude Code, started outside Henry" : s.kind === "shell" ? (claude ? "terminal, Claude Code running in it" : "terminal") : "Claude Code";
          const state = on ? "running" : `exited${s.exitCode !== undefined ? ` (${s.exitCode})` : ""}${s.endedAt ? ` ${new Date(s.endedAt).toLocaleString()}` : ""}`;
          return (
            <div key={s.id} className={"rail-item" + (s.id === active ? " active" : "") + (on ? "" : " off")} onClick={() => { setActive(s.id); showSession(s.id); }}
              title={`${what}, ${state}\n${s.cwd}${s.host ? `\non ${s.host}` : ""}${i < 9 ? `\n⌘${i + 1}` : ""}`}>
              {claude ? <ClaudeMark on={on} /> : <ShellMark on={on} />}
              <span className="title">{s.title}</span>
              {s.title !== repo && <span className="sub">{repo}</span>}
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
      <button className="rail-new" onClick={() => setPicker(true)}>+ new</button>
      <div className="rail-foot">
        <span>{running} running</span>
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
