// 5h / 7d utilization bars with reset countdowns, per-session token + cost table, last-updated stamp.
// The bars come from the statusline snapshot (henry-statusline.sh); rows come from the transcript tailer.
import { useEffect, useState } from "react";
import type { RateWindow, SessionUsage, Usage } from "@henry/shared";
import { useStore } from "../ws";

export interface UsagePanelProps {
  sessionId: string | null;
  usage: Usage;
}

const AMBER = 0.7;
const RED = 0.9;

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

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 10_000) return Math.round(n / 1000) + "k";
  if (n >= 1_000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function shortModel(m?: string): string {
  if (!m) return "–";
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
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

const th: React.CSSProperties = { textAlign: "right", color: "var(--fg-dim)", fontWeight: "normal", padding: "2px 4px", whiteSpace: "nowrap" };
const td: React.CSSProperties = { textAlign: "right", padding: "2px 4px", whiteSpace: "nowrap" };

export function UsagePanel({ sessionId, usage }: UsagePanelProps) {
  const sessions = useStore((s) => s.sessions);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? id.slice(0, 8);
  const rows: [string, SessionUsage][] = Object.entries(usage.perSession).sort(([a], [b]) => {
    if (a === sessionId) return -1;
    if (b === sessionId) return 1;
    const ca = sessions.find((s) => s.id === a)?.createdAt ?? 0;
    const cb = sessions.find((s) => s.id === b)?.createdAt ?? 0;
    return cb - ca;
  });
  const total = rows.reduce(
    (acc, [, u]) => ({ inputTokens: acc.inputTokens + u.inputTokens, outputTokens: acc.outputTokens + u.outputTokens, cacheRead: acc.cacheRead + u.cacheRead, costUsd: acc.costUsd + u.costUsd }),
    { inputTokens: 0, outputTokens: 0, cacheRead: 0, costUsd: 0 },
  );

  return (
    <div>
      <Bar label="5h" win={usage.fiveHour} now={now} />
      <Bar label="7d" win={usage.sevenDay} now={now} />
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
              <th style={th}>model</th>
              <th style={th}>in</th>
              <th style={th}>out</th>
              <th style={th}>cache rd</th>
              <th style={th}>est. cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([id, u]) => (
              <tr key={id} style={{ background: id === sessionId ? "var(--bg-3)" : undefined }}>
                <td style={{ ...td, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 110 }} title={id}>
                  {titleOf(id)}
                </td>
                <td style={td} title={u.model}>{shortModel(u.model)}</td>
                <td style={td}>{fmtTokens(u.inputTokens)}</td>
                <td style={td}>{fmtTokens(u.outputTokens)}</td>
                <td style={td}>{fmtTokens(u.cacheRead)}</td>
                <td style={td}>${u.costUsd.toFixed(2)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6} style={{ ...td, textAlign: "left", color: "var(--fg-dim)" }}>no per-session usage yet</td>
              </tr>
            )}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr style={{ borderTop: "1px solid var(--border)", color: "var(--fg-dim)" }}>
                <td style={{ ...td, textAlign: "left" }}>all</td>
                <td style={td} />
                <td style={td}>{fmtTokens(total.inputTokens)}</td>
                <td style={td}>{fmtTokens(total.outputTokens)}</td>
                <td style={td}>{fmtTokens(total.cacheRead)}</td>
                <td style={td}>${total.costUsd.toFixed(2)}</td>
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
