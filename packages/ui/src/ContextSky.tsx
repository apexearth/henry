// The session pane's backdrop: a brick wall that rises from the bottom as the session's context
// window fills, in front of the sky that is actually outside. The sun and moon are where they
// really are over the user's latitude and longitude (solar.ts does the arithmetic, place.ts
// guesses the place from the time zone), so the day is as long as today's day, the winter sun
// stays low, and the moon keeps its own hours and its real phase. Two readings, one picture —
// how full the window is, and how late it has got. Purely decorative and deliberately quiet: it
// sits under live terminal text. The fraction is the Usage panel's context bar, so the crest and
// the bar always agree, and a /compact drops the wall back down.
import { useEffect, useRef } from "react";
import { contextFraction } from "./panels/Usage";
import { skyState, type Body, type Sky } from "./solar";
import { SHADES, SKIES, oklch, useTheme } from "./theme";
import { useStore } from "./ws";

/** Bricks in CSS pixels, mortar included. One brick is ~2.5k tokens of a 200k window. */
const BRICK_W = 42, BRICK_H = 15, MORTAR = 2;
/** Sun, moon and stars are drawn on this grid, for the 8-bit look. */
const PX = 4;
const STARS = 44;
/** Where the horizon sits, and how far above it the arc reaches. */
const HORIZON = 0.86, ARC = 0.72;
/** The altitude drawn at the top of the arc; a sun that never gets this high never gets there. */
const HIGH = Math.sin((65 * Math.PI) / 180);
const RAD = Math.PI / 180;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Deterministic 0..1 from an integer, so stars and brick jitter survive a resize. */
function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Green up to 70%, amber to 90%, red above: the Usage panel's thresholds, as hues. */
function heatHue(t: number): number {
  if (t < 0.7) return lerp(145, 100, t / 0.7);
  if (t < 0.9) return lerp(100, 60, (t - 0.7) / 0.2);
  return lerp(60, 25, clamp01((t - 0.9) / 0.1));
}

/** A body on the canvas: across by the hours from its own transit, up by how high it really is.
 * A body below the horizon still gets a point, below the line, which is where the moon looks
 * for the sun. */
function project(b: Body, w: number, h: number): { x: number; y: number } {
  return {
    x: w * (0.5 + 0.4 * (b.hour / b.half)),
    y: h * HORIZON - h * ARC * Math.min(1, Math.sin(b.alt * RAD) / HIGH),
  };
}

function pixelDisc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, alpha: number) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  const x0 = Math.floor((cx - r) / PX) * PX, y0 = Math.floor((cy - r) / PX) * PX;
  for (let y = y0; y <= cy + r; y += PX) {
    for (let x = x0; x <= cx + r; x += PX) {
      const dx = x + PX / 2 - cx, dy = y + PX / 2 - cy;
      if (dx * dx + dy * dy <= r * r) ctx.fillRect(x, y, PX, PX);
    }
  }
  ctx.globalAlpha = 1;
}

/** The terminator is an ellipse across the disc, `s` wide: +1 at new moon, 0 at the quarters, -1
 * at full. (bx, by) points at the sun, so the lit face and the horns turn with it. */
function isLit(dx: number, dy: number, r: number, s: number, bx: number, by: number): boolean {
  const u = dx * bx + dy * by, v = dx * by - dy * bx;
  return u >= s * Math.sqrt(Math.max(0, r * r - v * v));
}

function pixelMoon(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number,
  lit: number, bx: number, by: number, alpha: number,
) {
  const s = 1 - 2 * lit;
  const face = oklch(0.9, 0.02, 250), night = oklch(0.66, 0.02, 258);
  const x0 = Math.floor((cx - r) / PX) * PX, y0 = Math.floor((cy - r) / PX) * PX;
  for (let y = y0; y <= cy + r; y += PX) {
    for (let x = x0; x <= cx + r; x += PX) {
      const dx = x + PX / 2 - cx, dy = y + PX / 2 - cy;
      if (dx * dx + dy * dy > r * r) continue;
      const on = isLit(dx, dy, r, s, bx, by);
      ctx.globalAlpha = alpha * (on ? 1 : 0.16); // the dark face stays faintly there, like earthshine
      ctx.fillStyle = on ? face : night;
      ctx.fillRect(x, y, PX, PX);
    }
  }
  ctx.globalAlpha = alpha * 0.5;
  ctx.fillStyle = oklch(0.78, 0.02, 250);
  for (const [ox, oy] of [[-0.3, -0.2], [0.25, 0.1], [-0.1, 0.35]] as const) {
    if (!isLit(ox * r, oy * r, r, s, bx, by)) continue;
    ctx.fillRect(Math.round((cx + ox * r) / PX) * PX, Math.round((cy + oy * r) / PX) * PX, PX, PX);
  }
  ctx.globalAlpha = 1;
}

function halo(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, spread: number, alpha: number) {
  const g = ctx.createRadialGradient(x, y, r * 0.45, x, y, r * spread);
  g.addColorStop(0, color + "40");
  g.addColorStop(1, color + "00");
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.fillRect(x - r * spread, y - r * spread, r * spread * 2, r * spread * 2);
  ctx.globalAlpha = 1;
}

