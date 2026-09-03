// One xterm per session. Stays mounted while its dock tab is hidden so scroll position survives.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { isClaudeSession } from "@henry/shared";
import { getState, send, subscribePty, useStore } from "./ws";

interface Props {
  sessionId: string;
  /** On screen (the active tab of a visible group). Only visible terminals report their size. */
  visible: boolean;
  /** Visible and in the active group: takes keyboard focus. */
  focused: boolean;
}

export function TerminalView({ sessionId, visible, focused }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
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
    t.attachCustomKeyEventHandler((ev) => {
      // The window-level handler owns Cmd/Ctrl+1..9 and Cmd+↑/↓ (App.tsx).
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && (/^[1-9]$/.test(ev.key) || (ev.metaKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")))) return false;
      // Shift+Enter inserts a newline in Claude Code's prompt: send ESC CR, the sequence its own
      // /terminal-setup binds. Plain shells keep a normal Enter. keypress must be swallowed too or
      // xterm still emits "\r" from it.
      if (ev.key === "Enter" && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        const s = getState().sessions.find((x) => x.id === sessionId);
        if (!s || !isClaudeSession(s)) return true;
        if (ev.type === "keydown") send({ type: "pty:input", sessionId, data: "\x1b\r" });
        return false;
      }
      return true;
    });
    t.onData((data) => send({ type: "pty:input", sessionId, data }));

    let last = "";
    const doFit = () => {
      // A hidden dock tab has no size; fitting to it would shrink the PTY to nothing.
      if (!box.current?.clientWidth || !box.current.clientHeight) return;
      f.fit();
      const dims = `${t.cols}x${t.rows}`;
      // Hidden terminals stay quiet; the daemon takes the latest report.
      if (visibleRef.current && dims !== last) {
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
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      (term.current as unknown as { _henryFit?: () => void } | null)?._henryFit?.();
      if (focused) term.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible, focused]);

  return <div ref={box} className="term" onMouseDown={() => term.current?.focus()} />;
}
