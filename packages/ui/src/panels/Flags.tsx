// Milestone 4: newest-first feed of notable/alarm flags with unread highlighting, an
// "all sessions" toggle, an expander per row (why it fired + the tool call behind it),
// and a Rules sub-tab listing the catalog against the live config.rules.
import { useMemo, useState, type CSSProperties } from "react";
import { explainRule, rulesWithConfig, type Flag, type HenryEvent, type Severity } from "@henry/shared";
import { useStore } from "../ws";

export interface FlagsPanelProps {
  sessionId: string | null;
  /** Flags for the active session (App pre-filters); the all-sessions view reads the store. */
  flags: Flag[];
  events: HenryEvent[];
  onMarkRead: (ids: string[]) => void;
}

type SubTab = "flags" | "rules";

const sevColor = (s: Severity) => (s === "alarm" ? "var(--alarm)" : s === "notable" ? "var(--warn)" : "var(--fg-dim)");

const S = {
  bar: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" } as CSSProperties,
  sub: (on: boolean): CSSProperties => ({
    background: "none", border: "none", borderBottom: `2px solid ${on ? "var(--accent)" : "transparent"}`,
    borderRadius: 0, padding: "2px 6px", color: on ? "var(--fg)" : "var(--fg-dim)",
  }),
  row: (unread: boolean): CSSProperties => ({
    borderLeft: `2px solid ${unread ? "var(--accent)" : "transparent"}`, background: unread ? "var(--bg-3)" : "transparent",
    padding: "5px 8px", marginBottom: 4, borderRadius: 3, cursor: "pointer",
  }),
  head: { display: "grid", gridTemplateColumns: "auto auto 1fr", gap: 8, alignItems: "baseline", minWidth: 0 } as CSSProperties,
  pill: (s: Severity): CSSProperties => ({
    color: sevColor(s), border: `1px solid ${sevColor(s)}`, borderRadius: 8, padding: "0 6px", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5,
  }),
  time: { color: "var(--fg-dim)", fontSize: 11, whiteSpace: "nowrap" } as CSSProperties,
  summary: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as CSSProperties,
  meta: { gridColumn: "1 / 4", color: "var(--fg-dim)", fontSize: 11, display: "flex", gap: 8 } as CSSProperties,
  chip: { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 3, padding: "0 4px" } as CSSProperties,
  detail: { marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--border)", fontSize: 12, color: "var(--fg)", cursor: "default" } as CSSProperties,
  pre: { whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "4px 0 0", fontSize: 11, color: "var(--fg-dim)", background: "var(--bg)", padding: 6, borderRadius: 3, maxHeight: 160, overflow: "auto" } as CSSProperties,
  label: { color: "var(--fg-dim)" } as CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 } as CSSProperties,
  td: { padding: "4px 6px 4px 0", verticalAlign: "top", borderBottom: "1px solid var(--border)" } as CSSProperties,
  h: { margin: "12px 0 6px", fontSize: 12, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: 0.5 } as CSSProperties,
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** What the underlying tool call did: its command, path, or (for git events) the summary. */
function describeEvent(e: HenryEvent | undefined): { tool: string; detail: string } | null {
  if (!e) return null;
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const input = (p.tool_input ?? {}) as Record<string, unknown>;
  const tool = e.toolName ?? (e.kind === "git" ? "git" : e.hookEvent ?? e.kind);
  const detail =
    typeof input.command === "string" ? input.command
    : typeof input.file_path === "string" ? input.file_path
    : typeof input.notebook_path === "string" ? input.notebook_path
    : typeof input.path === "string" ? input.path
    : typeof input.pattern === "string" ? input.pattern
    : e.summary;
  return { tool: String(tool), detail: String(detail ?? "") };
}

