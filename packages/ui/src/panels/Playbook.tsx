// Milestone 5: the overseer's log. Latest "right now" summary on top, entries newest first,
// a session/global toggle, an "ask" box (POST /api/playbook/manual) and a status line
// (GET /api/playbook/status). Props are unchanged from the stub so App.tsx stays as it is;
// the global view reads the shared store directly.
import { useEffect, useState, type CSSProperties } from "react";
import type { PlaybookEntry } from "@henry/shared";
import { useStore } from "../ws";

export interface PlaybookPanelProps {
  sessionId: string | null;
  entries: PlaybookEntry[];
  onRefresh: () => void;
}

interface Status {
  backend: "api" | "claude-cli" | "none";
  model: string;
  lastRunAt?: number;
  lastError?: string;
  running: number;
}

type View = "session" | "global";

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const pillColor: Record<PlaybookEntry["trigger"], string> = { stop: "var(--fg-dim)", flag: "var(--warn)", manual: "var(--accent)" };

const st = {
  toggle: { display: "flex", gap: 6, marginBottom: 10 } as CSSProperties,
  summary: {
    background: "var(--bg-3)", border: "1px solid var(--accent)", borderRadius: 6, padding: "8px 10px", marginBottom: 12, whiteSpace: "pre-wrap",
  } as CSSProperties,
  summaryHead: { color: "var(--fg-dim)", fontSize: 11, marginBottom: 4, display: "flex", justifyContent: "space-between" } as CSSProperties,
  entry: { borderBottom: "1px solid var(--border)", padding: "8px 0" } as CSSProperties,
  meta: { display: "flex", gap: 8, alignItems: "center", color: "var(--fg-dim)", fontSize: 11, marginBottom: 4 } as CSSProperties,
  pill: (trigger: PlaybookEntry["trigger"]): CSSProperties => ({
    border: `1px solid ${pillColor[trigger]}`, color: pillColor[trigger], borderRadius: 8, padding: "0 6px", fontSize: 10, textTransform: "uppercase",
  }),
  text: { whiteSpace: "pre-wrap" } as CSSProperties,
  ask: { display: "flex", gap: 6, marginTop: 12 } as CSSProperties,
  answer: { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", marginTop: 8, whiteSpace: "pre-wrap" } as CSSProperties,
  status: { color: "var(--fg-dim)", fontSize: 11, marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 8, whiteSpace: "pre-wrap" } as CSSProperties,
  empty: { color: "var(--fg-dim)", padding: "12px 0" } as CSSProperties,
};

export function PlaybookPanel({ sessionId, entries }: PlaybookPanelProps) {
  const all = useStore((s) => s.playbook);
  const [view, setView] = useState<View>("session");
  const [status, setStatus] = useState<Status | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<PlaybookEntry | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  const list = view === "global" ? all.filter((p) => p.sessionId === null) : entries;
  const summary = list.find((p) => p.kind === "summary");
  const items = list.filter((p) => p.kind !== "summary");

  const refreshStatus = () => {
    fetch("/api/playbook/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Status | null) => s && setStatus(s))
      .catch(() => {});
  };
  useEffect(refreshStatus, [list.length, busy]);
  useEffect(() => {
    const t = setInterval(refreshStatus, 30_000);
    return () => clearInterval(t);
  }, []);

  const ask = async () => {
    const q = prompt.trim();
    if (!q || busy) return;
    setBusy(true);
    setAskError(null);
    setAnswer(null);
    try {
      const r = await fetch("/api/playbook/manual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: view === "global" ? null : sessionId, prompt: q }),
      });
      const body = (await r.json()) as { entry?: PlaybookEntry; error?: string };
      if (body.entry) {
        setAnswer(body.entry);
        setPrompt("");
      } else setAskError(body.error ?? `request failed (${r.status})`);
    } catch (e) {
      setAskError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const scopeLabel = view === "global" ? "all sessions" : sessionId ? "this session" : "no session selected";

  return (
    <div>
      <div style={st.toggle}>
        <button className={view === "session" ? "active" : ""} style={view === "session" ? { borderColor: "var(--accent)" } : undefined} onClick={() => setView("session")}>
          this session
        </button>
        <button className={view === "global" ? "active" : ""} style={view === "global" ? { borderColor: "var(--accent)" } : undefined} onClick={() => setView("global")}>
          global
        </button>
      </div>

      {summary && (
        <div style={st.summary}>
          <div style={st.summaryHead}>
            <span>right now · {scopeLabel}</span>
            <span>{time(summary.ts)}</span>
          </div>
          {summary.text}
        </div>
      )}

      {!items.length && (
        <div style={st.empty}>
          {view === "global"
            ? "No global entries yet. The overseer writes one across all running sessions at most every 10 minutes, after a session entry."
            : sessionId
              ? "Nothing here yet. The overseer writes an entry after each turn (Stop hook, debounced a few seconds) and whenever a flag fires, and keeps a one-paragraph \"right now\" summary at the top."
              : "Select a session to see its playbook."}
        </div>
      )}

      {items.map((p) => (
        <div key={p.id} style={st.entry}>
          <div style={st.meta}>
            <span>{time(p.ts)}</span>
            <span style={st.pill(p.trigger)}>{p.trigger}</span>
            {p.model && <span title="model">{p.model}</span>}
          </div>
          <div style={st.text}>{p.text}</div>
        </div>
      ))}

      <div style={st.ask}>
        <input
          style={{ flex: 1 }}
          placeholder={view === "global" ? "ask about all sessions…" : "ask the overseer about this session…"}
          value={prompt}
          disabled={busy || (view === "session" && !sessionId)}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void ask()}
        />
        <button disabled={busy || !prompt.trim() || (view === "session" && !sessionId)} onClick={() => void ask()}>
          {busy ? "asking…" : "ask"}
        </button>
      </div>
      {askError && <div style={{ ...st.answer, borderColor: "var(--alarm)" }}>{askError}</div>}
      {answer && (
        <div style={st.answer}>
          <div style={st.meta}>
            <span>{time(answer.ts)}</span>
            <span style={st.pill("manual")}>answer</span>
            <button style={{ marginLeft: "auto", padding: "0 6px" }} onClick={() => setAnswer(null)}>×</button>
          </div>
          {answer.text}
        </div>
      )}

      <div style={st.status}>
        {status
          ? `overseer: ${status.backend}${status.backend !== "none" ? ` · ${status.model}` : ""}` +
            ` · last run ${status.lastRunAt ? time(status.lastRunAt) : "never"}` +
            (status.running ? ` · ${status.running} running` : "") +
            (status.lastError ? `\nlast error: ${status.lastError}` : "")
          : "overseer: status unavailable"}
      </div>
    </div>
  );
}
