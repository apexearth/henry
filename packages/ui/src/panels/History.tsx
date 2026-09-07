// A Claude session's conversation, in a pane you can scroll and search.
//
// The terminal cannot hold this: Claude Code's TUI keeps the alternate screen for the whole
// session, and an alternate screen has no scrollback. So the turns come from the transcript
// (GET /api/history) and are rendered here — prose in full, tool calls as one line each, tool
// results folded until asked for. Newest at the bottom, like the chat it is.
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { History, HistoryBlock, HistoryTurn } from "@henry/shared";

export interface HistoryPanelProps {
  sessionId: string | null;
  history?: History;
  loading: boolean;
  onRefresh: () => void;
}

const time = (ts: number) => (ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
/** "claude-opus-5-20260101" reads as "opus" in a meta line. */
const modelName = (m?: string) => m?.match(/(opus|sonnet|haiku|fable)/i)?.[1]?.toLowerCase() ?? m;

const st = {
  bar: { display: "flex", gap: 6, alignItems: "center", marginBottom: 8 } as CSSProperties,
  find: { flex: 1, minWidth: 0 } as CSSProperties,
  toggle: (on: boolean): CSSProperties => ({
    fontSize: 11, padding: "2px 7px", borderRadius: 10, whiteSpace: "nowrap",
    border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
    color: on ? "var(--accent)" : "var(--fg-dim)",
    background: on ? "var(--accent-soft)" : "transparent",
  }),
  scroll: { overflow: "auto", flex: 1, minHeight: 0, paddingRight: 2 } as CSSProperties,
  turn: (user: boolean): CSSProperties => ({
    borderLeft: `2px solid ${user ? "var(--accent)" : "var(--border)"}`,
    paddingLeft: 8,
    margin: "0 0 12px",
  }),
  meta: { display: "flex", gap: 8, alignItems: "baseline", color: "var(--fg-dim)", fontSize: 11, marginBottom: 3 } as CSSProperties,
  who: (user: boolean): CSSProperties => ({ color: user ? "var(--accent)" : "var(--fg)", fontWeight: 600 }),
  prose: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.45 } as CSSProperties,
  thinking: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.4, color: "var(--fg-dim)", fontStyle: "italic" } as CSSProperties,
  tool: { display: "flex", gap: 6, alignItems: "baseline", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", marginTop: 3 } as CSSProperties,
  toolName: { color: "var(--ok)", flex: "none" } as CSSProperties,
  toolArg: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } as CSSProperties,
  result: (open: boolean): CSSProperties => ({
    fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", background: "var(--bg)",
    border: "1px solid var(--border)", borderRadius: 4, padding: "4px 6px", marginTop: 3,
    whiteSpace: "pre-wrap", overflowWrap: "anywhere", cursor: "pointer",
    ...(open ? {} : { maxHeight: 40, overflow: "hidden" }),
  }),
  note: { color: "var(--fg-dim)", fontSize: 11, padding: "6px 0" } as CSSProperties,
  empty: { color: "var(--fg-dim)", padding: "12px 0" } as CSSProperties,
  mark: { background: "var(--accent-soft)", color: "var(--fg)" } as CSSProperties,
};

/** The searched-for text, lit up wherever it appears. */
function Lit({ text, find }: { text: string; find: string }) {
  if (!find) return <>{text}</>;
  const parts = text.split(new RegExp(`(${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} style={st.mark}>{p}</mark> : p))}</>;
}

function Block({ block, find }: { block: HistoryBlock; find: string }) {
  const [open, setOpen] = useState(false);
  const tail = block.clipped ? " …" : "";
  if (block.kind === "text") return <div style={st.prose}><Lit text={block.text + tail} find={find} /></div>;
  if (block.kind === "thinking") return <div style={st.thinking}><Lit text={block.text + tail} find={find} /></div>;
  if (block.kind === "tool") {
    return (
      <div style={st.tool}>
        <span style={st.toolName}>▸ {block.name}</span>
        <span style={st.toolArg} title={block.text}><Lit text={block.text} find={find} /></span>
      </div>
    );
  }
  // A result that matches the search opens itself: folded, the turn would look like a false hit.
  const matched = !!find && block.text.toLowerCase().includes(find.toLowerCase());
  return (
    <div style={st.result(open || matched)} onClick={() => setOpen(!open)} title={open ? "click to fold" : "click to unfold"}>
      <Lit text={block.text + tail} find={find} />
    </div>
  );
}

function Turn({ turn, find, tools }: { turn: HistoryTurn; find: string; tools: boolean }) {
  const user = turn.role === "user";
  const blocks = tools ? turn.blocks : turn.blocks.filter((b) => b.kind === "text" || b.kind === "thinking");
  if (!blocks.length) return null;
  return (
    <div style={st.turn(user)}>
      <div style={st.meta}>
        <span style={st.who(user)}>{user ? "you" : "claude"}</span>
        {!user && turn.model && <span>{modelName(turn.model)}</span>}
        {turn.sidechain && <span>subagent</span>}
        <span>{time(turn.at)}</span>
      </div>
      {blocks.map((b, i) => <Block key={i} block={b} find={find} />)}
    </div>
  );
}

export function HistoryPanel({ sessionId, history, loading, onRefresh }: HistoryPanelProps) {
  const [find, setFind] = useState("");
  const [tools, setTools] = useState(true);
  const [subagents, setSubagents] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const turns = useMemo(() => {
    const all = history?.turns ?? [];
    const kept = subagents ? all : all.filter((t) => !t.sidechain);
    if (!find.trim()) return kept;
    const needle = find.trim().toLowerCase();
    return kept.filter((t) => t.blocks.some((b) => b.text.toLowerCase().includes(needle) || b.name?.toLowerCase().includes(needle)));
  }, [history, find, subagents]);

  // Follow the conversation only while the reader is already at the end; scrolling up to read
  // something must not be yanked back by the next turn landing. The observer is for the dock: a
  // hidden tab has no height, so pinning on render alone would leave the pane at the top of the
  // conversation the first time it is shown.
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const pin = () => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    };
    pin();
    const ro = new ResizeObserver(pin);
    ro.observe(el);
    return () => ro.disconnect();
  }, [turns]);

  if (!sessionId) return <div style={st.empty}>No session selected.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={st.bar}>
        <input style={st.find} placeholder="find" value={find} onChange={(e) => setFind(e.target.value)} />
        <button style={st.toggle(tools)} onClick={() => setTools(!tools)} title="show tool calls and their results">tools</button>
        <button style={st.toggle(subagents)} onClick={() => setSubagents(!subagents)} title="show turns written by subagents">subagents</button>
        <button style={st.toggle(false)} onClick={onRefresh} title="re-read the transcript">{loading ? "…" : "↻"}</button>
      </div>
      <div
        ref={scroll}
        style={st.scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {history?.reason && <div style={st.empty}>{history.reason}</div>}
        {!history?.reason && !turns.length && (
          <div style={st.empty}>{loading ? "reading the transcript…" : find ? "nothing here matches." : "no turns yet."}</div>
        )}
        {history && !history.complete && !find && <div style={st.note}>older turns are further back than this window reaches</div>}
        {turns.map((t) => <Turn key={t.uuid} turn={t} find={find.trim()} tools={tools} />)}
      </div>
    </div>
  );
}