export function FlagsPanel({ sessionId, flags, events, onMarkRead }: FlagsPanelProps) {
  const allFlags = useStore((s) => s.flags);
  const sessions = useStore((s) => s.sessions);
  const config = useStore((s) => s.config);
  const [sub, setSub] = useState<SubTab>("flags");
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const shown = useMemo(() => {
    const list = all || !sessionId ? allFlags : flags;
    return [...list].sort((a, b) => b.ts - a.ts);
  }, [all, sessionId, allFlags, flags]);
  const unread = shown.filter((f) => !f.read);
  const eventById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const sessionTitle = (id: string) => sessions.find((s) => s.id === id)?.title ?? id.slice(0, 8);

  const toggle = (f: Flag) => {
    setOpen(open === f.id ? null : f.id);
    if (!f.read) onMarkRead([f.id]);
  };

  return (
    <div>
      <div style={S.bar}>
        <button style={S.sub(sub === "flags")} onClick={() => setSub("flags")}>Flags{unread.length ? ` (${unread.length})` : ""}</button>
        <button style={S.sub(sub === "rules")} onClick={() => setSub("rules")}>Rules</button>
        <span style={{ flex: 1 }} />
        {sub === "flags" && (
          <>
            <label style={{ color: "var(--fg-dim)", fontSize: 11, display: "flex", gap: 4, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> all sessions
            </label>
            <button disabled={!unread.length} onClick={() => onMarkRead(unread.map((f) => f.id))} title="mark every visible flag read">mark all read</button>
          </>
        )}
      </div>

      {sub === "flags" && (
        <div>
          {!shown.length && <div className="placeholder">no flags {all ? "yet" : sessionId ? "for this session" : "yet"}</div>}
          {shown.map((f) => {
            const ev = eventById.get(f.eventId);
            const desc = describeEvent(ev);
            const isOpen = open === f.id;
            return (
              <div key={f.id} style={S.row(!f.read)} onClick={() => toggle(f)} title={isOpen ? "" : explainRule(f.rule)}>
                <div style={S.head}>
                  <span style={S.pill(f.severity)}>{f.severity}</span>
                  <span style={S.time}>{fmtTime(f.ts)}</span>
                  <span style={S.summary} title={f.summary}>{f.summary}</span>
                  <div style={S.meta}>
                    <span style={S.chip}>{f.rule}</span>
                    {(all || !sessionId) && <span>{sessionTitle(f.sessionId)}</span>}
                    <span style={{ marginLeft: "auto" }}>{isOpen ? "▾" : "▸"}</span>
                  </div>
                </div>
                {isOpen && (
                  <div style={S.detail} onClick={(e) => e.stopPropagation()}>
                    <div><span style={S.label}>why: </span>{explainRule(f.rule)}</div>
                    {desc ? (
                      <div style={{ marginTop: 4 }}>
                        <span style={S.label}>tool: </span>{desc.tool}
                        {ev?.cwd && <span style={S.label}> · in {ev.cwd}</span>}
                        {desc.detail && <pre style={S.pre}>{desc.detail}</pre>}
                      </div>
                    ) : (
                      <div style={{ marginTop: 4, color: "var(--fg-dim)" }}>event {f.eventId.slice(0, 8)} is no longer in the live feed</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {sub === "rules" && <RulesView rules={config?.rules ?? null} />}
    </div>
  );
}

function RulesView({ rules }: { rules: Record<string, unknown> | null }) {
  const catalog = rulesWithConfig((rules ?? undefined) as Parameters<typeof rulesWithConfig>[0]);
  const list = (k: string) => (Array.isArray(rules?.[k]) ? (rules![k] as unknown[]).map(String) : []);
  return (
    <div>
      <div style={S.h}>rules</div>
      <table style={S.table}>
        <tbody>
          {catalog.map((r) => (
            <tr key={r.id}>
              <td style={S.td}><span style={S.pill(r.severity)}>{r.severity === "info" ? "off" : r.severity}</span></td>
              <td style={S.td}><span style={S.chip}>{r.id}</span>{r.configKey && <div style={{ color: "var(--fg-dim)", fontSize: 10 }}>rules.{r.configKey}</div>}</td>
              <td style={S.td}>{r.description}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={S.h}>config.rules (~/.henry/config.json)</div>
      {!rules && <div className="placeholder">config not loaded yet</div>}
      {rules && (
        <table style={S.table}>
          <tbody>
            <tr><td style={S.td}>protectedBranches</td><td style={S.td}>{list("protectedBranches").join(", ") || "—"}</td></tr>
            <tr><td style={S.td}>alarm</td><td style={S.td}>{list("alarm").map((p) => <div key={p}><code>{p}</code></div>)}</td></tr>
            <tr><td style={S.td}>notable</td><td style={S.td}>{list("notable").map((p) => <div key={p}><code>{p}</code></div>)}</td></tr>
            <tr><td style={S.td}>crossRepoWrite</td><td style={S.td}>{String(rules.crossRepoWrite ?? "notable")}</td></tr>
            <tr><td style={S.td}>commitOnProtected</td><td style={S.td}>{String(rules.commitOnProtected ?? "alarm")}</td></tr>
            <tr><td style={S.td}>pushToProtected</td><td style={S.td}>{String(rules.pushToProtected ?? "notable")}</td></tr>
            <tr><td style={S.td}>maxSubagentsPer10m</td><td style={S.td}>{String(rules.maxSubagentsPer10m ?? 8)}</td></tr>
          </tbody>
        </table>
      )}
      <div style={{ marginTop: 8, color: "var(--fg-dim)", fontSize: 11 }}>
        Patterns match case-insensitively as substrings; wrap one in slashes (<code>/rm -rf \//</code>) for a regex. Edits to config.json are picked up without a restart.
      </div>
    </div>
  );
}
