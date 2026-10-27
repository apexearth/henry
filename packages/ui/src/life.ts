// The simulation behind the "life" scene (ContextLife draws it): Conway's Life on a coarse
// toroidal grid, fed by rain. Life left alone settles into a few percent of still "ash", so it
// cannot hold a density by itself; a controller does it instead. Each step it compares the live
// fraction with a target set by the context fraction, and a shortfall becomes rain that falls
// down a column and plants a seed where it lands, while a surplus is culled. The busyness on
// screen is therefore the context window, and the rain is how you watch it arrive. Pure: no DOM,
// so the controller can be tested.

/** Live fraction the controller holds the board at, for a context fraction `f`. */
export function targetDensity(f: number): number {
  const x = Math.min(1, Math.max(0, f));
  return 0.004 + 0.17 * x ** 1.3;
}

/** Generations a dead cell keeps glowing (the phosphor trail). */
export const FADE = 9;
/** Still life older than this starts to erode, so the ash never freezes into wallpaper. */
const OLD = 140;

export interface Drop {
  col: number;
  /** Head row, fractional; drawn snapped to the grid. */
  y: number;
  /** Rows per frame. */
  speed: number;
  /** Trail length in rows. */
  len: number;
  /** Row it plants its seed on; past the bottom, it just pours away. */
  land: number;
  /** Glyph salt, so trails shimmer differently. */
  salt: number;
}

// Seeds, as [dx, dy] cells. The R-pentomino and acorn run for hundreds of generations; the
// glider travels; the soups are mostly short-lived sparks.
const R_PENT = [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]];
const ACORN = [[1, 0], [3, 1], [0, 2], [1, 2], [4, 2], [5, 2], [6, 2]];
const GLIDER = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]]; // heading down-right

export class Life {
  cols = 0;
  rows = 0;
  /** 1 alive. */
  live = new Uint8Array(0);
  /** Generations alive (capped), 0 for a newborn. */
  age = new Uint16Array(0);
  /** Phosphor left by a dead cell, FADE down to 0. */
  glow = new Uint8Array(0);
  /** Glyph index per cell; kept while a cell lives, so still lifes keep their characters. */
  glyph = new Uint8Array(0);
  drops: Drop[] = [];
  population = 0;
  private next = new Uint8Array(0);
  private seed: number;

  constructor(cols: number, rows: number, seed = 1, readonly glyphs = 64) {
    this.seed = seed >>> 0 || 1;
    this.resize(cols, rows);
  }

  /** xorshift32: deterministic, so tests can pin behaviour. */
  rand(): number {
    let s = this.seed;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.seed = s >>> 0;
    return this.seed / 4294967296;
  }

  /** Keeps the overlapping region, so a resize does not wipe the board. */
  resize(cols: number, rows: number) {
    cols = Math.max(4, cols | 0);
    rows = Math.max(4, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    const old = { cols: this.cols, rows: this.rows, live: this.live, age: this.age, glow: this.glow, glyph: this.glyph };
    const n = cols * rows;
    this.live = new Uint8Array(n);
    this.age = new Uint16Array(n);
    this.glow = new Uint8Array(n);
    this.glyph = new Uint8Array(n);
    this.next = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.glyph[i] = (this.rand() * this.glyphs) | 0;
    for (let y = 0; y < Math.min(rows, old.rows); y++) {
      for (let x = 0; x < Math.min(cols, old.cols); x++) {
        const a = y * old.cols + x, b = y * cols + x;
        this.live[b] = old.live[a]!;
        this.age[b] = old.age[a]!;
        this.glow[b] = old.glow[a]!;
        this.glyph[b] = old.glyph[a]!;
      }
    }
    this.cols = cols;
    this.rows = rows;
    this.drops = this.drops.filter((d) => d.col < cols);
    this.count();
  }

  private count() {
    let p = 0;
    for (let i = 0; i < this.live.length; i++) p += this.live[i]!;
    this.population = p;
  }

  density(): number {
    return this.population / (this.cols * this.rows);
  }

  private set(x: number, y: number) {
    const c = this.cols, r = this.rows;
    const i = (((y % r) + r) % r) * c + (((x % c) + c) % c);
    if (!this.live[i]) {
      this.live[i] = 1;
      this.age[i] = 0;
      this.glyph[i] = (this.rand() * this.glyphs) | 0;
      this.population++;
    }
  }

  /** Plants a seed centred on (x, y): mostly the long-burning ones, sometimes a spark. */
  plant(x: number, y: number) {
    const r = this.rand();
    let cells: number[][];
    if (r < 0.35) cells = R_PENT;
    else if (r < 0.5) cells = ACORN;
    else if (r < 0.65) cells = GLIDER;
    else {
      cells = [];
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) if (this.rand() < 0.45) cells.push([dx, dy]);
    }
    const fx = this.rand() < 0.5 ? -1 : 1, fy = this.rand() < 0.5 ? -1 : 1, swap = this.rand() < 0.5;
    for (const [dx, dy] of cells) {
      const a = swap ? dy! : dx!, b = swap ? dx! : dy!;
      this.set(x + fx * a, y + fy * b);
    }
  }

