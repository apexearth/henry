import { describe, expect, test } from "bun:test";
import { Segmenter } from "../src/voice-audio";

const RATE = 16_000;
const BLOCK = 640; // 40 ms

/** `ms` of audio as 40 ms blocks: a loud tone or silence. */
function feed(seg: Segmenter, ms: number, loud: boolean) {
  for (let t = 0; t < ms; t += 40) seg.push(new Float32Array(BLOCK).fill(loud ? 0.1 : 0));
}

function run() {
  const clips: Float32Array[] = [];
  return { clips, seg: new Segmenter(RATE, (c) => clips.push(c)) };
}

describe("Segmenter", () => {
  test("silence alone never makes a clip", () => {
    const { clips, seg } = run();
    feed(seg, 10_000, false);
    seg.flush();
    expect(clips).toHaveLength(0);
  });

  test("a pause after speech cuts one clip, with a little of the silence before it", () => {
    const { clips, seg } = run();
    feed(seg, 2000, false);
    feed(seg, 1200, true);
    feed(seg, 800, false);
    expect(clips).toHaveLength(1);
    const ms = (clips[0]!.length / RATE) * 1000;
    // ~300 ms preroll + 1200 ms speech + the 720 ms pause that ended it
    expect(ms).toBeGreaterThan(1900);
    expect(ms).toBeLessThan(2400);
  });

  test("a breath shorter than the pause keeps the thought together", () => {
    const { clips, seg } = run();
    feed(seg, 1000, true);
    feed(seg, 400, false);
    feed(seg, 1000, true);
    feed(seg, 800, false);
    expect(clips).toHaveLength(1);
  });

  test("a click is dropped, not sent", () => {
    const { clips, seg } = run();
    feed(seg, 80, true);
    feed(seg, 1000, false);
    feed(seg, 80, true);
    seg.flush();
    expect(clips).toHaveLength(0);
  });

  test("talking without a pause is still cut, so words keep arriving", () => {
    const { clips, seg } = run();
    feed(seg, 60_000, true);
    expect(clips.length).toBeGreaterThanOrEqual(2);
    for (const c of clips) expect(c.length / RATE).toBeLessThanOrEqual(25.1);
  });

  test("past the soft limit a short pause is enough", () => {
    const { clips, seg } = run();
    feed(seg, 16_000, true);
    feed(seg, 280, false);
    expect(clips).toHaveLength(1);
  });

  test("stopping mid-thought delivers what was said", () => {
    const { clips, seg } = run();
    feed(seg, 1000, true);
    seg.flush();
    expect(clips).toHaveLength(1);
  });
});
