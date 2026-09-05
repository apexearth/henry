// The QR encoder, checked by reading its own output back the way a scanner does: find the
// format information, undo the mask, walk the zigzag, de-interleave the blocks, confirm every
// block's Reed-Solomon syndromes are zero, and decode the byte-mode payload. The reader here
// is written from the spec rather than from qr.ts, so a mistake in one does not hide in both.
import { describe, expect, test } from "bun:test";
import { QR_MAX_BYTES, formatBits, qrMatrix, qrText } from "@henry/shared";

// ---- an independent GF(256), for the syndrome check ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

const M_BLOCKS: Record<number, { ecPerBlock: number; blocks: number; total: number }> = {
  21: { total: 26, ecPerBlock: 10, blocks: 1 },
  25: { total: 44, ecPerBlock: 16, blocks: 1 },
  29: { total: 70, ecPerBlock: 26, blocks: 1 },
  33: { total: 100, ecPerBlock: 18, blocks: 2 },
  37: { total: 134, ecPerBlock: 24, blocks: 2 },
  41: { total: 172, ecPerBlock: 16, blocks: 4 },
};
const ALIGN: Record<number, number[]> = { 21: [], 25: [6, 18], 29: [6, 22], 33: [6, 26], 37: [6, 30], 41: [6, 34] };

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

/** Every module a scanner knows is not data: finders, separators, timing, alignment, the dark
 * module and the two format strips. */
function functionModules(size: number): boolean[][] {
  const f = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (r: number, c: number) => {
    if (r >= 0 && c >= 0 && r < size && c < size) f[r]![c] = true;
  };
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(top + r, left + c);
  }
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  for (const r of ALIGN[size]!) {
    for (const c of ALIGN[size]!) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  mark(size - 8, 8);
  for (let i = 0; i < 9; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  return f;
}

/** Format information as a scanner reads it: the copy around the top-left finder, un-XORed,
 * with its BCH remainder checked. */
function readFormat(m: boolean[][]): { level: number; mask: number } {
  const size = m.length;
  const bit = (r: number, c: number) => (m[r]![c] ? 1 : 0);
  let raw = 0;
  const put = (i: number, v: number) => (raw |= v << i);
  for (let i = 0; i < 6; i++) put(i, bit(8, i));
  put(6, bit(8, 7));
  put(7, bit(8, 8));
  put(8, bit(7, 8));
  for (let i = 9; i < 15; i++) put(i, bit(14 - i, 8));
  // The second copy must say the same thing.
  let raw2 = 0;
  for (let i = 0; i < 7; i++) raw2 |= bit(size - 1 - i, 8) << i;
  for (let i = 7; i < 15; i++) raw2 |= bit(8, size - 15 + i) << i;
  expect(raw2).toBe(raw);
  const value = raw ^ 0x5412;
  // BCH(15,5): the whole 15-bit word must be divisible by 0x537.
  let rem = value;
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
  expect(rem).toBe(0);
  return { level: value >> 13, mask: (value >> 10) & 7 };
}

/** The data region, unmasked, in the spec's zigzag order. */
function readCodewords(m: boolean[][], mask: number): number[] {
  const size = m.length;
  const fixed = functionModules(size);
  const bits: number[] = [];
  let up = true;
  let row = size - 1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        if (!fixed[row]![x]) bits.push((m[row]![x] !== MASKS[mask]!(row, x)) ? 1 : 0);
      }
      row += up ? -1 : 1;
      if (row < 0 || row >= size) {
        row -= up ? -1 : 1;
        up = !up;
        break;
      }
    }
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    out.push(b);
  }
  return out;
}

