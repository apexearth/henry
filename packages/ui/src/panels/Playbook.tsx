// Milestone 5: the overseer's log. Latest "right now" summary on top, entries newest first,
// a session/global toggle, an "ask" box (POST /api/playbook/manual) and a status line
// (GET /api/playbook/status). Props are unchanged from the stub so App.tsx stays as it is;
// the global view reads the shared store directly.
//
// Entries arrive in the labeled shape the overseer is asked for (HEADLINE / DOING / CHANGED /
// CAREFUL / NEXT, see parsePlaybookText); the panel renders that as a headline, colored
// section labels and bullets, with `code` spans as chips. The newest entry is open, older ones
// collapse to their headline. Plain-prose entries (older rows) still render as a paragraph.
import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { parsePlaybookText, type PlaybookEntry, type PlaybookSection } from "@henry/shared";
import { getState, useStore } from "../ws";

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

/** Label → display name and color. Unknown labels fall back to their own text in dim. */
const LABELS: Record<string, { title: string; color: string }> = {
  DOING: { title: "doing", color: "var(--accent)" },
  CHANGED: { title: "changed", color: "var(--ok)" },
  REPOS: { title: "repos", color: "var(--ok)" },
  CAREFUL: { title: "careful", color: "var(--warn)" },
  NEXT: { title: "next", color: "var(--fg-dim)" },
  ANSWER: { title: "answer", color: "var(--accent)" },
};
const labelInfo = (label: string) => LABELS[label] ?? { title: label.toLowerCase(), color: "var(--fg-dim)" };

