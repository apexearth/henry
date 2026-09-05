// A QR encoder, in one file, because the only thing Henry needs a QR for is a short URL and
// that is not worth a dependency on either side of the wire. Byte mode, error correction M,
// versions 1..6 (up to 108 bytes) — a phone-access URL is ~50 characters. Versions stop at 6
// on purpose: 7 and up carry a version-information block, and 10 and up widen the character
// count field, neither of which a URL this short will ever need.
//
// The output is a square of booleans (true = dark), no quiet zone; renderers add their own.

/** Error-correction level M: total codewords, EC codewords per block, blocks. Data = total − ec×blocks. */
const VERSIONS = [
  { total: 26, ecPerBlock: 10, blocks: 1 },
  { total: 44, ecPerBlock: 16, blocks: 1 },
  { total: 70, ecPerBlock: 26, blocks: 1 },
  { total: 100, ecPerBlock: 18, blocks: 2 },
  { total: 134, ecPerBlock: 24, blocks: 2 },
  { total: 172, ecPerBlock: 16, blocks: 4 },
];

/** Centre coordinates of the alignment patterns, by version. All pairs are used except the
 * three that would sit on a finder. */
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

export const QR_MAX_BYTES = VERSIONS[VERSIONS.length - 1]!.total - VERSIONS[VERSIONS.length - 1]!.ecPerBlock * VERSIONS[VERSIONS.length - 1]!.blocks - 2;

// ---- GF(256), the field the Reed-Solomon parity lives in (primitive polynomial 0x11d) ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

const mul = (a: number, b: number): number => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

/** g(x) = ∏(x − α^i), coefficients high-order first. */
function generator(n: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j]!; // ×x
      next[j + 1] ^= mul(g[j]!, EXP[i]!); // ×α^i
    }
    g = next;
  }
  return g;
}

/** The `n` parity codewords for one block: the remainder of data·x^n mod g(x). */
function parity(data: number[], n: number): number[] {
  const g = generator(n);
  const res = [...data, ...new Array<number>(n).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const c = res[i]!;
    if (!c) continue;
    for (let j = 0; j < g.length; j++) res[i + j] ^= mul(g[j]!, c);
  }
  return res.slice(data.length);
}

// ---- data ----

/** UTF-8 bytes, written out here because `shared` is neither a DOM nor a Node module and so
 * has neither TextEncoder nor Buffer. */
function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** The payload in byte mode, padded out to the version's data capacity. */
function dataCodewords(bytes: number[], version: number): number[] {
  const { total, ecPerBlock, blocks } = VERSIONS[version - 1]!;
  const capacity = total - ecPerBlock * blocks;
  const bits: number[] = [];
  const push = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // character count, 8 bits for versions 1..9
  for (const b of bytes) push(b, 8);
  // Terminator (up to four zeroes), then out to a whole byte.
  for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    out.push(b);
  }
  // The spec's pad bytes, alternating, until the block is full.
  for (let i = 0; out.length < capacity; i++) out.push(i % 2 ? 0x11 : 0xec);
  return out;
}

/** Blocks' data codewords interleaved, then their parity codewords interleaved. */
function interleave(data: number[], version: number): number[] {
  const { ecPerBlock, blocks } = VERSIONS[version - 1]!;
  const per = data.length / blocks;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let b = 0; b < blocks; b++) {
    const block = data.slice(b * per, (b + 1) * per);
    dataBlocks.push(block);
    ecBlocks.push(parity(block, ecPerBlock));
  }
  const out: number[] = [];
  for (let i = 0; i < per; i++) for (const b of dataBlocks) out.push(b[i]!);
  for (let i = 0; i < ecPerBlock; i++) for (const b of ecBlocks) out.push(b[i]!);
  return out;
}

// ---- the square ----

type Grid = boolean[][];

const blank = (size: number): Grid => Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

/** Finders, separators, timing, alignment, the dark module, and the format-info strips, drawn
 * into `m` and marked in `fixed` so the data never lands on them. */
function functionPatterns(m: Grid, fixed: Grid, version: number): void {
  const size = m.length;
  const set = (r: number, c: number, dark: boolean) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    m[r]![c] = dark;
    fixed[r]![c] = true;
  };
  // Three finders with their separators.
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const outside = r === -1 || r === 7 || c === -1 || c === 7;
        set(top + r, left + c, !outside && (edge || core));
      }
    }
  }
  // Timing: alternating, running between the finders.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Alignment: every pair of centres except those sitting on a finder.
  const centres = ALIGN[version - 1]!;
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }
  set(size - 8, 8, true); // the dark module
  // Reserve where the format information goes; the bits themselves are written after masking.
  for (let i = 0; i < 9; i++) {
    if (!fixed[8]![i]) set(8, i, false);
    if (!fixed[i]![8]) set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, false);
    if (size - 1 - i !== size - 8) set(size - 1 - i, 8, false);
  }
}

