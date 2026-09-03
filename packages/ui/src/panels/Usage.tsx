// 5h / 7d utilization bars with reset countdowns, the active session's context bar, per-session
// token + cost table, last-updated stamp. The rate bars come from the statusline snapshot
// (henry-statusline.sh); context and rows come from the transcript tailer.
import { useEffect, useRef, useState } from "react";
import type { RateWindow, SessionUsage, Usage } from "@henry/shared";
import { useStore } from "../ws";

export interface UsagePanelProps {
  sessionId: string | null;
  usage: Usage;
}

const AMBER = 0.7;
const RED = 0.9;
/** Assumed when the statusline has not reported `context_window_size` yet. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

export function contextFraction(u: SessionUsage | undefined): number | undefined {
  if (u?.contextTokens === undefined) return undefined;
  return u.contextTokens / (u.contextWindow || DEFAULT_CONTEXT_WINDOW);
}

function barColor(u: number): string {
  return u >= RED ? "var(--alarm)" : u >= AMBER ? "var(--warn)" : "var(--ok)";
}

export function fmtCountdown(ms: number): string {
  if (ms <= 0) return "resetting";
  const totalMin = Math.round(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

/** At most 4 characters: 999, 1.2k, 12k, 156k, 1.2M, 12M, 156M. */
export function fmtTokens(n: number): string {
  for (const [unit, suffix] of [[1_000_000, "M"], [1_000, "k"]] as const) {
    if (n < unit * 0.9995) continue; // 999,600 rounds to "1M", not "1000k"
    const v = n / unit;
    return (v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v))) + suffix;
  }
  return String(Math.round(n));
}

/** Model family only ("fable", "opus"); the full id lives in the cell tooltip. */
function shortModel(m?: string): string {
  if (!m) return "–";
  return m.replace(/^claude-/, "").split("-")[0];
}