  /** A glider launched from a random edge toward the middle: one per tool call. */
  launch() {
    const edge = (this.rand() * 4) | 0;
    let x: number, y: number;
    if (edge < 2) { x = edge ? this.cols - 4 : 1; y = (this.rand() * this.rows) | 0; }
    else { y = edge === 3 ? this.rows - 4 : 1; x = (this.rand() * this.cols) | 0; }
    // Point it inward on both axes: flip the down-right glider toward the centre.
    const fx = x > this.cols / 2 ? -1 : 1, fy = y > this.rows / 2 ? -1 : 1;
    for (const [dx, dy] of GLIDER) this.set(x + fx * dx!, y + fy * dy!);
  }

  /** A drop down `col` that lands somewhere in the lower `band` of the board (0..1). */
  rain(band: number, col = (this.rand() * this.cols) | 0) {
    const span = Math.max(2, Math.round(this.rows * Math.min(1, band)));
    this.drops.push({
      col, y: -1 - this.rand() * 6, speed: 0.35 + this.rand() * 0.45, len: 4 + ((this.rand() * 9) | 0),
      land: this.rows - 1 - ((this.rand() * span) | 0), salt: (this.rand() * 997) | 0,
    });
  }

  /** /compact: every living cell becomes a drop that pours off the bottom, and the board is
   * left with only its glow. Capped, so a dense board does not spawn thousands. */
  purge(cap = 900) {
    const lit: number[] = [];
    for (let i = 0; i < this.live.length; i++) if (this.live[i]) lit.push(i);
    const keep = lit.length > cap ? cap / lit.length : 1;
    for (const i of lit) {
      this.live[i] = 0;
      this.glow[i] = FADE;
      if (this.rand() > keep) continue;
      this.drops.push({
        col: i % this.cols, y: Math.floor(i / this.cols), speed: 0.25 + this.rand() * 0.6,
        len: 2 + ((this.rand() * 6) | 0), land: this.rows + 20, salt: (this.rand() * 997) | 0,
      });
    }
    this.population = 0;
  }

  /** Moves the rain one frame; a drop that reaches its row plants there. */
  fall() {
    let w = 0;
    for (const d of this.drops) {
      d.y += d.speed;
      if (d.y >= d.land) {
        if (d.land < this.rows) this.plant(d.col, d.land);
        continue;
      }
      if (d.y - d.len > this.rows) continue;
      this.drops[w++] = d;
    }
    this.drops.length = w;
  }

  /** One generation, then the controller: rain for a shortfall, a cull for a surplus. */
  step(f: number, band: number) {
    const { cols: c, rows: r, live, next, age, glow, glyph } = this;
    let pop = 0;
    for (let y = 0; y < r; y++) {
      const up = ((y + r - 1) % r) * c, mid = y * c, dn = ((y + 1) % r) * c;
      for (let x = 0; x < c; x++) {
        const l = (x + c - 1) % c, rr = (x + 1) % c;
        const n = live[up + l]! + live[up + x]! + live[up + rr]! + live[mid + l]! + live[mid + rr]! +
          live[dn + l]! + live[dn + x]! + live[dn + rr]!;
        const i = mid + x;
        const was = live[i]!;
        let on = n === 3 || (was === 1 && n === 2) ? 1 : 0;
        if (on && was && age[i]! > OLD && this.rand() < 0.004) on = 0; // erosion
        next[i] = on;
        if (on) {
          pop++;
          if (was) {
            if (age[i]! < 65535) age[i]!++;
            if (this.rand() < 0.015) glyph[i] = (this.rand() * this.glyphs) | 0; // the shimmer
          } else {
            age[i] = 0;
            glyph[i] = (this.rand() * this.glyphs) | 0;
          }
          glow[i] = 0;
        } else if (was) glow[i] = FADE;
        else if (glow[i]) glow[i]!--;
      }
    }
    this.live = next;
    this.next = live;
    this.population = pop;

    const n = c * r;
    const gap = targetDensity(f) - pop / n;
    if (gap > 0) {
      // Rain in proportion to the shortfall, counting what is already falling.
      const want = Math.min(6, Math.ceil((gap * n) / 40)) - this.drops.length / 8;
      for (let k = 0; k < want; k++) this.rain(band);
    } else if (gap < -0.005) {
      const p = Math.min(0.25, -gap * 3);
      const live2 = this.live;
      for (let i = 0; i < n; i++) {
        if (live2[i] && this.rand() < p) {
          live2[i] = 0;
          glow[i] = FADE;
          this.population--;
        }
      }
    }
  }
}