const st = {
  toggle: { display: "flex", gap: 6, marginBottom: 10 } as CSSProperties,
  summary: { background: "var(--bg-3)", border: "1px solid var(--accent)", borderRadius: 6, padding: "8px 10px", marginBottom: 12 } as CSSProperties,
  summaryHead: { color: "var(--fg-dim)", fontSize: 11, marginBottom: 6, display: "flex", justifyContent: "space-between" } as CSSProperties,
  headline: { fontSize: 13, fontWeight: 600, lineHeight: 1.35, marginBottom: 6 } as CSSProperties,
  entry: (open: boolean): CSSProperties => ({ borderBottom: "1px solid var(--border)", padding: "8px 0", cursor: open ? "default" : "pointer" }),
  meta: { display: "flex", gap: 8, alignItems: "center", color: "var(--fg-dim)", fontSize: 11, marginBottom: 4 } as CSSProperties,
  pill: (trigger: PlaybookEntry["trigger"]): CSSProperties => ({
    border: `1px solid ${pillColor[trigger]}`, color: pillColor[trigger], borderRadius: 8, padding: "0 6px", fontSize: 10, textTransform: "uppercase",
  }),
  sections: { display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 10, rowGap: 5, alignItems: "baseline" } as CSSProperties,
  label: (color: string): CSSProperties => ({ color, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600, paddingTop: 2, whiteSpace: "nowrap" }),
  body: (warn: boolean): CSSProperties => ({ minWidth: 0, lineHeight: 1.4, ...(warn ? { color: "var(--fg)" } : {}) }),
  list: { margin: 0, paddingLeft: 14 } as CSSProperties,
  li: (warn: boolean): CSSProperties => (warn ? { listStyle: "none", marginLeft: -14, paddingLeft: 8, borderLeft: "2px solid var(--warn)", marginBottom: 2 } : { marginBottom: 2 }),
  prose: { whiteSpace: "pre-wrap", lineHeight: 1.4 } as CSSProperties,
  code: { fontFamily: "var(--mono)", fontSize: "0.92em", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 3, padding: "0 4px", whiteSpace: "nowrap" } as CSSProperties,
  ask: { display: "flex", gap: 6, marginTop: 12 } as CSSProperties,
  answer: { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", marginTop: 8 } as CSSProperties,
  status: { color: "var(--fg-dim)", fontSize: 11, marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 8, whiteSpace: "pre-wrap" } as CSSProperties,
  empty: { color: "var(--fg-dim)", padding: "12px 0" } as CSSProperties,
};

/** `code` spans become chips; everything else is plain text. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/g);
  return (
    <>
      {parts.map((p, i) => (i % 2 ? <code key={i} style={st.code}>{p}</code> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

function Section({ s }: { s: PlaybookSection }) {
  const { title, color } = labelInfo(s.label);
  const warn = s.label === "CAREFUL";
  return (
    <>
      <div style={st.label(color)}>{title}</div>
      <div style={st.body(warn)}>
        {s.text && <div style={warn && !s.items.length ? st.li(true) : undefined}><Inline text={s.text} /></div>}
        {s.items.length > 0 && (
          <ul style={st.list}>
            {s.items.map((it, i) => (
              <li key={i} style={st.li(warn)}><Inline text={it} /></li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** A parsed entry or summary: headline, then label/body rows; prose falls back to a paragraph. */
function Body({ text, headline: showHeadline = true }: { text: string; headline?: boolean }): ReactNode {
  const parsed = parsePlaybookText(text);
  const prose = parsed.sections.length === 1 && parsed.sections[0].label === "" && !parsed.headline;
  if (prose) return <div style={st.prose}><Inline text={parsed.sections[0].text ?? ""} /></div>;
  return (
    <>
      {showHeadline && parsed.headline && <div style={st.headline}><Inline text={parsed.headline} /></div>}
      {parsed.sections.length > 0 && (
        <div style={st.sections}>
          {parsed.sections.map((s, i) => <Section key={i} s={s} />)}
        </div>
      )}
    </>
  );
}

export function PlaybookPanel({ sessionId, entries }: PlaybookPanelProps) {
  const all = useStore((s) => s.playbook);
  const [view, setView] = useState<View>("session");
  const [status, setStatus] = useState<Status | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<PlaybookEntry | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Record<string, boolean>>({});

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
      const peer = view === "global" ? undefined : getState().sessions.find((x) => x.id === sessionId)?.peer;
      const r = await fetch(peer ? `/api/playbook/manual?peer=${encodeURIComponent(peer)}` : "/api/playbook/manual", {
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
          <Body text={summary.text} />
        </div>
      )}

      {!items.length && (
        <div style={st.empty}>
          {view === "global"
            ? "No global entries yet. The overseer writes one across all running sessions at most every 10 minutes, after a session entry."
            : sessionId
              ? "Nothing here yet. The overseer writes an entry after each turn (Stop hook, debounced a few seconds) and whenever a flag fires, and keeps a \"right now\" summary at the top."
              : "Select a session to see its playbook."}
        </div>
      )}

      {items.map((p, i) => {
        // Newest entry starts open; the rest show their headline until clicked.
        const open = opened[p.id] ?? i === 0;
        const parsed = parsePlaybookText(p.text);
        const headline = parsed.headline ?? (parsed.sections[0]?.text ?? parsed.sections[0]?.items[0] ?? "");
        return (
          <div key={p.id} style={st.entry(open)} onClick={() => !open && setOpened((o) => ({ ...o, [p.id]: true }))}>
            <div style={st.meta}>
              <span>{time(p.ts)}</span>
              <span style={st.pill(p.trigger)}>{p.trigger}</span>
              {p.model && <span title="model">{p.model}</span>}
              {open && i !== 0 && (
                <button style={{ marginLeft: "auto", padding: "0 6px", fontSize: 10 }} onClick={(e) => { e.stopPropagation(); setOpened((o) => ({ ...o, [p.id]: false })); }}>
                  collapse
                </button>
              )}
            </div>
            {open ? <Body text={p.text} /> : <div style={{ ...st.headline, fontWeight: 500, marginBottom: 0 }}><Inline text={headline} /></div>}
          </div>
        );
      })}

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
          <Body text={answer.text} />
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
