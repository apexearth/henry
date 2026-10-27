// The "loom" scene's pattern (ContextLoom draws it): a session woven as it goes. Every prompt
// lays a weft thread across the pane in a new colour, and every tool call leaves a stroke of
// its own kind — a reading tool a long warp line, an edit a tight knot, a shell command a
// zig-zag, an agent a fan of filaments — so the cloth is a portrait of how the session went.
// The context fraction sets how much thread is on the loom: when the events are fewer than the
// window is full (a reload that only has the recent history, a long silent turn), plain weft
// makes up the difference. Past 70% the field turns turbulent; past 90% the cloth frays. A
// compaction rolls the cloth into a braid along the bottom. Everything is seeded from ids, so
// the same session replays to the same cloth. Pure: no DOM.

export type Kind = "weft" | "warp" | "knot" | "zig" | "fan" | "fill" | "fray";

export interface Stroke {
  kind: Kind;
  seed: number;
  /** Turn colour. */
  hue: number;
  /** The turn it was laid in; older turns recede as newer ones arrive. */
  turn: number;
  /** Start, as fractions of the pane. */
  fx: number;
  fy: number;
  /** Turbulence the field had when it was laid, 0..1. */
  turb: number;
}

/** One stroke as drawn: polylines in pane-height units, measured from the pane's top left. */
export interface Thread {
  lines: [number, number][][];
  width: number;
  alpha: number;
  /** Pane-height units of thread, for the ink count. */
  ink: number;
}

const TAU = Math.PI * 2;
/** Spacing between a thread's points, in pane heights. */
export const STEP = 0.006;
/** Thread laid by a full window, per unit of pane aspect (width / height). */
export const INK_FULL = 58;