/** Full round trip: every block's parity checks out and the payload is the text that went in. */
function decode(m: boolean[][]): string {
  const size = m.length;
  const { level, mask } = readFormat(m);
  expect(level).toBe(0); // M
  const { total, ecPerBlock, blocks } = M_BLOCKS[size]!;
  const codewords = readCodewords(m, mask).slice(0, total);
  expect(codewords.length).toBe(total);
  const dataPer = (total - ecPerBlock * blocks) / blocks;
  // De-interleave, then check each block is a valid Reed-Solomon codeword (all syndromes zero).
  const data: number[][] = Array.from({ length: blocks }, () => []);
  const ec: number[][] = Array.from({ length: blocks }, () => []);
  for (let i = 0; i < dataPer * blocks; i++) data[i % blocks]!.push(codewords[i]!);
  for (let i = 0; i < ecPerBlock * blocks; i++) ec[i % blocks]!.push(codewords[dataPer * blocks + i]!);
  for (let b = 0; b < blocks; b++) {
    const word = [...data[b]!, ...ec[b]!];
    for (let s = 0; s < ecPerBlock; s++) {
      let sum = 0;
      for (const c of word) sum = mul(sum, EXP[s]!) ^ c;
      expect(sum).toBe(0);
    }
  }
  const stream = data.flat();
  expect(stream[0]! >> 4).toBe(0b0100); // byte mode
  const len = ((stream[0]! & 0xf) << 4) | (stream[1]! >> 4);
  const bytes: number[] = [];
  for (let i = 0; i < len; i++) bytes.push(((stream[1 + i]! & 0xf) << 4) | (stream[2 + i]! >> 4));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

describe("qr", () => {
  test("format information is the spec's BCH word for every mask", () => {
    // The eight level-M format strings from ISO 18004 Annex C.
    const expected = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
    for (let mask = 0; mask < 8; mask++) expect(formatBits(mask)).toBe(expected[mask]);
  });

  test("finder, timing and dark modules are where a scanner looks for them", () => {
    const m = qrMatrix("https://example.com");
    const size = m.length;
    for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
      expect(m[top]![left]).toBe(true);
      expect(m[top + 1]![left + 1]).toBe(false);
      expect(m[top + 3]![left + 3]).toBe(true);
    }
    for (let i = 8; i < size - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
    expect(m[size - 8]![8]).toBe(true);
  });

  test("every version reads back to the text that went in", () => {
    const cases = [
      "H",
      "http://100.64.1.2:14714/",
      "http://100.64.1.2:14714/?i=ABCD-EFGH-IJKL",
      "http://100.101.102.103:14714/?i=ABCD-EFGH-IJKL#phone",
      "x".repeat(80),
      "y".repeat(QR_MAX_BYTES),
      "héllo ünïcode ✦ 100.64.1.2",
    ];
    const sizes = new Set<number>();
    for (const text of cases) {
      const m = qrMatrix(text);
      expect(m.length).toBe(m[0]!.length);
      sizes.add(m.length);
      expect(decode(m)).toBe(text);
    }
    // The cases above should exercise several versions, not just the largest.
    expect(sizes.size).toBeGreaterThan(3);
  });

  test("the smallest version that fits is the one used, and longer than v6 is refused", () => {
    expect(qrMatrix("x".repeat(14)).length).toBe(21); // v1 holds 16 data codewords − 2 of header
    expect(qrMatrix("x".repeat(15)).length).toBe(25);
    expect(qrMatrix("x".repeat(QR_MAX_BYTES)).length).toBe(41);
    expect(() => qrMatrix("x".repeat(QR_MAX_BYTES + 1))).toThrow(/too long/);
  });

  test("the text rendering is square and has a quiet zone", () => {
    const art = qrText("http://100.64.1.2:14714/", 2);
    const lines = art.split("\n");
    const size = qrMatrix("http://100.64.1.2:14714/").length + 4;
    expect(lines.length).toBe(Math.ceil(size / 2));
    for (const l of lines) expect([...l].length).toBe(size);
    expect(lines[0]).toBe("█".repeat(size)); // the quiet zone is light (the terminal's ink)
  });
});
