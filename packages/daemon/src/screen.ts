// One headless terminal per session, so a window that attaches is handed the screen as it *is*
// rather than a replay of every byte that made it.
//
// sessiond keeps a 2 MB ring of raw PTY bytes (that is its job: outliving daemons). Replaying
// that ring into a fresh xterm was the old attach path, and it cannot work for a full-screen
// app: Claude Code repaints with absolute cursor addressing at whatever geometry the PTY had at
// the time, so every stale frame in the ring lands again, in the wrong rows, at the window's
// current size — and the ring's 2 MB cut falls mid escape sequence. The result was a scrollback
// full of interleaved old frames. Feeding the ring to an emulator instead and serialising *its*
// buffer collapses all of that into the state the bytes actually describe.
//
// The emulator lives here rather than in sessiond, which stays dependency-free on purpose. A
// daemon restart therefore loses these buffers; sessions.ts re-seeds them from the ring, which
// costs one imperfect reconstruction and is correct from the next byte on.
// Deep import on purpose; see xterm-serialize.d.ts.
import { SerializeAddon } from "@xterm/addon-serialize/lib/addon-serialize.mjs";
import { Terminal, type ITerminalAddon } from "@xterm/headless";
import { windowsBuild } from "./platform";

/** Lines of real scrollback kept per session. Frames collapse into state here, so this is far
 * more history than sessiond's 2 MB of raw bytes ever held for a repainting app. */
const SCROLLBACK = 5000;

/** Modes SerializeAddon restores itself: cursor keys, keypad, bracketed paste, insert, origin,
 * wraparound, focus reporting and the mouse tracking level. These it does not, and they matter:
 * Claude Code asks for SGR mouse encoding (?1006), and a window that reattached without it would
 * report the wheel in the legacy encoding, which the app reads as gibberish. ?2031 is the
 * colour-scheme change report. */
const EXTRA_MODES = new Set([1005, 1006, 1015, 1016, 2031]);
const MODE_RE = /\x1b\[\?([\d;]+)([hl])/g;

interface Screen {
  term: Terminal;
  ser: SerializeAddon;
  /** Handed to the emulator but not parsed yet. A snapshot is the parsed buffer plus this, so
   * a window that subscribes to live output in the same tick sees no gap and no repeat. */
  pending: string;
  /** EXTRA_MODES currently on. */
  extra: Set<number>;
  /** Trailing partial escape sequence, held over for the next chunk's mode scan. */
  tail: string;
}

class Screens {
  private map = new Map<string, Screen>();

  has(id: string): boolean {
    return this.map.has(id);
  }

  stats(): Record<string, number> {
    let pending = 0;
    for (const s of this.map.values()) pending += s.pending.length;
    return { screens: this.map.size, screenPendingChars: pending };
  }

  /** Start an emulator for a session, or return the one it has. */
  private ensure(id: string, cols: number, rows: number): Screen {
    let s = this.map.get(id);
    if (s) return s;
    // Same reason a window's xterm is told (ui/Terminal.tsx): under ConPTY this emulator must
    // not reflow its own scrollback on a width change, nor pull scrollback back into the
    // viewport when rows grow, where ConPTY's reprint lands on top of it. Untold, it ate its
    // own history on every resize — and this buffer is what an attaching window is handed.
    const term = new Terminal({
      cols: cols > 0 ? cols : 120,
      rows: rows > 0 ? rows : 36,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
      ...(windowsBuild ? { windowsPty: { backend: "conpty" as const, buildNumber: windowsBuild } } : {}),
    });
    const ser = new SerializeAddon();
    term.loadAddon(ser as ITerminalAddon);
    s = { term, ser, pending: "", extra: new Set(), tail: "" };
    this.map.set(id, s);
    return s;
  }

  /** A session Henry just spawned, or one being rebuilt from sessiond's ring after a restart. */
  open(id: string, cols: number, rows: number, seed?: string): void {
    this.ensure(id, cols, rows);
    if (seed) this.write(id, seed);
  }

  write(id: string, data: string): void {
    const s = this.map.get(id);
    if (!s) return;
    s.pending += data;
    // Write callbacks fire in order, so trimming each chunk's length off the front is exact.
    s.term.write(data, () => {
      s.pending = s.pending.slice(data.length);
    });
    this.noteModes(s, data);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.map.get(id);
    if (!s || cols < 1 || rows < 1 || (s.term.cols === cols && s.term.rows === rows)) return;
    s.term.resize(cols, rows);
  }

  /** What a window should be sent on attach: the buffer, its modes, and anything still in flight. */
  snapshot(id: string): string | undefined {
    const s = this.map.get(id);
    if (!s) return undefined;
    let out = s.ser.serialize({ scrollback: SCROLLBACK });
    for (const m of s.extra) out += `\x1b[?${m}h`;
    return out + s.pending;
  }

  forget(id: string): void {
    this.map.get(id)?.term.dispose();
    this.map.delete(id);
  }

  /** The handful of modes the serializer does not carry, tracked off the raw stream. `tail` only
   * ever holds an unterminated sequence, so rescanning it cannot double-count a complete one. */
  private noteModes(s: Screen, data: string): void {
    const buf = s.tail + data;
    MODE_RE.lastIndex = 0;
    for (const m of buf.matchAll(MODE_RE)) {
      for (const part of m[1]!.split(";")) {
        const n = Number(part);
        if (!EXTRA_MODES.has(n)) continue;
        if (m[2] === "h") s.extra.add(n);
        else s.extra.delete(n);
      }
    }
    const start = buf.lastIndexOf("\x1b");
    const rest = start >= 0 ? buf.slice(start) : "";
    s.tail = rest && !/[a-zA-Z]/.test(rest.slice(2)) ? rest.slice(0, 64) : "";
  }
}

export const screens = new Screens();
