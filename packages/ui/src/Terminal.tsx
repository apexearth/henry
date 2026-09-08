// One xterm per session. Stays mounted while its dock tab is hidden so scroll position survives.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { isClaudeSession } from "@henry/shared";
import { getState, send, subscribePty, useStore } from "./ws";
import { openPeek, splitLineRef } from "./FileView";
import { arrowMod, isMac, mod } from "./platform";
import { cellBgAlpha, cssVar, onTheme, xtermTheme } from "./theme";

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

/** How long a resize has to settle before the PTY hears about it. Every resize costs ConPTY a
 * full reprint of the screen, and dragging a sash fires the observer on every frame. */
const RESIZE_SETTLE_MS = 120;

// Something with a slash (or, for Windows, a backslash or drive letter) in it, or a bare
// `name.ext`, optionally followed by `:line[:col]`. Loose on purpose: a ⌘-click on a non-file
// simply finds nothing.
const PATH_RE = /(?<![\w@:/.\\-])(?:[A-Za-z]:)?(?:~[\\/]|\.{1,2}[\\/]|[\\/])?[\w.@+-]+(?:[\\/][\w.@+-]+)+(?::\d+(?::\d+)?)?|(?<![\w@:/.\\-])[\w@+-]+(?:\.[\w@+-]+)*\.[A-Za-z]{2,5}(?::\d+(?::\d+)?)?/g;
// Terminal-to-host reports: DA1/DA2/DSR/CPR, DECRQM, OSC and DCS replies, focus events.
const REPORT_RE = /^\x1b(\[[?>]?[\d;]*[cRn]|\[\?[\d;]*\$y|\][^\x07\x1b]*(\x07|\x1b\\)|P[^\x1b]*\x1b\\|\[[IO])/;

// A background rectangle in xterm's WebGL renderer: 8 floats, alpha last.
const RECT_FLOATS = 8, RECT_ALPHA = 7;
interface RectRenderer { _vertices: { attributes: Float32Array; count: number }; renderBackgrounds(): void }
let softened = false;

/** xterm's WebGL renderer hardcodes alpha 1 on every cell background it paints, so a line an app
 * gives a background colour lands as a solid slab in front of the context wall, while the
 * terminal's own background is see-through. Re-alpha the rectangles on their way to the GPU.
 * Patched on the prototype, once: the renderer is rebuilt on a WebGL context restore. Rectangle 0
 * is the viewport, which already carries the theme background's own alpha. */
function softenCellBackgrounds(webgl: WebglAddon) {
  if (softened) return;
  const inner = webgl as unknown as { _renderer?: { _rectangleRenderer?: { value?: RectRenderer } } };
  const proto = inner._renderer?._rectangleRenderer?.value && Object.getPrototypeOf(inner._renderer._rectangleRenderer.value!);
  const orig = proto?.renderBackgrounds;
  if (typeof orig !== "function") return; // xterm changed shape: leave the slabs opaque
  softened = true;
  proto.renderBackgrounds = function (this: RectRenderer) {
    const a = cellBgAlpha();
    for (let i = 1; i < this._vertices.count; i++) this._vertices.attributes[i * RECT_FLOATS + RECT_ALPHA] = a;
    orig.call(this);
  };
}

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
  // ConPTY wraps its own lines and, before build 21376, marks none of them: told this, xterm
  // stops reflowing the scrollback on a resize (which would re-wrap what ConPTY already
  // wrapped) and keeps scrollback out of the viewport when rows grow, where ConPTY's reprint
  // would overwrite it. It comes off the session, not the daemon: a window here can be drawing
  // a session hosted on a Windows machine across a federation link, and vice versa. Read at
  // creation and re-applied below, since the session can land after the terminal is built.
  const windowsBuild = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.windowsBuild);
  const winRef = useRef(windowsBuild);
  winRef.current = windowsBuild;
  const replaying = useRef(false);

  useEffect(() => {
    const t = new Terminal({
      cursorBlink: true,
      fontFamily: cssVar("--mono"),
      fontSize: sizeRef.current ?? DEFAULT_FONT_SIZE,
      scrollback: 10000,
      allowProposedApi: true,
      // Always on, so toggling the context wall is a theme change and not a terminal rebuild.
      allowTransparency: true,
      theme: xtermTheme(),
      ...(winRef.current ? { windowsPty: { backend: "conpty" as const, buildNumber: winRef.current } } : {}),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(box.current!);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      t.loadAddon(webgl);
      softenCellBackgrounds(webgl);
    } catch (e) {
      console.warn("[henry] WebGL renderer unavailable, using DOM renderer", e);
    }
    t.attachCustomKeyEventHandler((ev) => {
      // Copy and paste. On macOS ⌘C/⌘V pass straight through to the browser and already work;
      // off macOS xterm turns Ctrl+C/Ctrl+V into ^C and ^V, so the terminal had no clipboard keys
      // at all. Give them back the way Windows Terminal does: Ctrl+C copies only when something is
      // selected and drops the selection, so a second press still interrupts. Paste is left to the
      // browser — its paste event lands on xterm's textarea, which brackets the text itself.
      if (!isMac && ev.ctrlKey && !ev.altKey && !ev.metaKey && /^[cv]$/i.test(ev.key)) {
        if (/v/i.test(ev.key)) return false;
        if (!ev.shiftKey && !t.hasSelection()) return true; // nothing selected: Ctrl+C is still SIGINT
        ev.preventDefault(); // xterm's own copy handler would race our write with an empty selection
        if (ev.type === "keydown" && t.hasSelection()) {
          void navigator.clipboard?.writeText(t.getSelection());
          t.clearSelection();
        }
        return false;
      }
      // The window-level handlers own Cmd/Ctrl+1..9, Cmd+arrows, Cmd+K, Cmd+F and Cmd+/ (App.tsx)
      // and Cmd/Ctrl+N (Rail.tsx); off macOS the arrows and N sit on Alt and / on Ctrl instead.
      const n = ev.key === "n" || ev.key === "N";
      if (n && !ev.shiftKey && ((ev.metaKey || ev.ctrlKey) && !ev.altKey || (!isMac && ev.altKey && !ev.ctrlKey))) return false;
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && (/^[1-9]$/.test(ev.key) || (ev.metaKey && /^[kf]$/i.test(ev.key)) || (mod(ev) && ev.key === "/"))) return false;
      // Off macOS the explorer sits on Alt+F in here, since Ctrl+F stays the terminal's forward-char.
      if (!isMac && ev.altKey && !ev.ctrlKey && !ev.metaKey && /^f$/i.test(ev.key)) return false;
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

    // Drag to scroll. xterm has touch handling of its own, but it stands down whenever an app has
    // mouse tracking on — Claude Code always does — and the scrollable viewport a finger would
    // otherwise pan sits *under* .xterm-screen, so it never sees the touch either. On a phone
    // that left the scrollback unreachable: there is no wheel to fall back on. Turn a drag into
    // wheel events aimed at the terminal, the same path the mouse wheel takes, so touch inherits
    // whatever the wheel already does here — reported to an app that asked for it, arrow keys on
    // an alt screen, or the viewport moving — instead of a second scrolling story to keep true.
    // A line of travel is a notch of wheel, so a drag moves the text the distance the finger went.
    const SLOP = 6; // px of travel before a tap becomes a drag
    const FRICTION = 0.94, FLICK_MIN = 2, COAST_MIN = 0.5; // px/frame
    let dragging = false, dragged = false, startY = 0, lastY = 0, lastT = 0, velocity = 0, carry = 0, coast = 0;
    const notch = (px: number) => screen?.dispatchEvent(new WheelEvent("wheel", { deltaY: px, deltaMode: 0, bubbles: true, cancelable: true }));
    const scrollPx = (px: number) => {
      // .xterm-screen is exactly rows tall, which is the cell height without reaching into xterm.
      const cell = (screen?.clientHeight ?? 0) / t.rows || (t.options.fontSize ?? DEFAULT_FONT_SIZE);
      carry += px;
      const lines = Math.trunc(carry / cell);
      if (!lines) return;
      carry -= lines * cell;
      for (let i = 0; i < Math.abs(lines); i++) notch(Math.sign(lines) * cell);
    };
    const onTouchStart = (ev: TouchEvent) => {
      cancelAnimationFrame(coast);
      coast = 0;
      dragging = ev.touches.length === 1;
      if (!dragging) return; // two fingers: leave the browser its pinch
      ev.stopPropagation(); // xterm's own touch scroll would move the viewport a second time
      dragged = false;
      velocity = carry = 0;
      startY = lastY = ev.touches[0]!.clientY;
      lastT = ev.timeStamp;
    };
    const onTouchMove = (ev: TouchEvent) => {
      if (!dragging || ev.touches.length !== 1) return;
      ev.stopPropagation();
      const y = ev.touches[0]!.clientY;
      if (!dragged && Math.abs(y - startY) < SLOP) return;
      dragged = true;
      ev.preventDefault(); // a cancelled move is what keeps the drag from landing on the app as a click
      const dy = lastY - y; // finger up, text up: the buffer follows the finger
      const dt = ev.timeStamp - lastT;
      if (dt > 0) velocity = (dy / dt) * 16;
      lastY = y;
      lastT = ev.timeStamp;
      scrollPx(dy);
    };
    const onTouchEnd = () => {
      if (!dragging) return;
      dragging = false;
      if (!dragged || Math.abs(velocity) < FLICK_MIN) return;
      // A flick coasts and settles, the way every other scroller on the phone does.
      const step = () => {
        velocity *= FRICTION;
        if (Math.abs(velocity) < COAST_MIN) return void (coast = 0);
        scrollPx(velocity);
        coast = requestAnimationFrame(step);
      };
      coast = requestAnimationFrame(step);
    };
    screen?.addEventListener("touchstart", onTouchStart as EventListener, { passive: true });
    screen?.addEventListener("touchmove", onTouchMove as EventListener, { passive: false });
    screen?.addEventListener("touchend", onTouchEnd);
    screen?.addEventListener("touchcancel", onTouchEnd);

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
    let settle: ReturnType<typeof setTimeout> | undefined;
    const doFit = () => {
      // A hidden dock tab has no size; fitting to it would shrink the PTY to nothing.
      if (!box.current?.clientWidth || !box.current.clientHeight) return;
      f.fit();
      const dims = `${t.cols}x${t.rows}`;
      // Hidden terminals stay quiet; the daemon takes the latest report.
      if (visibleRef.current && dims !== last) {
        last = dims;
        clearTimeout(settle);
        settle = setTimeout(() => send({ type: "pty:resize", sessionId, cols: t.cols, rows: t.rows }), RESIZE_SETTLE_MS);
      }
    };
    // On becoming visible again, re-assert the size unconditionally and ask for a repaint. The
    // PTY may already agree with us while the app's last painted frame was wrapped for a
    // different width; how the daemon provokes the redraw depends on the PTY's platform.
    const resync = () => {
      if (!box.current?.clientWidth || !box.current.clientHeight) return;
      f.fit();
      last = `${t.cols}x${t.rows}`;
      clearTimeout(settle);
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
      clearTimeout(settle);
      offTheme();
      cancelAnimationFrame(coast);
      screen?.removeEventListener("mousedown", swallowModClick);
      screen?.removeEventListener("touchstart", onTouchStart as EventListener);
      screen?.removeEventListener("touchmove", onTouchMove as EventListener);
      screen?.removeEventListener("touchend", onTouchEnd);
      screen?.removeEventListener("touchcancel", onTouchEnd);
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

  // The session that carries its PTY host's Windows build may arrive after this terminal was
  // built; xterm reads the option on every buffer resize, so setting it late still counts.
  useEffect(() => {
    const t = term.current;
    if (!t || !windowsBuild) return;
    t.options.windowsPty = { backend: "conpty", buildNumber: windowsBuild };
  }, [windowsBuild]);

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
