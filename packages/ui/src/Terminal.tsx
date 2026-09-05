// One xterm per session. Stays mounted while its dock tab is hidden so scroll position survives.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { isClaudeSession } from "@henry/shared";
import { getState, send, subscribePty, useStore } from "./ws";
import { openPeek, splitLineRef } from "./FileView";
import { arrowMod, isMac, mod } from "./platform";
import { cssVar, onTheme, xtermTheme } from "./theme";

interface Props {
  sessionId: string;
  /** On screen (the active tab of a visible group). Only visible terminals report their size. */
  visible: boolean;
  /** Visible and in the active group: takes keyboard focus. On a phone this stays false: the
   * on-screen keyboard belongs to the input bar, not to xterm's hidden textarea. */
  focused: boolean;
  /** Points, default 13. The phone zooms out to fit 80 columns on a 390px screen. */
  fontSize?: number;
}

const DEFAULT_FONT_SIZE = 13;

// Something with a slash (or, for Windows, a backslash or drive letter) in it, or a bare
// `name.ext`, optionally followed by `:line[:col]`. Loose on purpose: a ⌘-click on a non-file
// simply finds nothing.
const PATH_RE = /(?<![\w@:/.\\-])(?:[A-Za-z]:)?(?:~[\\/]|\.{1,2}[\\/]|[\\/])?[\w.@+-]+(?:[\\/][\w.@+-]+)+(?::\d+(?::\d+)?)?|(?<![\w@:/.\\-])[\w@+-]+(?:\.[\w@+-]+)*\.[A-Za-z]{2,5}(?::\d+(?::\d+)?)?/g;
// Terminal-to-host reports: DA1/DA2/DSR/CPR, DECRQM, OSC and DCS replies, focus events.
const REPORT_RE = /^\x1b(\[[?>]?[\d;]*[cRn]|\[\?[\d;]*\$y|\][^\x07\x1b]*(\x07|\x1b\\)|P[^\x1b]*\x1b\\|\[[IO])/;

export function TerminalView({ sessionId, visible, focused, fontSize }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Read at creation only; changes go through the effect below so the terminal is not rebuilt.
  const sizeRef = useRef(fontSize);
  sizeRef.current = fontSize;
  const connectionId = useStore((s) => s.connectionId);
  const replaying = useRef(false);

  useEffect(() => {
    const t = new Terminal({
      cursorBlink: true,
      fontFamily: cssVar("--mono"),
      fontSize: sizeRef.current ?? DEFAULT_FONT_SIZE,
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
      // The window-level handlers own Cmd/Ctrl+1..9, Cmd+arrows, Cmd+K, Cmd+F and Cmd+/ (App.tsx)
      // and Cmd/Ctrl+N (Rail.tsx); off macOS the arrows and N sit on Alt and / on Ctrl instead.
      const n = ev.key === "n" || ev.key === "N";
      if (n && !ev.shiftKey && ((ev.metaKey || ev.ctrlKey) && !ev.altKey || (!isMac && ev.altKey && !ev.ctrlKey))) return false;
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && (/^[1-9]$/.test(ev.key) || (ev.metaKey && /^[kf]$/i.test(ev.key)) || (mod(ev) && ev.key === "/"))) return false;
      if (arrowMod(ev) && !ev.ctrlKey && ev.key.startsWith("Arrow")) return false;
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
    t.onData((data) => {
      // Scrollback replay re-parses old device queries (DA, DSR, OSC colour asks) and xterm
      // answers each one again; the app that asked is long gone, so the reply would land in
      // the shell as typed text ("1;2c"). Drop reports while replaying, keep keystrokes.
      if (replaying.current && REPORT_RE.test(data)) return;
      send({ type: "pty:input", sessionId, data });
    });
    // ⌘-click belongs to Henry (the link provider below). While an app has mouse tracking on,
    // xterm also reports the press to the PTY, and Claude Code answers by opening the file
    // itself — so one click peeked *and* jumped to Finder. Swallow the press on .xterm-screen:
    // the linkifier listens there and has already seen it, while the PTY report and the
    // selection start are bound on .xterm, one level up.
    const screen = box.current!.querySelector(".xterm-screen");
    const swallowModClick = (ev: Event) => {
      const e = ev as MouseEvent;
      if (e.button !== 0 || (!e.metaKey && !e.ctrlKey)) return;
      e.preventDefault();
      e.stopPropagation();
      t.focus(); // .xterm's handler would have done this
    };
    screen?.addEventListener("mousedown", swallowModClick);
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
    // On becoming visible again, re-assert the size unconditionally and ask for a repaint. The
    // PTY may already agree with us while the app's last painted frame was wrapped for a
    // different width; how the daemon provokes the redraw depends on the PTY's platform.
    const resync = () => {
      if (!box.current?.clientWidth || !box.current.clientHeight) return;
      f.fit();
      last = `${t.cols}x${t.rows}`;
      send({ type: "pty:resize", sessionId, cols: t.cols, rows: t.rows, redraw: true });
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
      screen?.removeEventListener("mousedown", swallowModClick);
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
      else if (m.type === "pty:scrollback") {
        replaying.current = true;
        t.write(m.data, () => (replaying.current = false));
      } else t.write(m.data);
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

  // Zooming: same terminal, new cell size, so the PTY is told about the new column count.
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    const next = fontSize ?? DEFAULT_FONT_SIZE;
    if (t.options.fontSize === next) return;
    t.options.fontSize = next;
    (t as unknown as { _henryFit?: () => void })._henryFit?.();
  }, [fontSize]);

  return <div ref={box} className="term" onMouseDown={() => term.current?.focus()} />;
}
