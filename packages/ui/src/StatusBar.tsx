// The status strip along the bottom of the window: the gauges you keep an eye on while
// working, on one line, always there. Left, the session you are looking at: model, context
// meter, tokens, spend. Right, the subscription: the 5h and 7d windows with their resets.
// Nothing here is a view you switch to; every item is a shortcut to the Usage tab, which has
// the per-session table and the words.
import { useEffect, useState } from "react";
import type { RateWindow, SessionUsage } from "@henry/shared";
import { showTool } from "./dock";
import { barColor, contextFraction, DEFAULT_CONTEXT_WINDOW, fmtCountdown, fmtTokens, shortModel } from "./panels/Usage";
import { useStore } from "./ws";

const open = () => showTool("usage");

function Meter({ frac }: { frac: number | undefined }) {
  const pct = frac === undefined ? 0 : Math.min(100, Math.round(frac * 100));
  return (
    <span className="sb-meter">
      <i style={{ width: `${pct}%`, background: frac === undefined ? "transparent" : barColor(frac) }} />
    </span>
  );
}

/** "5h ▬▬▭ 42% 2h 10m": the window, how much of it is spent, and when it comes back. */
function Rate({ label, win, now }: { label: string; win?: RateWindow; now: number }) {
  if (!win) return null;
  const pct = Math.round(win.utilization * 100);
  const reset = win.resetsAt ? fmtCountdown(win.resetsAt - now) : "";
  return (
    <button className="sb-item" onClick={open} title={`${label} window: ${pct}% of the limit used${reset ? `, ${reset}` : ""}`}>
      <span>{label}</span>
      <Meter frac={win.utilization} />
      <b style={{ color: barColor(win.utilization) }}>{pct}%</b>
      {reset && <span className="sb-dim">{reset.replace("resets in ", "")}</span>}
    </button>
  );
}

function Context({ u }: { u: SessionUsage }) {
  const frac = contextFraction(u);
  const window = u.contextWindow || DEFAULT_CONTEXT_WINDOW;
  const title = frac === undefined
    ? "context: no data yet"
    : `context: ${fmtTokens(u.contextTokens!)} of ${fmtTokens(window)}${u.contextWindow ? "" : " (assumed)"}`;
  return (
    <button className="sb-item" onClick={open} title={title}>
      <span>ctx</span>
      <Meter frac={frac} />
      <b style={{ color: frac === undefined ? undefined : barColor(frac) }}>{frac === undefined ? "–" : `${Math.round(frac * 100)}%`}</b>
    </button>
  );
}

export function StatusBar() {
  const usage = useStore((s) => s.usage);
  const active = useStore((s) => s.activeSessionId);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const u = active ? usage.perSession[active] : undefined;
  return (
    <div className="statusbar">
      {u && (
        <>
          <button className="sb-item" onClick={open} title={u.model ?? "model not reported yet"}>{shortModel(u.model)}</button>
          <Context u={u} />
          <button className="sb-item" onClick={open} title={`${fmtTokens(u.inputTokens)} in, ${fmtTokens(u.outputTokens)} out, ${fmtTokens(u.cacheRead)} cache read`}>
            {fmtTokens(u.inputTokens)}<span className="sb-dim">in</span> {fmtTokens(u.outputTokens)}<span className="sb-dim">out</span>
          </button>
          <button className="sb-item" onClick={open} title={`estimated cost $${u.costUsd.toFixed(4)}`}>${u.costUsd.toFixed(2)}</button>
        </>
      )}
      <span style={{ flex: 1 }} />
      {usage.updatedAt ? (
        <>
          <Rate label="5h" win={usage.fiveHour} now={now} />
          <Rate label="7d" win={usage.sevenDay} now={now} />
        </>
      ) : (
        <button className="sb-item" onClick={open} title="run henry install to enable the hooks + status line, then start a claude session">no usage yet</button>
      )}
    </div>
  );
}
