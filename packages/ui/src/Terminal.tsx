// One xterm per session. Stays mounted while hidden so scroll position survives tab switches.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { send, subscribePty, useStore } from "./ws";

interface Props {
  sessionId: string;
  active: boolean;
}

export function TerminalView({ sessionId, active }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const connectionId = useStore((s) => s.connectionId);

  useEffect(() => {
    const t = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      scrollback: 10000,
      allowProposedApi: true,
      theme: { background: "#000000" },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(box.current!);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      t.loadAddon(webgl);
    } catch (e) {
      console.warn("[henry] WebGL renderer unavailable, using DOM renderer", e);
    }
    // Let the window-level Cmd+1..9 handler own those keys.
    t.attachCustomKeyEventHandler((ev) => !((ev.metaKey || ev.ctrlKey) && /^[1-9]$/.test(ev.key)));
    t.onData((data) => send({ type: "pty:input", sessionId, data }));

    let last = "";
    const doFit = () => {
      f.fit();
      const dims = `${t.cols}x${t.rows}`;
      // Only the visible terminal reports its size; the daemon takes the latest report.
      if (activeRef.current && dims !== last) {
        last = dims;
        send({ type: "pty:resize", sessionId, cols: t.cols, rows: t.rows });
      }
    };
    doFit();
    const ro = new ResizeObserver(() => doFit());
    ro.observe(box.current!);
    term.current = t;
    fit.current = f;
    (t as unknown as { _henryFit: () => void })._henryFit = doFit;
    return () => {
      ro.disconnect();
      t.dispose();
      term.current = null;
    };
  }, [sessionId]);

  // (Re)attach on mount and after every reconnect; scrollback replay repaints from scratch.
  useEffect(() => {
    const t = term.current;
    if (!t || !connectionId) return;
    t.reset();
    const unsub = subscribePty(sessionId, (m) => {
      if (m.type === "pty:exit") t.write(`\r\n\x1b[90m[henry] process exited with code ${m.exitCode}\x1b[0m\r\n`);
      else t.write(m.data);
    });
    send({ type: "attach", sessionId });
    return () => {
      unsub();
      send({ type: "detach", sessionId });
    };
  }, [sessionId, connectionId]);

  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      (term.current as unknown as { _henryFit?: () => void } | null)?._henryFit?.();
      term.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  return (
    <div
      ref={box}
      className="term"
      style={{ visibility: active ? "visible" : "hidden" }}
      onMouseDown={() => term.current?.focus()}
    />
  );
}
