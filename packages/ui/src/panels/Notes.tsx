// Notes: the handful of things to keep in mind while switching between sessions. Written by
// hand, removed by hand, the same on every paired machine (daemon/notes.ts). A note written while
// looking at a session is about that session: those come first while you are in it, and its
// chip takes you back to it from anywhere else.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Note, Session } from "@henry/shared";
import type { NoteFill } from "../ws";

export interface NotesPanelProps {
  notes: Note[];
  sessions: Session[];
  activeId: string | null;
  /** This machine's name; a note written elsewhere says where. */
  host: string | null;
  onAdd(text: string, about?: string): void;
  onEdit(id: string, text: string): void;
  onRemove(id: string, removed: boolean): void;
  onOpenSession(id: string): void;
  /** The last fill on each machine, by name. */
  fill: Record<string, NoteFill>;
  onFill(): void;
}

const UNDO_MS = 8_000;

const S = {
  add: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 } as CSSProperties,
  input: { width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 44, font: "inherit", lineHeight: 1.4 } as CSSProperties,
  addRow: { display: "flex", gap: 6, alignItems: "center", fontSize: 11, color: "var(--fg-dim)" } as CSSProperties,
  about: { display: "inline-flex", gap: 4, alignItems: "center", minWidth: 0 } as CSSProperties,
  section: { margin: "10px 0 6px", fontSize: 11, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: 0.5 } as CSSProperties,
  note: (here: boolean): CSSProperties => ({
    display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 8px", marginBottom: 4, borderRadius: 3,
    borderLeft: `2px solid ${here ? "var(--accent)" : "var(--border)"}`, background: here ? "var(--bg-3)" : "transparent",
  }),
  text: { flex: 1, minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.4, cursor: "text" } as CSSProperties,
  meta: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 3, color: "var(--fg-dim)", fontSize: 11 } as CSSProperties,
  chip: (live: boolean): CSSProperties => ({
    background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 3, padding: "0 5px", fontSize: 11,
    color: live ? "var(--fg)" : "var(--fg-dim)", cursor: live ? "pointer" : "default", maxWidth: 220,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  }),
  done: { padding: "0 6px", fontSize: 12, lineHeight: "18px", flex: "none" } as CSSProperties,
  undo: { display: "flex", gap: 8, alignItems: "center", padding: "6px 8px", marginBottom: 8, borderRadius: 3, background: "var(--bg-3)", fontSize: 12 } as CSSProperties,
  empty: { color: "var(--fg-dim)", lineHeight: 1.5, padding: "4px 0" } as CSSProperties,
};

function age(ts: number, now: number): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** Enter submits, Shift+Enter is a new line, Escape gives up. */
function keys(e: KeyboardEvent, submit: () => void, cancel?: () => void) {
  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
    e.preventDefault();
    submit();
  } else if (e.key === "Escape" && cancel) {
    e.preventDefault();
    cancel();
  }
}

/** One line per machine about its last fill, while it is running and for a while after. */
function fillLine(name: string, f: NoteFill, many: boolean): string {
  const on = many ? ` on ${name}` : "";
  if (f.state === "running") return `reading sessions${on}…`;
  if (f.state === "failed") return `fill failed${on}: ${f.error ?? "unknown error"}`;
  if (!f.checked) return `nothing new${on} since the last fill`;
  const read = `${f.checked} session${f.checked === 1 ? "" : "s"}`;
  return f.added ? `${f.added} added from ${read}${on}` : `nothing worth a note in ${read}${on}`;
}

const FILL_SHOWN_MS = 60_000;