/** Codewords into the square: two columns at a time, right to left, alternating up and down,
 * stepping over the vertical timing column. */
function placeData(m: Grid, fixed: Grid, codewords: number[]): void {
  const size = m.length;
  let bit = 0;
  const next = (): boolean => {
    const b = bit < codewords.length * 8 && ((codewords[bit >> 3]! >> (7 - (bit & 7))) & 1) === 1;
    bit++;
    return b;
  };
  let up = true;
  let row = size - 1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        if (!fixed[row]![x]) m[row]![x] = next();
      }
      row += up ? -1 : 1;
      if (row < 0 || row >= size) {
        row -= up ? -1 : 1;
        up = !up;
        break;
      }
    }
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The four penalty rules; the mask with the lowest total wins. */
function penalty(m: Grid): number {
  const size = m.length;
  let score = 0;
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      // 1011101 with four light modules on one side, in either direction.
      const bits: boolean[] = [];
      for (let j = 0; j < size; j++) {
        bits.push(get(i, j));
        if (j > 0 && get(i, j) === get(i, j - 1)) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
      const s = bits.map((b) => (b ? "1" : "0")).join("");
      for (const pat of ["10111010000", "00001011101"]) {
        let at = s.indexOf(pat);
        while (at >= 0) {
          score += 40;
          at = s.indexOf(pat, at + 1);
        }
      }
    }
  };
  line((i, j) => m[i]![j]!);
  line((i, j) => m[j]![i]!);
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r]![c]!;
      if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** The 15-bit format value for error-correction level M and a mask: BCH(15,5), then the mask
 * pattern the spec XORs in so an all-zero format is never all-light. */
export function formatBits(mask: number): number {
  const value = (0b00 << 3) | mask; // 00 = level M
  let rem = value << 10;
  for (let i = 4; i >= 0; i--) if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
  return ((value << 10) | rem) ^ 0x5412;
}

function placeFormat(m: Grid, mask: number): void {
  const size = m.length;
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >> i) & 1) === 1;
  for (let i = 0; i < 6; i++) m[8]![i] = bit(i);
  m[8]![7] = bit(6);
  m[8]![8] = bit(7);
  m[7]![8] = bit(8);
  for (let i = 9; i < 15; i++) m[14 - i]![8] = bit(i);
  for (let i = 0; i < 7; i++) m[size - 1 - i]![8] = bit(i);
  for (let i = 7; i < 15; i++) m[8]![size - 15 + i] = bit(i);
}

/**
 * `text` as a QR square (true = dark), error correction M, no quiet zone.
 * Throws when the text is longer than version 6 holds (108 bytes of UTF-8, less the header).
 */
export function qrMatrix(text: string): boolean[][] {
  const bytes = utf8(text);
  const version = VERSIONS.findIndex(({ total, ecPerBlock, blocks }) => 12 + bytes.length * 8 <= (total - ecPerBlock * blocks) * 8) + 1;
  if (!version) throw new Error(`${bytes.length} bytes is too long for a QR of version 6 (max ${QR_MAX_BYTES})`);
  const size = 17 + 4 * version;
  const fixed = blank(size);
  const base = blank(size);
  functionPatterns(base, fixed, version);
  placeData(base, fixed, interleave(dataCodewords(bytes, version), version));

  let best: Grid | undefined;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.map((row) => [...row]);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fixed[r]![c] && MASKS[mask]!(r, c)) m[r]![c] = !m[r]![c];
    placeFormat(m, mask);
    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best!;
}

/** The square as text, two modules per character cell, for a terminal. */
export function qrText(text: string, quiet = 2): string {
  const m = qrMatrix(text);
  const size = m.length + quiet * 2;
  const dark = (r: number, c: number) => r >= quiet && c >= quiet && r < m.length + quiet && c < m.length + quiet && m[r - quiet]![c - quiet]!;
  const out: string[] = [];
  // Two rows per line as half blocks: a square QR in a terminal's tall character cells.
  for (let r = 0; r < size; r += 2) {
    let line = "";
    for (let c = 0; c < size; c++) {
      const top = dark(r, c);
      const bottom = r + 1 < size && dark(r + 1, c);
      // Dark modules are the terminal's background, so the code scans on a light-on-dark theme.
      line += top && bottom ? " " : top ? "▄" : bottom ? "▀" : "█";
    }
    out.push(line);
  }
  return out.join("\n");
}
