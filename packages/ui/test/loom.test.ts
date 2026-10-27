import { describe, expect, test } from "bun:test";
import { INK_FULL, kindFor, replay, weave, type Beat } from "../src/loom";

const beats: Beat[] = [
  { id: "p1", kind: "prompt" },
  { id: "t1", kind: "tool", tool: "Read" },
  { id: "t2", kind: "tool", tool: "Edit" },
  { id: "t3", kind: "tool", tool: "Bash" },
  { id: "p2", kind: "prompt" },
  { id: "t4", kind: "tool", tool: "Agent" },
];

describe("loom", () => {
  test("a session replays to the same cloth", () => {
    const a = replay(42, 1.7, beats, 0.4), b = replay(42, 1.7, beats, 0.4);
    expect(a.strokes).toEqual(b.strokes);
    expect(weave(a.strokes[3]!, 1.7, 42)).toEqual(weave(b.strokes[3]!, 1.7, 42));
  });

  test("each tool leaves its own kind of stroke, and a prompt starts a new colour", () => {
    expect(["Read", "Grep", "Edit", "Write", "Bash", "Agent", "mcp__x__y"].map(kindFor))
      .toEqual(["warp", "warp", "knot", "knot", "zig", "fan", "warp"]);
    const l = replay(7, 1.7, beats, 0);
    expect(l.strokes.slice(0, 6).map((s) => s.kind)).toEqual(["weft", "warp", "knot", "zig", "weft", "fan"]);
    expect(l.strokes[0]!.hue).not.toBe(l.strokes[4]!.hue);
    expect(l.turn).toBe(2);
  });

  test("the thread on the loom follows the context fraction, events or not", () => {
    for (const f of [0.1, 0.5, 0.9]) {
      const l = replay(3, 1.7, [], f);
      expect(l.ink).toBeGreaterThanOrEqual(f * INK_FULL * 1.7);
      expect(l.ink).toBeLessThan(f * INK_FULL * 1.7 + 2);
    }
    expect(replay(3, 1.7, [], 0.95).strokes.some((s) => s.kind === "fray")).toBe(true);
    expect(replay(3, 1.7, [], 0.85).strokes.some((s) => s.kind === "fray")).toBe(false);
  });

  test("a compaction rolls everything before it into a braid", () => {
    const l = replay(5, 1.7, [...beats, { id: "c1", kind: "compact" }, { id: "p3", kind: "prompt" }], 0);
    expect(l.braids.length).toBe(1);
    expect(l.strokes.map((s) => s.kind)).toEqual(["weft"]);
  });
});