export function NotesPanel({ notes, sessions, activeId, host, onAdd, onEdit, onRemove, onOpenSession, fill, onFill }: NotesPanelProps) {
  const [draft, setDraft] = useState("");
  const [about, setAbout] = useState(true);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [removed, setRemoved] = useState<Note | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout>>();
  const now = Date.now();

  // A new session in view is a new default: the next note is about it unless you say otherwise.
  useEffect(() => setAbout(true), [activeId]);
  useEffect(() => () => clearTimeout(undoTimer.current), []);

  const active = sessions.find((s) => s.id === activeId);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const elsewhere = notes.some((n) => host && n.host !== host);
  const here = active ? notes.filter((n) => n.sessionId === active.id) : [];
  const rest = notes.filter((n) => !active || n.sessionId !== active.id);
  // Newest first: the thing you just wrote down is the one you are most likely to look for.
  const newest = (a: Note, b: Note) => b.createdAt - a.createdAt;
  const fills = Object.entries(fill).filter(([, f]) => f.state === "running" || now - f.at < FILL_SHOWN_MS);
  const filling = fills.some(([, f]) => f.state === "running");

  const add = () => {
    const t = draft.trim();
    if (!t) return;
    onAdd(t, about && active ? active.id : undefined);
    setDraft("");
  };
  const saveEdit = () => {
    if (!editing) return;
    const t = editing.text.trim();
    if (t) onEdit(editing.id, t);
    setEditing(null);
  };
  const remove = (n: Note) => {
    onRemove(n.id, true);
    setRemoved(n);
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setRemoved(null), UNDO_MS);
  };
  const undo = () => {
    if (!removed) return;
    onRemove(removed.id, false);
    setRemoved(null);
  };

  const row = (n: Note, inView: boolean) => {
    const s = n.sessionId ? byId.get(n.sessionId) : undefined;
    const title = s?.title ?? n.sessionTitle;
    const isEditing = editing?.id === n.id;
    return (
      <div key={n.id} style={S.note(inView)}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {isEditing ? (
            <textarea
              autoFocus
              style={S.input}
              value={editing.text}
              onChange={(e) => setEditing({ id: n.id, text: e.target.value })}
              onKeyDown={(e) => keys(e, saveEdit, () => setEditing(null))}
              onBlur={saveEdit}
            />
          ) : (
            <div style={S.text} title="double-click to edit" onDoubleClick={() => setEditing({ id: n.id, text: n.text })}>{n.text}</div>
          )}
          <div style={S.meta}>
            {title && !inView && (
              <span
                style={S.chip(!!s)}
                title={s ? `go to ${title}` : `${title} is not running anywhere connected`}
                onClick={() => s && onOpenSession(s.id)}
              >
                {title}
              </span>
            )}
            {elsewhere && n.host !== host && <span>on {n.host}</span>}
            <span title={new Date(n.createdAt).toLocaleString()}>{age(n.createdAt, now)}</span>
          </div>
        </div>
        <button style={S.done} title="done: remove this note" aria-label="remove note" onClick={() => remove(n)}>✓</button>
      </div>
    );
  };

  return (
    <div>
      <div style={S.add}>
        <textarea
          style={S.input}
          rows={2}
          placeholder="something to keep in mind… (enter adds, shift+enter for a new line)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => keys(e, add)}
        />
        <div style={S.addRow}>
          {active && (
            <label style={S.about} title="the note stays tied to this session: it comes first while you are in it, and takes you back to it">
              <input type="checkbox" checked={about} onChange={(e) => setAbout(e.target.checked)} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>about {active.title}</span>
            </label>
          )}
          <button style={{ marginLeft: "auto" }} disabled={!draft.trim()} onClick={add}>add</button>
        </div>
        <div style={S.addRow}>
          <button
            disabled={filling}
            title="the model reads what each session asked, touched and last said since it was last read (never code), and adds what you should keep in mind; one model call per machine"
            onClick={onFill}
          >
            {filling ? "reading sessions…" : "fill from sessions"}
          </button>
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            {fills.map(([name, f]) => <span key={name} style={f.state === "failed" ? { color: "var(--alarm)" } : undefined}>{fillLine(name, f, fills.length > 1)}</span>)}
          </span>
        </div>
      </div>

      {removed && (
        <div style={S.undo}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>removed “{removed.text}”</span>
          <button style={S.done} onClick={undo}>undo</button>
        </div>
      )}

      {!notes.length && (
        <div style={S.empty}>
          Nothing to remember yet. Write down what you must not lose track of while you switch
          between sessions; tick it off when it no longer matters. Every paired machine shows the
          same notes.
        </div>
      )}

      {here.length > 0 && (
        <>
          <div style={S.section}>this session</div>
          {[...here].sort(newest).map((n) => row(n, true))}
        </>
      )}
      {rest.length > 0 && (
        <>
          {here.length > 0 && <div style={S.section}>everything else</div>}
          {[...rest].sort(newest).map((n) => row(n, false))}
        </>
      )}
    </div>
  );
}
