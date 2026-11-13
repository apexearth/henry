// Long input into a session: cut into pieces Claude Code reads as typing, in order, with the
// Enter after a line kept a beat apart from the line's last piece.
import { describe, expect, test } from "bun:test";
import { PIECE_CHARS, PIECE_GAP_MS, Typist, WRITE_GAP_MS, pieces } from "../src/typing";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pieces", () => {
  test("short input and bracketed pastes come back whole", () => {
    expect(pieces("hello")).toEqual(["hello"]);
    const paste = `\x1b[200~${words(2000)}\x1b[201~`;
    expect(pieces(paste)).toEqual([paste]);
  });

  test("long input is cut at spaces, nothing lost, nothing over the limit", () => {
    const text = words(2000);
    const out = pieces(text);
    expect(out.length).toBeGreaterThan(1);
    expect(out.join("")).toBe(text);
    for (const p of out) expect(p.length).toBeLessThanOrEqual(PIECE_CHARS);
    for (const p of out.slice(0, -1)) expect(p.endsWith(" ")).toBe(true);
  });

  test("a run with no spaces is cut at the limit, never inside a surrogate pair", () => {
    const text = "x".repeat(PIECE_CHARS - 1) + "😀".repeat(300);
    const out = pieces(text);
    expect(out.join("")).toBe(text);
    for (const p of out) expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p)).toBe(false);
  });
});

describe("Typist", () => {
  test("short writes go straight out", () => {
    const sent: string[] = [];
    const t = new Typist((_, d) => sent.push(d), () => true);
    t.write("a", "hi");
    t.write("a", "\r");
    expect(sent).toEqual(["hi", "\r"]);
  });

  test("a long line goes in paced pieces, and the Enter after it waits its turn", async () => {
    const sent: { d: string; at: number }[] = [];
    const t = new Typist((_, d) => sent.push({ d, at: performance.now() }), () => true);
    const line = words(400);
    t.write("a", line);
    t.write("a", "\r");
    t.write("b", "other session"); // another session's queue is its own
    expect(sent.map((s) => s.d)).toEqual([pieces(line)[0]!, "other session"]);
    await sleep(pieces(line).length * PIECE_GAP_MS + WRITE_GAP_MS + 200);
    const a = sent.filter((s) => s.d !== "other session");
    expect(a.map((s) => s.d).join("")).toBe(line + "\r");
    expect(a.at(-1)!.d).toBe("\r");
    expect(a.at(-1)!.at - a.at(-2)!.at).toBeGreaterThanOrEqual(WRITE_GAP_MS - 5);
  });

  test("an Enter just after the last piece still keeps its distance", async () => {
    const sent: { d: string; at: number }[] = [];
    const t = new Typist((_, d) => sent.push({ d, at: performance.now() }), () => true);
    const line = words(150);
    t.write("a", line);
    await sleep((pieces(line).length - 1) * PIECE_GAP_MS + 20);
    t.write("a", "\r");
    await sleep(2 * WRITE_GAP_MS + 100);
    expect(sent.map((s) => s.d).join("")).toBe(line + "\r");
    expect(sent.at(-1)!.at - sent.at(-2)!.at).toBeGreaterThanOrEqual(WRITE_GAP_MS - 5);
  });

  test("a session that exits mid-line gets nothing more", async () => {
    const sent: string[] = [];
    let alive = true;
    const t = new Typist((_, d) => sent.push(d), () => alive);
    t.write("a", words(400));
    alive = false;
    await sleep(PIECE_GAP_MS * 3);
    expect(sent.length).toBe(1);
  });
});
