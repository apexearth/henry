// Long input reaches a session in pieces.
//
// Claude Code reads a burst of input as a paste. On Windows, ConPTY hands a burst of a few
// thousand characters to the program in several reads, and Claude Code then kept only some of
// them: a dictated paragraph sent from the phone arrived as its last few hundred characters.
// Pieces a few hundred characters long, a beat apart, are read as typing and all of them land.
// A bracketed paste (a desk window's ⌘V into a program that asked for one) goes as it came:
// splitting that would be typing it, newlines and all.

/** Read as typing by Claude Code, not as a paste. */
export const PIECE_CHARS = 400;
/** Between the pieces of one write. */
export const PIECE_GAP_MS = 50;
/** Before a later write that queued behind a long one: the composer's Enter goes on its own
 * a beat after the line, and must not join the line's last piece. */
export const WRITE_GAP_MS = 150;

const PASTE_START = "\x1b[200~";

/** `data` cut into pieces of at most `max`, at a space where there is one, and never between
 * the two halves of a surrogate pair. Short input and bracketed pastes come back whole. */
export function pieces(data: string, max = PIECE_CHARS): string[] {
  if (data.length <= max || data.includes(PASTE_START)) return [data];
  const out: string[] = [];
  let rest = data;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max - 1) + 1;
    if (cut < max / 2) cut = max;
    const c = rest.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut--;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * One queue per session. A write goes straight out when nothing is in flight and it is short;
 * otherwise it waits its turn, so keystrokes and the Enter after a long line keep their order.
 */
export class Typist {
  private queues = new Map<string, Queue>();

  constructor(private send: (id: string, data: string) => void, private alive: (id: string) => boolean) {}

  write(id: string, data: string): void {
    const parts = pieces(data);
    let q = this.queues.get(id);
    if (!q) {
      this.send(id, parts.shift()!);
      if (!parts.length) return;
      q = { items: parts.map((p) => ({ data: p, gap: PIECE_GAP_MS })) };
      this.queues.set(id, q);
    } else {
      parts.forEach((p, i) => q!.items.push({ data: p, gap: i === 0 ? WRITE_GAP_MS : PIECE_GAP_MS }));
    }
    if (!q.timer) this.pump(id, q);
  }

  private pump(id: string, q: Queue): void {
    const head = q.items.shift();
    if (!head) {
      // The last piece is out. The line stays held a moment longer, so an Enter that arrives
      // just after it still goes a beat later rather than in the same read.
      q.timer = setTimeout(() => {
        q.timer = undefined;
        if (q.items.length) this.pump(id, q);
        else this.queues.delete(id);
      }, WRITE_GAP_MS);
      return;
    }
    q.timer = setTimeout(() => {
      q.timer = undefined;
      if (!this.alive(id)) return void this.queues.delete(id);
      this.send(id, head.data);
      this.pump(id, q);
    }, head.gap);
  }
}

interface Queue {
  items: { data: string; gap: number }[];
  timer?: ReturnType<typeof setTimeout>;
}