/** `f` is the context fraction (the wall); `sky` is where the sun and moon are right now. */
function draw(ctx: CanvasRenderingContext2D, w: number, h: number, f: number, L0: number, sky: Sky) {
  ctx.clearRect(0, 0, w, h);
  // Everything in the sky follows the sun's real altitude: 1 with it overhead, 0 on the horizon.
  const alt = sky.sun.alt;
  const el = Math.sin(alt * RAD);
  const day = clamp01(el * 2.5 + 0.15);
  const dusk = clamp01(1 - Math.abs(el) * 3.5); // the warm half hour either side of the horizon
  const crest = h * (1 - clamp01(f));

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, oklch(L0 + lerp(0.02, 0.075, day), 0.03, lerp(272, 250, day)));
  grad.addColorStop(1, oklch(L0 + lerp(0.045, 0.125, day) + 0.025 * dusk, 0.02 + 0.05 * dusk, lerp(lerp(268, 232, day), 35, dusk)));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Stars come out through twilight, the way they do: none at -4 degrees, all of them by -14.
  const starA = clamp01((-alt - 4) / 10);
  if (starA > 0) {
    ctx.fillStyle = oklch(0.92, 0.02, 250);
    for (let i = 0; i < STARS; i++) {
      const x = Math.round((hash(i * 2) * w) / PX) * PX, y = Math.round((hash(i * 2 + 1) * h * 0.72) / PX) * PX;
      if (y > crest - PX) continue;
      ctx.globalAlpha = starA * (0.35 + hash(i * 7) * 0.5);
      const s = hash(i * 11) < 0.3 ? PX : PX / 2;
      ctx.fillRect(x, y, s, s);
    }
    ctx.globalAlpha = 1;
  }

  const r = Math.max(12, Math.min(34, Math.min(w, h) * 0.07));
  const sun = project(sky.sun, w, h);
  // The moon keeps its own schedule, which slips the best part of an hour a day, and half the
  // time that puts it up in daylight. The real one is still up there at noon; this one bows out,
  // fading through twilight and gone by the time the sun is properly up, so the daytime sky
  // stays as plain as the terminal text over it wants it to be.
  const moonA = 0.9 * clamp01((2 - alt) / 10);
  if (sky.moon.alt > -1 && moonA > 0.01) {
    const m = project(sky.moon, w, h);
    const dx = sun.x - m.x, dy = sun.y - m.y;
    const d = Math.hypot(dx, dy) || 1;
    halo(ctx, m.x, m.y, r * 0.68, oklch(0.9, 0.02, 250), 2.2, moonA * (0.2 + 0.8 * sky.lit));
    pixelMoon(ctx, m.x, m.y, r * 0.68, sky.lit, dx / d, dy / d, moonA);
  }
  if (sky.sun.alt > -1) {
    // It goes orange as it nears the horizon. A tall wall swallows it early, which is the point.
    const c = oklch(0.84, 0.15, lerp(95, 32, dusk));
    halo(ctx, sun.x, sun.y, r, c, 3, 1);
    pixelDisc(ctx, sun.x, sun.y, r, c, 1);
  }

  // Running bond, bottom-up and left to right. The newest brick fades in, so a few hundred
  // tokens are visible as movement rather than as a jump.
  const rows = Math.max(1, Math.ceil(h / BRICK_H));
  const cols = Math.ceil(w / BRICK_W) + 1;
  const total = rows * cols;
  const laid = clamp01(f) * total;
  wall: for (let row = 0; row < rows; row++) {
    const y = h - (row + 1) * BRICK_H;
    const off = row % 2 ? -BRICK_W / 2 : 0;
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (i >= laid) break wall;
      const hue = heatHue(i / total);
      const j = hash(i) * 0.03 - 0.015;
      const x = off + col * BRICK_W;
      ctx.globalAlpha = Math.min(1, laid - i);
      ctx.fillStyle = oklch(L0 + 0.13 + j, 0.055, hue);
      ctx.fillRect(x, y, BRICK_W - MORTAR, BRICK_H - MORTAR);
      ctx.fillStyle = oklch(L0 + 0.19 + j, 0.05, hue);
      ctx.fillRect(x, y, BRICK_W - MORTAR, 2);
    }
  }
  ctx.globalAlpha = 1;
}

export function ContextSky({ sessionId }: { sessionId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useTheme();
  const frac = useStore((s) => contextFraction(s.usage.perSession[sessionId]));
  const strength = SKIES[theme.sky];
  const on = strength > 0 && frac !== undefined;
  // The wall grows toward `target`; `shown` is where the animation has got to. The sky is
  // recomputed a minute at a time, which is finer than anything up there moves.
  const target = useRef(0);
  const shown = useRef(0);
  const sky = useRef<Sky>(skyState(new Date(), theme.lat, theme.lon));
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const L0 = SHADES[theme.shade]; // the theme's background lightness; the sky sits just above it
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const observe = () => (sky.current = skyState(new Date(), theme.lat, theme.lon));
    observe();
    let w = 0, h = 0, raf = 0;
    const tick = () => {
      raf = 0;
      const d = target.current - shown.current;
      if (!w || !h || still || Math.abs(d) < 0.0004) shown.current = target.current;
      else {
        shown.current += d * 0.1;
        raf = requestAnimationFrame(tick);
      }
      if (w && h) draw(ctx, w, h, shown.current, L0, sky.current);
    };
    kick.current = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const ro = new ResizeObserver(() => {
      const dpr = devicePixelRatio || 1;
      w = el.clientWidth;
      h = el.clientHeight;
      if (!w || !h) return; // a hidden dock tab: keep the last frame, redraw when it comes back
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(ctx, w, h, shown.current, L0, sky.current);
    });
    ro.observe(el);
    const clock = setInterval(() => {
      observe();
      kick.current();
    }, 60_000);
    kick.current();
    return () => {
      ro.disconnect();
      clearInterval(clock);
      cancelAnimationFrame(raf);
      kick.current = () => {};
    };
  }, [theme, on]);

  useEffect(() => {
    target.current = frac ?? 0;
    kick.current();
  }, [frac]);

  if (!on) return null;
  return <canvas ref={canvas} className="term-sky" style={{ opacity: strength }} aria-hidden="true" />;
}
