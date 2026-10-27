// The "life" scene behind a session pane: Conway's Life written in dim, mirrored katakana, fed by
// rain (life.ts holds the simulation). How busy the board is follows the context fraction:
// near-empty with a stray glider at the start of a session, a churning soup by the time the window
// is nearly full, with the colour walking the Usage panel's green → amber → red. Rain lands lower
// down when the window is fresh and higher as it fills, so the activity rises from the bottom
// like the wall did. Each tool call fires a glider in from an edge; a working session ticks
// faster than an idle one; and a /compact pours every living cell off the bottom of the pane.
// Mirrored glyphs on a cell larger than the terminal's never read as text, and dead cells
// fade like phosphor instead of blinking out, so nothing flashes under what you are reading.
import { useEffect, useRef } from "react";
import { FADE, Life } from "./life";
import { contextFraction, heatHue } from "./panels/Usage";
import { SHADES, SKIES, oklch, useTheme } from "./theme";
import { useStore } from "./ws";

/** A cell in CSS pixels: wider and taller than a terminal cell, so the glyphs are scenery. */
const CW = 18, CH = 22, FONT = 15;
/** Half-width katakana and a few digits, drawn mirrored, the way the film did it. */
const GLYPHS = Array.from({ length: 56 }, (_, i) => String.fromCharCode(0xff66 + i)).join("") + "01234578";
/** Frame interval while working and while idle; Life steps every few frames on top of that. */
const BUSY_MS = 50, IDLE_MS = 95;
const BUSY_EVERY = 2, IDLE_EVERY = 3;
/** A drop in the target this large reads as a /compact (or a /clear), not as a wobble. */
const COMPACT_DROP = 0.08;

/** Rows from the bottom that rain may land in: a quarter of the pane when fresh, all of it when full. */
const band = (f: number) => 0.25 + 0.75 * Math.min(1, f);

/** The glyphs pre-rendered in the body and head colours, so a frame is drawImage only. */
function atlas(doc: Document, dpr: number, body: string, head: string): HTMLCanvasElement {
  const c = doc.createElement("canvas");
  c.width = Math.ceil(CW * dpr) * GLYPHS.length;
  c.height = Math.ceil(CH * dpr) * 2;
  const g = c.getContext("2d")!;
  const w = Math.ceil(CW * dpr), h = Math.ceil(CH * dpr);
  g.font = `${FONT * dpr}px "Hiragino Sans", "Yu Gothic", "MS Gothic", ui-monospace, monospace`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  [body, head].forEach((color, row) => {
    g.fillStyle = color;
    for (let i = 0; i < GLYPHS.length; i++) {
      g.save();
      g.translate(i * w + w / 2, row * h + h / 2);
      g.scale(-1, 1);
      g.fillText(GLYPHS[i]!, 0, 0);
      g.restore();
    }
  });
  return c;
}

/** Cheap integer hash for the drops' shimmering trail glyphs. */
const mix = (n: number) => {
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
  n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
  return (n ^ (n >>> 15)) >>> 0;
};

function draw(ctx: CanvasRenderingContext2D, life: Life, sheet: HTMLCanvasElement, dpr: number, frame: number) {
  const { cols, rows, live, age, glow, glyph } = life;
  const sw = Math.ceil(CW * dpr), sh = Math.ceil(CH * dpr);
  ctx.clearRect(0, 0, cols * CW, rows * CH);
  const cell = (g: number, row: number, x: number, y: number, a: number) => {
    ctx.globalAlpha = a;
    ctx.drawImage(sheet, g * sw, row * sh, sw, sh, x * CW, y * CH, CW, CH);
  };
  for (let y = 0, i = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++, i++) {
      if (live[i]) {
        // A newborn burns bright for a generation; old still life (the ash) sinks back.
        const a = age[i]!;
        if (a === 0) cell(glyph[i]!, 1, x, y, 0.75);
        else cell(glyph[i]!, 0, x, y, 0.4 + 0.45 * Math.exp(-a / 40));
      } else if (glow[i]) cell(glyph[i]!, 0, x, y, (0.32 * glow[i]!) / FADE);
    }
  }
  // The rain: a head and a tail that shimmers as it falls, the newest glyph brightest.
  for (const d of life.drops) {
    const head = Math.floor(d.y);
    for (let k = 0; k < d.len; k++) {
      const y = head - k;
      if (y < 0 || y >= rows) continue;
      const g = mix(d.salt * 7919 + y * 131 + ((frame + k) >> 3)) % GLYPHS.length;
      if (k === 0) cell(g, 1, d.col, y, 0.7);
      else cell(g, 0, d.col, y, 0.55 * (1 - k / d.len));
    }
  }
  ctx.globalAlpha = 1;
}

