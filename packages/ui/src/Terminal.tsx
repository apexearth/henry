// One xterm per session. Stays mounted while its dock tab is hidden so scroll position survives.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { isClaudeSession } from "@henry/shared";
import { getState, send, subscribePty, useStore } from "./ws";
import { openPeek, splitLineRef } from "./FileView";
import { cssVar, onTheme, xtermTheme } from "./theme";

interface Props {
  sessionId: string;
  /** On screen (the active tab of a visible group). Only visible terminals report their size. */
  visible: boolean;
  /** Visible and in the active group: takes keyboard focus. */
  focused: boolean;
}

// Something with a slash in it, or a bare `name.ext`, optionally followed by `:line[:col]`.
// Loose on purpose: a ⌘-click on a non-file simply finds nothing.
const PATH_RE = /(?<![\w@:/.-])(?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)+(?::\d+(?::\d+)?)?|(?<![\w@:/.-])[\w@+-]+(?:\.[\w@+-]+)*\.[A-Za-z]{2,5}(?::\d+(?::\d+)?)?/g;

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
      fontFamily: cssVar("--mono"),
      fontSize: 13,
      scrollback: 10000,
      allowProposedApi: true,
      theme: xtermTheme(),
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
      // The window-level handlers own Cmd/Ctrl+1..9, Cmd+arrows and Cmd+K (App.tsx) and Cmd/Ctrl+N (Rail.tsx).
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && (ev.key === "n" || ev.key === "N")) return false;
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && (/^[1-9]$/.test(ev.key) || (ev.metaKey && (ev.key.startsWith("Arrow") || ev.key === "k" || ev.key === "K")))) return false;
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
    // ⌘-click a path in the output to peek at it. Relative paths resolve against the session's cwd.
    t.registerLinkProvider({
      provideLinks(y, cb) {
        const text = t.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const links = [];
        for (const m of text.matchAll(PATH_RE)) {
          const raw = m[0].replace(/[.,;:'")\]}]+$/, "");
          if (!raw || raw.length < 3) continue;
          links.push({
            range: { start: { x: m.index + 1, y }, end: { x: m.index + raw.length, y } },
            text: raw,
            decorations: { underline: true, pointerCursor: true },
            activate: (ev: MouseEvent, ref: string) => {
              if (!ev.metaKey && !ev.ctrlKey) return;
              const { path, line } = splitLineRef(ref);
              openPeek(path, getState().sessions.find((x) => x.id === sessionId)?.cwd, line);
            },
          });
        }
        cb(links.length ? links : undefined);
      },
    });

    let last = "";
    let nudge: ReturnType<typeof setTimeout> | undefined;
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
    // On becoming visible again, re-assert the size unconditionally. The PTY may already agree
    // with us while the app's last painted frame was wrapped for a different width, and a
    // same-size TIOCSWINSZ raises no SIGWINCH — so drop a row and restore it to force a redraw.
    const resync = () => {
      if (!box.current?.clientWidth || !box.current.clientHeight) return;
      f.fit();
      last = `${t.cols}x${t.rows}`;
      const { cols, rows } = t;
      if (rows > 1) send({ type: "pty:resize", sessionId, cols, rows: rows - 1 });
      nudge = setTimeout(() => send({ type: "pty:resize", sessionId, cols, rows }), 40);
    };
    doFit();
    const offTheme = onTheme(() => { t.options.theme = xtermTheme(); });
    const ro = new ResizeObserver(() => doFit());
    ro.observe(box.current!);
    term.current = t;
    fit.current = f;
    (t as unknown as { _henryFit: () => void })._henryFit = doFit;
    (t as unknown as { _henryResync: () => void })._henryResync = resync;
    return () => {
      ro.disconnect();
      offTheme();
      clearTimeout(nudge);
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

  // Becoming visible: re-measure and re-assert the size to the PTY.
  useEffect(() => {
    if (!visible) return;
    // Two frames: the first lets dockview finish laying the panel out, so the second measures a
    // box that has its real size. Fitting in a single frame can read 0 (or the pre-hide size).
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        (term.current as unknown as { _henryResync?: () => void } | null)?._henryResync?.();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [visible, sessionId]);

  useEffect(() => {
    if (!visible || !focused) return;
    const id = requestAnimationFrame(() => term.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [visible, focused]);

  return <div ref={box} className="term" onMouseDown={() => term.current?.focus()} />;
}
