// A topic up close (daemon/topics.ts): its name, the brief its members are shown, the notes, who
// is in it, and its coordinator. Also the "new topic" form, which is the same modal with a name.
// A topic lives on one machine with its coordinator; its members may be on any machine linked
// with that one both ways. A paired machine's topic is driven from here through the link.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { showSession } from "./dock";
import { hueText, nameHue } from "./theme";
import { closeTopic, createTopic, renameTopic, setActive, setTopicBrief, startCoordinator, useStore } from "./ws";

const st: Record<string, CSSProperties> = {
  body: { padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" },
  label: { color: "var(--fg-dim)", fontSize: 11, marginBottom: 4 },
  input: { width: "100%", boxSizing: "border-box", margin: 0 },
  brief: { width: "100%", boxSizing: "border-box", minHeight: 140, resize: "vertical", font: "inherit", fontSize: 12, padding: "6px 8px", background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 4 },
  note: { color: "var(--fg-dim)", fontSize: 11 },
  list: { display: "flex", flexDirection: "column", gap: 2 },
  member: { display: "flex", gap: 8, alignItems: "baseline", background: "none", border: "none", padding: "2px 0", color: "var(--fg)", textAlign: "left", cursor: "pointer" },
};

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? "just now" : m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

export function NewTopic({ sessionId, onClose }: { sessionId?: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const session = useStore((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined));
  const activePeer = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.peer);
  const localHost = useStore((s) => s.host);
  const peers = useStore((s) => s.peers);
  const machines = useMemo(() => peers.filter((p) => p.link === "connected").map((p) => p.name), [peers]);
  // With a session it is that session's machine; otherwise the one you are looking at, to start.
  const [picked, setPicked] = useState<string | undefined>(activePeer);
  const peer = session ? session.peer : picked && machines.includes(picked) ? picked : undefined;
  // Names are unique per machine, which is where the daemon checks them.
  const taken = useStore((s) => s.topics.some((t) => t.peer === peer && t.name.toLowerCase() === name.trim().toLowerCase()));
  const ok = !!name.trim() && !taken;
  const create = () => {
    if (!ok) return;
    createTopic(name.trim(), sessionId, peer);
    onClose();
  };
  const where = peer ?? localHost ?? "this machine";
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h3>New topic</h3>
        {!session && machines.length > 0 && (
          <div className="picker-machines" role="radiogroup" aria-label="machine">
            <span className="hint">on</span>
            {[undefined, ...machines].map((m) => (
              <button key={m ?? ""} className={"chip" + (peer === m ? " sel" : "")} onClick={() => setPicked(m)}
                style={m ? { color: hueText(nameHue(m)) } : undefined} title={m ? `the coordinator and the topic's sessions run on ${m}` : "the coordinator and the topic's sessions run here"}>
                {m ?? localHost ?? "this machine"}
              </button>
            ))}
          </div>
        )}
        <div style={st.body}>
          <input className="picker-input" style={st.input} autoFocus spellCheck={false} placeholder="what these sessions are working on"
            value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
          <div style={st.note}>
            {taken ? `There is already a topic by that name on ${where}.` : `A coordinator starts with it on ${where}, in its own tab.${session ? ` "${session.title}" joins it straight away.` : ""} It sees what the topic's sessions are doing, on ${where} or a machine paired with it both ways, never their code, and keeps a brief they are shown.`}
          </div>
        </div>
        <div className="foot">
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>Cancel</button>
          <button onClick={create} disabled={!ok}>Create</button>
        </div>
      </div>
    </div>
  );
}

export function TopicModal({ topicId, onClose }: { topicId: string; onClose: () => void }) {
  const topic = useStore((s) => s.topics.find((t) => t.id === topicId));
  const sessions = useStore((s) => s.sessions);
  const host = useStore((s) => s.host);
  const [name, setName] = useState(topic?.name ?? "");
  const [brief, setBrief] = useState(topic?.brief ?? "");
  const [closing, setClosing] = useState(false);
  // A coordinator rewriting the brief while it is open: take the new text unless you are mid-edit.
  const [base, setBase] = useState(topic?.brief ?? "");
  useEffect(() => {
    if (!topic || topic.brief === base) return;
    if (brief === base) setBrief(topic.brief);
    setBase(topic.brief);
  }, [topic?.brief]);
  useEffect(() => {
    if (!topic) onClose();
  }, [!topic]);
  if (!topic) return null;

  // Members may be on any machine linked with the topic's; the coordinator is on the topic's own.
  const members = sessions.filter((s) => s.topicId === topic.id && !s.coordinator);
  const coordinator = sessions.find((s) => s.topicId === topic.id && s.peer === topic.peer && s.coordinator && s.status === "running");
  const dirty = brief.trim() !== topic.brief || (name.trim() && name.trim() !== topic.name);
  const save = () => {
    if (brief.trim() !== topic.brief) setTopicBrief(topic.id, brief);
    if (name.trim() && name.trim() !== topic.name) renameTopic(topic.id, name.trim());
    onClose();
  };
  const go = (id: string) => {
    setActive(id);
    showSession(id);
    onClose();
  };

  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal" style={{ width: 560 }} onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
        }}>
        <h3>Topic{topic.peer && <span style={{ ...st.note, fontWeight: "normal", marginLeft: 8, color: hueText(nameHue(topic.peer)) }}>on {topic.peer}</span>}</h3>
        <div style={st.body}>
          <input className="picker-input" style={st.input} spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} aria-label="topic name" />
          <div>
            <div style={st.label}>Brief — what the sessions in this topic are shown on their next prompt after it changes. The coordinator keeps it; you can too.</div>
            <textarea style={st.brief} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="goal, decisions made, who owns which area, what is off-limits" />
          </div>
          {topic.notes.length > 0 && (
            <div>
              <div style={st.label}>Notes</div>
              <div style={st.list}>
                {topic.notes.map((n) => (
                  <div key={n.id} style={{ fontSize: 12 }}>
                    {n.text} <span style={st.note}>{ago(n.ts)}{n.expiresAt ? `, until ${new Date(n.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <div style={st.label}>Sessions ({members.length})</div>
            <div style={st.list}>
              {members.length === 0 && <div style={st.note}>None yet. Right-click a session in the rail to add it.</div>}
              {members.map((s) => (
                <button key={s.id} style={st.member} onClick={() => go(s.id)}>
                  <span>{s.title}</span>
                  {s.peer !== topic.peer && <span style={{ ...st.note, color: hueText(nameHue(s.peer ?? host ?? "")) }}>on {s.peer ?? host ?? "this machine"}</span>}
                  <span style={st.note}>{s.status === "running" ? s.activity ?? "" : "exited"}</span>
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {coordinator
              ? <button onClick={() => go(coordinator.id)}>open the coordinator</button>
              : <><span style={st.note}>No coordinator is running.</span><button onClick={() => startCoordinator(topic.id)}>start one</button></>}
          </div>
        </div>
        <div className="foot">
          {closing
            ? <button onClick={() => { closeTopic(topic.id); onClose(); }} title="the coordinator exits; the sessions keep running, in no topic">close it: yes</button>
            : <button onClick={() => setClosing(true)}>close topic…</button>}
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>Cancel</button>
          <button onClick={save} disabled={!dirty}>Save</button>
        </div>
      </div>
    </div>
  );
}
