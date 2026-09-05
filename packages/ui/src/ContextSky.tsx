// The session pane's backdrop: a brick wall that rises from the bottom as the session's context
// window fills, in front of a sky that runs on the wall clock. Two readings, one picture — how
// full the window is, and how late it has got. Purely decorative and deliberately quiet: it sits
// under live terminal text. The fraction is the Usage panel's context bar, so the crest and the
// bar always agree, and a /compact drops the wall back down.
import { useEffect, useRef } from "react";
import { contextFraction } from "./panels/Usage";
import { SHADES, SKIES, oklch, useTheme } from "./theme";
import { useStore } from "./ws";

/** Bricks in CSS pixels, mortar included. One brick is ~2.5k tokens of a 200k window. */
const BRICK_W = 42, BRICK_H = 15, MORTAR = 2;
/** Sun, moon and stars are drawn on this grid, for the 8-bit look. */
const PX = 4;
const STARS = 44;

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

/** Local time as 0..1 of the day; 0.5 is noon. The sun is up between 06:00 and 18:00. */
function dayFraction(now = new Date()): number {
  return (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
}

/** A body's place on the 12-hour arc: t 0 is rising, 0.5 overhead, 1 setting. */
function arc(w: number, h: number, t: number): { x: number; y: number } {
  return { x: w * (0.1 + 0.8 * t), y: h * 0.86 - h * 0.72 * Math.sin(Math.PI * t) };
}

/** `f` is the context fraction (the wall); `d` is the time of day (the sky). */
function draw(ctx: CanvasRenderingContext2D, w: number, h: number, f: number, L0: number, d: number) {
  ctx.clearRect(0, 0, w, h);
  // Elevation: 1 at noon, 0 at 06:00 and 18:00, -1 at midnight. Everything in the sky follows it.
  const el = Math.sin(2 * Math.PI * (d - 0.25));
  const day = clamp01(el * 2.5 + 0.15);
  const dusk = clamp01(1 - Math.abs(el) * 3.5); // the warm half hour either side of the horizon
  const crest = h * (1 - clamp01(f));

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, oklch(L0 + lerp(0.02, 0.075, day), 0.03, lerp(272, 250, day)));
  sky.addColorStop(1, oklch(L0 + lerp(0.045, 0.125, day) + 0.025 * dusk, 0.02 + 0.05 * dusk, lerp(lerp(268, 232, day), 35, dusk)));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const starA = clamp01(-el * 2.2 + 0.1);
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
  if (el > -0.08) {
    // Daytime: the sun climbs from the left at 06:00 and sets on the right at 18:00, going
    // orange as it nears the horizon. A tall wall swallows it early, which is the point.
    const { x, y } = arc(w, h, clamp01((d - 0.25) * 2));
    const sun = oklch(0.84, 0.15, lerp(95, 32, dusk));
    const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 3);
    glow.addColorStop(0, sun + "40");
    glow.addColorStop(1, sun + "00");
    ctx.fillStyle = glow;
    ctx.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);
    pixelDisc(ctx, x, y, r, sun, 1);
  } else {
    const { x, y } = arc(w, h, clamp01((((d + 0.5) % 1) - 0.25) * 2));
    const moon = oklch(0.9, 0.02, 250);
    const glow = ctx.createRadialGradient(x, y, r * 0.4, x, y, r * 2.2);
    glow.addColorStop(0, moon + "26");
    glow.addColorStop(1, moon + "00");
    ctx.fillStyle = glow;
    ctx.fillRect(x - r * 2.2, y - r * 2.2, r * 4.4, r * 4.4);
    pixelDisc(ctx, x, y, r * 0.68, moon, 0.9);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = oklch(0.78, 0.02, 250);
    for (const [cx, cy] of [[-0.3, -0.2], [0.25, 0.1], [-0.1, 0.35]] as const) {
      ctx.fillRect(Math.round((x + cx * r) / PX) * PX, Math.round((y + cy * r) / PX) * PX, PX, PX);
    }
    ctx.globalAlpha = 1;
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
  // The wall grows toward `target`; `shown` is where the animation has got to. `day` moves on
  // its own clock, a minute at a time.
  const target = useRef(0);
  const shown = useRef(0);
  const day = useRef(dayFraction());
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const L0 = SHADES[theme.shade]; // the theme's background lightness; the sky sits just above it
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0, h = 0, raf = 0;
    const tick = () => {
      raf = 0;
      const d = target.current - shown.current;
      if (!w || !h || still || Math.abs(d) < 0.0004) shown.current = target.current;
      else {
        shown.current += d * 0.1;
        raf = requestAnimationFrame(tick);
      }
      if (w && h) draw(ctx, w, h, shown.current, L0, day.current);
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
      draw(ctx, w, h, shown.current, L0, day.current);
    });
    ro.observe(el);
    const clock = setInterval(() => {
      day.current = dayFraction();
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