export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32: a small seeded generator per stroke. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lattice(ix: number, iy: number, salt: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ salt;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise, 0..1. */
export function noise(x: number, y: number, salt: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const tx = x - ix, ty = y - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = lattice(ix, iy, salt), b = lattice(ix + 1, iy, salt);
  const c = lattice(ix, iy + 1, salt), d = lattice(ix + 1, iy + 1, salt);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** How far the current carries the cloth at (x, y) at time `t` (seconds), in pane heights: a
 * slow drift that swells and turns, so the cloth sways like silk in water. */
export function sway(x: number, y: number, t: number, salt: number, amp: number, out: [number, number]): [number, number] {
  const s = t * 0.07;
  out[0] = amp * (noise(x * 1.1 + s, y * 1.1 - s * 0.6, salt ^ 0x68e31da4) - 0.5) * 2;
  out[1] = amp * (noise(x * 1.1 - s * 0.8, y * 1.1 + s, salt ^ 0x1b56c4e9) - 0.5) * 2;
  return out; // written in place: the renderer calls this for every point of every frame
}

/** The field's bend at (x, y) in pane heights: a gentle swell, plus a fine chop as it turns turbulent. */
function bend(x: number, y: number, salt: number, turb: number): number {
  return (noise(x * 1.7, y * 1.7, salt) - 0.5) * TAU * 0.55 +
    turb * (noise(x * 6 + 31, y * 6 + 7, salt ^ 0x5bd1e995) - 0.5) * TAU * 1.1;
}

/** Turbulence for a context fraction: none below the amber line, rising to full at red. */
export function turbulence(f: number): number {
  return Math.min(1, Math.max(0, (f - 0.7) / 0.25));
}

/** Follows the field from (x, y) heading `dir`, pulled back toward `dir` by `hold` (0 free, 1 rigid). */
function flow(x: number, y: number, dir: number, hold: number, n: number, salt: number, turb: number, r: () => number) {
  const pts: [number, number][] = [[x, y]];
  let a = dir;
  for (let i = 0; i < n; i++) {
    const want = dir + bend(x, y, salt, turb);
    a += (want - a) * (1 - hold * 0.8) * 0.35 + (r() - 0.5) * 0.04;
    x += Math.cos(a) * STEP;
    y += Math.sin(a) * STEP;
    pts.push([x, y]);
  }
  return pts;
}

/** The stroke's polylines for a pane `aspect` wide (in pane heights). Deterministic in the stroke. */
export function weave(s: Stroke, aspect: number, salt: number): Thread {
  const r = rng(s.seed);
  const x = s.fx * aspect, y = s.fy;
  const t = s.turb;
  let lines: [number, number][][];
  let width = 1, alpha = 0.5;
  switch (s.kind) {
    case "weft": { // across the pane, the turn's opening thread, from either side
      const ltr = r() < 0.5;
      lines = [flow(ltr ? -0.02 : aspect + 0.02, y, ltr ? 0 : Math.PI, 0.6, Math.ceil((aspect + 0.1) / STEP), salt, t, r)];
      width = 1.3; alpha = 0.6;
      break;
    }
    case "warp": // a reading tool: a long run up or down the cloth
      lines = [flow(x, y, r() < 0.5 ? Math.PI / 2 : -Math.PI / 2, 0.45, 70 + ((r() * 80) | 0), salt, t, r)];
      width = 1; alpha = 0.5;
      break;
    case "knot": { // an edit: a few tight loops that drift a little as they turn
      const pts: [number, number][] = [];
      const rad = 0.012 + r() * 0.016, loops = 3 + ((r() * 3) | 0), n = loops * 28;
      const drift = bend(x, y, salt, t), ph = r() * TAU, k = 1.3 + r() * 0.8;
      for (let i = 0; i <= n; i++) {
        const u = (i / 28) * TAU;
        const d = (i / n) * 0.05;
        pts.push([x + Math.cos(drift) * d + rad * Math.cos(u + ph), y + Math.sin(drift) * d + rad * Math.sin(k * u + ph)]);
      }
      lines = [pts];
      width = 1.5; alpha = 0.62;
      break;
    }
    case "zig": { // a shell command: hard turns either side of the field
      const pts: [number, number][] = [[x, y]];
      let px = x, py = y, side = 1;
      const dir = bend(x, y, salt, t) + (r() < 0.5 ? 0 : Math.PI);
      for (let leg = 0; leg < 7 + ((r() * 6) | 0); leg++) {
        const a = dir + side * (0.9 + r() * 0.3), len = 6 + ((r() * 6) | 0);
        for (let i = 0; i < len; i++) {
          px += Math.cos(a) * STEP;
          py += Math.sin(a) * STEP;
          pts.push([px, py]);
        }
        side = -side;
      }
      lines = [pts];
      width = 1.1; alpha = 0.55;
      break;
    }
    case "fan": { // an agent: fine filaments spreading from one point
      const base = r() * TAU, n = 5 + ((r() * 4) | 0);
      lines = [];
      for (let i = 0; i < n; i++) lines.push(flow(x, y, base + (i - n / 2) * 0.32, 0.2, 50 + ((r() * 60) | 0), salt, t, r));
      width = 0.7; alpha = 0.45;
      break;
    }
    case "fill": // what the events did not account for: plain weft
      lines = [flow(x, y, r() < 0.5 ? 0 : Math.PI, 0.65, 130 + ((r() * 110) | 0), salt, t, r)];
      width = 0.9; alpha = 0.3;
      break;
    case "fray": { // past the red line: loose fibres curling off the cloth
      const pts: [number, number][] = [[x, y]];
      let a = r() * TAU, px = x, py = y;
      const curl = (r() - 0.5) * 0.5;
      for (let i = 0; i < 14 + ((r() * 22) | 0); i++) {
        a += curl + (r() - 0.5) * 0.3;
        px += Math.cos(a) * STEP * 0.8;
        py += Math.sin(a) * STEP * 0.8;
        pts.push([px, py]);
      }
      lines = [pts];
      width = 0.6; alpha = 0.4;
      break;
    }
  }
  let ink = 0;
  for (const l of lines) ink += (l.length - 1) * STEP;
  return { lines, width, alpha, ink };
}

/** The kind of stroke a tool leaves. */
export function kindFor(tool: string | undefined): Kind {
  if (!tool) return "warp";
  if (/^(Read|Grep|Glob|LS|WebFetch|WebSearch|NotebookRead)$/.test(tool) || tool.startsWith("mcp__")) return "warp";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return "knot";
  if (/^(Bash|BashOutput|KillShell|PowerShell)$/.test(tool)) return "zig";
  if (/^(Agent|Task|Workflow)$/.test(tool)) return "fan";
  return "warp";
}

/** The weave's state between events: whose turn it is, and where the cloth is thin. */
export class Loom {
  turn = 0;
  strokes: Stroke[] = [];
  /** Hue of each compaction braid, oldest first. */
  braids: number[] = [];
  ink = 0;
  /** Thread per cell of a coarse grid, so new strokes start where the cloth is thinnest. */
  private cover = new Float32Array(12 * 8);
  private r: () => number;

  constructor(readonly salt: number, public aspect = 1.6) {
    this.r = rng(salt ^ 0x9e3779b9);
  }

  hue(turn = this.turn): number {
    return ((this.salt % 360) + turn * 137.508) % 360;
  }

  /** Of a few candidate points, the one in the thinnest cell. */
  private spot(): [number, number] {
    let best: [number, number] = [this.r(), this.r()], low = Infinity;
    for (let k = 0; k < 5; k++) {
      const fx = 0.03 + this.r() * 0.94, fy = 0.03 + this.r() * 0.9;
      const c = this.cover[Math.min(7, (fy * 8) | 0) * 12 + Math.min(11, (fx * 12) | 0)]!;
      if (c < low) { low = c; best = [fx, fy]; }
    }
    return best;
  }

  /** Lays a stroke and returns it (with its geometry for the current aspect). */
  add(kind: Kind, seed: number, f: number): { stroke: Stroke; thread: Thread } {
    if (kind === "weft") this.turn++;
    const [fx, fy] = this.spot();
    const stroke: Stroke = { kind, seed, hue: this.hue(), turn: this.turn, fx, fy, turb: turbulence(f) };
    const thread = weave(stroke, this.aspect, this.salt);
    this.strokes.push(stroke);
    this.ink += thread.ink;
    for (const l of thread.lines) {
      for (let i = 0; i < l.length; i += 6) {
        const [x, y] = l[i]!;
        const cx = (x / this.aspect) * 12, cy = y * 8;
        if (cx >= 0 && cx < 12 && cy >= 0 && cy < 8) this.cover[(cy | 0) * 12 + (cx | 0)]! += STEP * 6;
      }
    }
    return { stroke, thread };
  }

  /** Thread a window `f` full should have on the loom, less what is there: plain weft makes it up. */
  owed(f: number): number {
    return Math.max(0, Math.min(1, f) * INK_FULL * this.aspect - this.ink);
  }

  /** Rolls the cloth up into a braid; the next turns weave on top of it. */
  rollUp() {
    this.braids.push(Math.round(this.hue()));
    this.strokes = [];
    this.ink = 0;
    this.cover.fill(0);
  }

  /** A seed for the next filler or fray, from the loom's own sequence. */
  nextSeed(): number {
    return (this.r() * 4294967296) >>> 0;
  }
}

/** The events a weave is made of, oldest first: prompts, tool calls, compactions. */
export interface Beat {
  id: string;
  kind: "prompt" | "tool" | "compact";
  tool?: string;
}

/** Rebuilds a session's loom from its history: what survives is what is after the last
 * compaction, with filler up to `f` and, past the red line, its fraying. */
export function replay(salt: number, aspect: number, beats: Beat[], f: number): Loom {
  const loom = new Loom(salt, aspect);
  const n = beats.length || 1;
  beats.forEach((b, i) => {
    // The history has no context fraction of its own: assume the window filled evenly.
    const at = (f * (i + 1)) / n;
    if (b.kind === "compact") loom.rollUp();
    else if (b.kind === "prompt") loom.add("weft", hashStr(b.id), at);
    else loom.add(kindFor(b.tool), hashStr(b.id), at);
  });
  for (let guard = 0; loom.owed(f) > 0 && guard < 400; guard++) loom.add("fill", loom.nextSeed(), f);
  const frays = Math.round(Math.max(0, f - 0.9) * 300);
  for (let i = 0; i < frays; i++) loom.add("fray", loom.nextSeed(), f);
  return loom;
}
