import { useState } from "react";
import type { Session } from "@henry/shared";
import { RepoPicker } from "./RepoPicker";
import { killSession, setActive, useStore } from "./ws";

function base(p: string) {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

export function Rail() {
  const sessions = useStore((s) => s.sessions);
  const active = useStore((s) => s.activeSessionId);
  const repos = useStore((s) => s.repos);
  const flags = useStore((s) => s.flags);
  const connected = useStore((s) => s.connected);
  const [picker, setPicker] = useState(false);

  const unread = (id: string) => flags.filter((f) => f.sessionId === id && !f.read);

  return (
    <div className="rail">
      <div className="rail-head">
        <span>henry</span>
        <span className={"conn" + (connected ? " on" : "")} title={connected ? "connected" : "reconnecting"}>●</span>
      </div>
      <div className="rail-list">
        {sessions.map((s: Session, i) => {
          const u = unread(s.id);
          const hasAlarm = u.some((f) => f.severity === "alarm");
          return (
            <div key={s.id} className={"rail-item" + (s.id === active ? " active" : "")} onClick={() => setActive(s.id)}
              title={`${s.cwd}\n⌘${i + 1}`}>
              <span className={"dot " + s.status} />
              <div style={{ minWidth: 0 }}>
                <div className="title">{s.title}</div>
                <div className="sub">{base(s.cwd)}{s.status === "exited" ? ` · exited ${s.exitCode ?? ""}` : ""}</div>
              </div>
              <button className="close" title={s.status === "running" ? "kill session" : "close"}
                onClick={(e) => { e.stopPropagation(); killSession(s.id); }}>×</button>
              <div className="badges">
                <span className="badge">{repos[s.id]?.length ?? 0} repos</span>
                {u.length > 0 && <span className={"badge flag" + (hasAlarm ? " alarm" : "")}>⚑ {u.length}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <button className="rail-new" onClick={() => setPicker(true)}>+ new</button>
      <div className="rail-foot">
        <span>{sessions.filter((s) => s.status === "running").length} running</span>
        <span title="global playbook: milestone 5">playbook</span>
      </div>
      {picker && <RepoPicker onClose={() => setPicker(false)} />}
    </div>
  );
}