export function ContextLife({ sessionId }: { sessionId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useTheme();
  const frac = useStore((s) => contextFraction(s.usage.perSession[sessionId]));
  const busy = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.activity === "working");
  // Newest first; a change of id is a tool call that just finished.
  const tool = useStore((s) => s.events.find((e) => e.sessionId === sessionId && e.hookEvent === "PostToolUse")?.id);
  const strength = SKIES[theme.sky];
  const on = strength > 0 && frac !== undefined;

  const f = useRef(frac ?? 0);
  const hot = useRef(busy);
  const life = useRef<Life | null>(null);
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const L0 = SHADES[theme.shade];
    const up = L0 > 0.5 ? -1 : 1; // ink on paper, light on the dark shades
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let dpr = devicePixelRatio || 1;
    let sheet: HTMLCanvasElement | null = null, sheetHue = -1;
    let w = 0, h = 0, raf = 0, last = 0, frame = 0;
    // The colour moves with the window in 4-degree steps, rebuilding the atlas only on a step.
    const paint = () => {
      const hue = Math.round(heatHue(f.current) / 4) * 4;
      if (!sheet || hue !== sheetHue) {
        sheetHue = hue;
        sheet = atlas(el.ownerDocument, dpr, oklch(L0 + up * 0.3, 0.11, hue), oklch(L0 + up * 0.56, 0.08, hue));
      }
      if (life.current) draw(ctx, life.current, sheet, dpr, frame);
    };
    const warm = (l: Life, frames: number) => {
      for (let i = 0; i < frames; i++) {
        l.fall();
        if (i % 2) l.step(f.current, band(f.current));
      }
    };
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < (hot.current ? BUSY_MS : IDLE_MS) || !w || !h || !life.current) return;
      last = t;
      frame++;
      life.current.fall();
      if (frame % (hot.current ? BUSY_EVERY : IDLE_EVERY) === 0) life.current.step(f.current, band(f.current));
      paint();
    };
    redraw.current = () => {
      if (still && life.current) {
        warm(life.current, 120);
        life.current.drops = [];
        paint();
      }
    };
    const ro = new ResizeObserver(() => {
      dpr = devicePixelRatio || 1;
      w = el.clientWidth;
      h = el.clientHeight;
      if (!w || !h) return; // a hidden dock tab: keep the board, pick it up when it comes back
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cols = Math.ceil(w / CW), rows = Math.ceil(h / CH);
      if (!life.current) {
        // Opened mid-session: start with the board already at its density, not an empty screen.
        life.current = new Life(cols, rows, (Math.random() * 2 ** 32) >>> 0, GLYPHS.length);
        warm(life.current, 500);
        if (still) life.current.drops = [];
      } else life.current.resize(cols, rows);
      sheet = null;
      paint();
    });
    ro.observe(el);
    if (!still) raf = requestAnimationFrame(tick);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      redraw.current = () => {};
    };
  }, [theme, on]);

  useEffect(() => {
    const next = frac ?? 0;
    if (life.current && f.current - next > COMPACT_DROP) life.current.purge();
    f.current = next;
    redraw.current();
  }, [frac]);

  useEffect(() => {
    hot.current = busy;
  }, [busy]);

  const seen = useRef(tool);
  useEffect(() => {
    if (tool && tool !== seen.current) life.current?.launch();
    seen.current = tool;
  }, [tool]);

  if (!on) return null;
  return <canvas ref={canvas} className="term-sky" style={{ opacity: strength }} aria-hidden="true" />;
}
