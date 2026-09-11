// The status strip along the bottom of the window: the gauges you keep an eye on while
// working, on one line, always there. Left, the session you are looking at: model, context
// meter, tokens, spend. Right, the subscription: the 5h and 7d windows with their resets, one
// pair per machine you are paired with (each daemon meters its own), the machine of the session
// you are looking at first. Nothing here is a view you switch to; every item is a shortcut to
// the Usage tab, which has the per-session table and the words.
import { useEffect, useState } from "react";
import type { RateWindow, SessionUsage } from "@henry/shared";
import { showTool } from "./dock";
import { barColor, contextFraction, DEFAULT_CONTEXT_WINDOW, fmtCountdown, fmtTokens, hostRows, shortModel, type HostRow } from "./panels/Usage";
import { hueText, nameHue } from "./theme";
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
function Rate({ label, win, now, on }: { label: string; win?: RateWindow; now: number; on: string }) {
  if (!win) return null;
  const pct = Math.round(win.utilization * 100);
  const reset = win.resetsAt ? fmtCountdown(win.resetsAt - now) : "";
  return (
    <button className="sb-item" onClick={open} title={`${label} window on ${on}: ${pct}% of the limit used${reset ? `, ${reset}` : ""}`}>
      <span>{label}</span>
      <Meter frac={win.utilization} />
      <b style={{ color: barColor(win.utilization) }}>{pct}%</b>
      {reset && <span className="sb-dim">{reset.replace("resets in ", "")}</span>}
    </button>
  );
}

/** One machine's pair. Its name leads only when more than one machine is reporting. */
function HostRates({ row, alone, now }: { row: HostRow; alone: boolean; now: number }) {
  const on = row.name || "this machine";
  const silent = !row.usage.fiveHour && !row.usage.sevenDay;
  return (
    <>
      {!alone && (
        <button className="sb-item sb-host" onClick={open} title={row.peer ? `${on} (remote, via its own Henry daemon)` : on}>
          <b style={{ color: row.peer ? hueText(nameHue(row.name)) : undefined }}>{on}</b>
        </button>
      )}
      {silent ? (
        <button className="sb-item" onClick={open} title={`no usage reported from ${on} yet`}>–</button>
      ) : (
        <>
          <Rate label="5h" win={row.usage.fiveHour} now={now} on={on} />
          <Rate label="7d" win={row.usage.sevenDay} now={now} on={on} />
        </>
      )}
    </>
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
  const host = useStore((s) => s.host);
  const active = useStore((s) => s.activeSessionId);
  const activePeer = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.peer);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const u = active ? usage.perSession[active] : undefined;
  // The machine you are working on leads; the rest follow this machine, then peers by name.
  const here = activePeer ?? host;
  const hosts = hostRows(usage, host).sort((a, b) => Number(b.name === here) - Number(a.name === here));
  return (
    <div className="statusbar">
      {u && (
        // Shrinks and clips before the gauges do: which machine is near its limit outlives
        // the token counts of the session in front of you.
        <div className="sb-session">
          <button className="sb-item" onClick={open} title={u.model ?? "model not reported yet"}>{shortModel(u.model)}</button>
          <Context u={u} />
          <button className="sb-item" onClick={open} title={`${fmtTokens(u.inputTokens)} in, ${fmtTokens(u.outputTokens)} out, ${fmtTokens(u.cacheRead)} cache read`}>
            {fmtTokens(u.inputTokens)}<span className="sb-dim">in</span> {fmtTokens(u.outputTokens)}<span className="sb-dim">out</span>
          </button>
          <button className="sb-item" onClick={open} title={`estimated cost $${u.costUsd.toFixed(4)}`}>${u.costUsd.toFixed(2)}</button>
        </div>
      )}
      <span style={{ flex: 1 }} />
      {usage.updatedAt ? (
        hosts.map((h) => <HostRates key={h.name} row={h} alone={hosts.length === 1} now={now} />)
      ) : (
        <button className="sb-item" onClick={open} title="run henry install to enable the hooks + status line, then start a claude session">no usage yet</button>
      )}
    </div>
  );
}
