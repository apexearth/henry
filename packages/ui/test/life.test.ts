import { describe, expect, test } from "bun:test";
import { Life, targetDensity } from "../src/life";

/** Runs the scene's loop: rain every frame, a generation every other one. */
function run(life: Life, f: number, frames: number) {
  for (let i = 0; i < frames; i++) {
    life.fall();
    if (i % 2) life.step(f, 0.25 + 0.75 * f);
  }
}

/** The mean density over a window, since Life breathes generation to generation. */
function settled(f: number, seed: number): number {
  const life = new Life(80, 48, seed);
  run(life, f, 1200);
  let sum = 0;
  for (let i = 0; i < 200; i++) {
    run(life, f, 2);
    sum += life.density();
  }
  return sum / 200;
}

describe("Life controller", () => {
  test("the board's busyness follows the context fraction", () => {
    const low = settled(0.1, 3), mid = settled(0.5, 3), high = settled(0.95, 3);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    for (const [f, d] of [[0.1, low], [0.5, mid], [0.95, high]] as const) {
      expect(d).toBeGreaterThan(targetDensity(f) * 0.4);
      expect(d).toBeLessThan(targetDensity(f) * 1.6 + 0.01);
    }
  });

  test("an empty board fills by rain rather than all at once", () => {
    const life = new Life(80, 48, 9);
    life.step(0.6, 0.7);
    expect(life.population).toBe(0);
    expect(life.drops.length).toBeGreaterThan(0);
  });

  test("a purge (a /compact) empties the board into falling drops that plant nothing", () => {
    const life = new Life(80, 48, 5);
    run(life, 0.8, 800);
    expect(life.population).toBeGreaterThan(0);
    life.drops = [];
    life.purge();
    expect(life.population).toBe(0);
    expect(life.drops.length).toBeGreaterThan(0);
    for (let i = 0; i < 400; i++) life.fall();
    expect(life.drops.length).toBe(0);
    expect(life.population).toBe(0);
  });

  test("a resize keeps the overlapping region", () => {
    const life = new Life(40, 30, 2);
    run(life, 0.7, 600);
    const before = life.live.slice(0, 20);
    life.resize(60, 40);
    expect(life.live.slice(0, 20)).toEqual(before);
  });
});