function Bar({ label, win, now }: { label: string; win?: RateWindow; now: number }) {
  const pct = win ? Math.round(win.utilization * 100) : 0;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span>
          <b>{label}</b> {win ? `${pct}%` : "–"}
        </span>
        <span style={{ color: "var(--fg-dim)", fontSize: 11 }}>{win?.resetsAt ? fmtCountdown(win.resetsAt - now) : win ? "" : "no data"}</span>
      </div>
      <div style={{ height: 8, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", background: win ? barColor(win.utilization) : "transparent", transition: "width .3s" }} />
      </div>
    </div>
  );
}

function ContextBar({ usage }: { usage?: SessionUsage }) {
  const frac = contextFraction(usage);
  const pct = frac === undefined ? 0 : Math.round(frac * 100);
  const window = usage?.contextWindow || DEFAULT_CONTEXT_WINDOW;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span>
          <b>context</b> {frac === undefined ? "–" : `${pct}%`}
        </span>
        <span style={{ color: "var(--fg-dim)", fontSize: 11 }}>
          {frac === undefined ? "no data" : `${fmtTokens(usage!.contextTokens!)} / ${fmtTokens(window)}${usage?.contextWindow ? "" : " (assumed)"}`}
        </span>
      </div>
      <div style={{ height: 8, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", background: frac === undefined ? "transparent" : barColor(frac), transition: "width .3s" }} />
      </div>
    </div>
  );
}

/** Below these widths the table sums in+out into one "tokens" column, then drops the model. */
const FOLD_IO_BELOW = 375;
const HIDE_MODEL_BELOW = 320;

function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const th: React.CSSProperties = { textAlign: "right", color: "var(--fg-dim)", fontWeight: "normal", padding: "2px 4px", whiteSpace: "nowrap" };
const td: React.CSSProperties = { textAlign: "right", padding: "2px 4px", whiteSpace: "nowrap" };

export function UsagePanel({ sessionId, usage }: UsagePanelProps) {
  const sessions = useStore((s) => s.sessions);
  const [ref, width] = useWidth();
  const foldIO = width > 0 && width < FOLD_IO_BELOW;
  const showModel = !(width > 0 && width < HIDE_MODEL_BELOW);
  const io = (u: { inputTokens: number; outputTokens: number }) => fmtTokens(u.inputTokens + u.outputTokens);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? id.slice(0, 8);
  // A usage row with no live session (an earlier daemon run) counts as closed.
  const isOpen = (id: string) => sessions.find((s) => s.id === id)?.status === "running";
  const rows: [string, SessionUsage][] = Object.entries(usage.perSession).sort(([a], [b]) => {
    if (a === sessionId) return -1;
    if (b === sessionId) return 1;
    if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
    const ca = sessions.find((s) => s.id === a)?.createdAt ?? 0;
    const cb = sessions.find((s) => s.id === b)?.createdAt ?? 0;
    return cb - ca;
  });
  const total = rows.reduce(
    (acc, [, u]) => ({ inputTokens: acc.inputTokens + u.inputTokens, outputTokens: acc.outputTokens + u.outputTokens, cacheRead: acc.cacheRead + u.cacheRead, costUsd: acc.costUsd + u.costUsd }),
    { inputTokens: 0, outputTokens: 0, cacheRead: 0, costUsd: 0 },
  );

  return (
    <div ref={ref}>
      <Bar label="5h" win={usage.fiveHour} now={now} />
      <Bar label="7d" win={usage.sevenDay} now={now} />
      {sessionId && <ContextBar usage={usage.perSession[sessionId]} />}
      {!usage.updatedAt && (
        <div style={{ color: "var(--fg-dim)", fontSize: 11, margin: "4px 0 12px" }}>
          no usage received yet — run <code>henry install</code> to enable the hooks + status line, then start a claude session
        </div>
      )}

      <div style={{ overflowX: "auto", marginTop: 6 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }}>session</th>
              {showModel && <th style={th}>model</th>}
              <th style={th} title="context window in use">ctx</th>
              {foldIO ? (
                <th style={th} title="input + output tokens">tokens</th>
              ) : (
                <>
                  <th style={th}>in</th>
                  <th style={th}>out</th>
                </>
              )}
              <th style={th} title="cache read tokens">cache</th>
              <th style={th} title="estimated cost, USD">$</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([id, u]) => (
              <tr key={id} style={{ background: id === sessionId ? "var(--bg-3)" : undefined, opacity: isOpen(id) ? 1 : 0.5 }}>
                <td style={{ ...td, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 110 }} title={id}>
                  {titleOf(id)}
                </td>
                {showModel && <td style={td} title={u.model}>{shortModel(u.model)}</td>}
                <td style={{ ...td, color: contextFraction(u) === undefined ? "var(--fg-dim)" : barColor(contextFraction(u)!) }}
                  title={u.contextTokens === undefined ? "no context data yet" : `${fmtTokens(u.contextTokens)} of ${fmtTokens(u.contextWindow || DEFAULT_CONTEXT_WINDOW)}`}>
                  {contextFraction(u) === undefined ? "–" : `${Math.round(contextFraction(u)! * 100)}%`}
                </td>
                {foldIO ? (
                  <td style={td}>{io(u)}</td>
                ) : (
                  <>
                    <td style={td}>{fmtTokens(u.inputTokens)}</td>
                    <td style={td}>{fmtTokens(u.outputTokens)}</td>
                  </>
                )}
                <td style={td}>{fmtTokens(u.cacheRead)}</td>
                <td style={td} title={`$${u.costUsd.toFixed(4)}`}>{u.costUsd.toFixed(2)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={7} style={{ ...td, textAlign: "left", color: "var(--fg-dim)" }}>no per-session usage yet</td>
              </tr>
            )}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr style={{ borderTop: "1px solid var(--border)", color: "var(--fg-dim)" }}>
                <td style={{ ...td, textAlign: "left" }}>all</td>
                {showModel && <td style={td} />}
                <td style={td} />
                {foldIO ? (
                  <td style={td}>{io(total)}</td>
                ) : (
                  <>
                    <td style={td}>{fmtTokens(total.inputTokens)}</td>
                    <td style={td}>{fmtTokens(total.outputTokens)}</td>
                  </>
                )}
                <td style={td}>{fmtTokens(total.cacheRead)}</td>
                <td style={td}>{total.costUsd.toFixed(2)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div style={{ color: "var(--fg-dim)", fontSize: 11, marginTop: 10 }}>
        last updated {usage.updatedAt ? new Date(usage.updatedAt).toLocaleTimeString() : "never"}
      </div>
    </div>
  );
}
