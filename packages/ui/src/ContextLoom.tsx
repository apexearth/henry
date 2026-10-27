// The "loom" scene behind a session pane: the session woven as it goes (loom.ts holds the
// pattern). The cloth is alive: every frame redraws it carried a little by a slow current
// (`sway`), so it moves like silk in water, and older turns recede as newer ones arrive, so the
// turn in hand is what stands out and the history settles into dim texture. A new stroke is
// drawn out over a fraction of a second with a brighter needle at its tip. On mount the
// session's history is fetched and replayed into the same cloth it was before the reload. A
// compaction (the PreCompact hook, or the context fraction dropping by more than COMPACT_DROP,
// which also catches a /clear) squeezes the cloth down into a braid along the bottom; braids
// stack, one per compaction, like rings. Under reduced motion the current is still and frames
// are drawn only when the cloth changes.
import { useEffect, useRef } from "react";
import type { HenryEvent } from "@henry/shared";
import { Backdrop, bloom } from "./Backdrop";
import { Loom, hashStr, kindFor, replay, rng, sway, turbulence, weave, type Beat, type Kind, type Stroke, type Thread } from "./loom";
import { contextFraction } from "./panels/Usage";
import { SHADES, SKIES, oklch, useTheme } from "./theme";
import { getState, useStore } from "./ws";

const COMPACT_DROP = 0.08;
/** A drop in the fraction this soon after a PreCompact is that same compaction finishing. */
const SAME_COMPACT_MS = 10 * 60_000;
const ROLL_MS = 1700;
/** Braids along the bottom: spacing and how many are kept in view. */
const BRAID_GAP = 13, BRAIDS_SHOWN = 6;
/** Frame interval for the current; slow motion needs no more. */
const FRAME_MS = 66;
/** How far the current carries the cloth, in pane heights: calm, and a little more once turbulent. */
const SWAY = 0.014, SWAY_TURBULENT = 0.012;
/** Turns back at which a thread has receded to about a third, and the floor it fades to. */
const RECEDE_TURNS = 2.5, RECEDED = 0.22;
/** Filler is drawn as if this many turns old. */
const FILL_AGE = 4;
/** The slide under the microscope, far to near: behind the focal plane (small, soft, slow), on
 * it (sharp), in front of it (wide, soft, carried furthest). `scale` is the resolution a depth
 * is drawn at, which is what blurs it; `drift` is how far, in pane heights, the whole depth
 * wanders. */
const DEPTHS = [
  { scale: 0.3, alpha: 0.7, width: 1, amp: 0.5, speed: 0.55, drift: 0.008 },
  { scale: 1, alpha: 1, width: 1, amp: 1, speed: 1, drift: 0.012 },
  { scale: 0.38, alpha: 0.55, width: 1.7, amp: 1.9, speed: 1.6, drift: 0.03 },
] as const;
/** Four in ten threads behind the focal plane, four on it, two in front. */
const depthOf = (s: Stroke) => (s.seed % 10 < 4 ? 0 : s.seed % 10 < 8 ? 1 : 2);
/** A tool call's ripple: how fast its ring spreads (pane heights a second), how wide the ring
 * is (squared), how hard it pushes, how fast it fades, and when it is gone (seconds). */
const RIPPLE_SPEED = 0.22, RIPPLE_WIDTH = 0.004, RIPPLE_PUSH = 0.016, RIPPLE_DECAY = 1.4, RIPPLE_LIFE = 5;
/** A tool call's own touch, as a ripple strength; then the swell of the context it added: one
 * strength per SWELL_UNIT of the window (1% is ~2k tokens of 200k), up to SWELL_MAX. */
const TOUCH = 0.35, SWELL_UNIT = 0.01, SWELL_MAX = 3.5;
const MOTES = 46;

function beatOf(e: HenryEvent): Beat | null {
  if (e.kind !== "hook") return null;
  if (e.hookEvent === "UserPromptSubmit") return { id: e.id, kind: "prompt" };
  if (e.hookEvent === "PostToolUse") return { id: e.id, kind: "tool", tool: e.toolName };
  if (e.hookEvent === "PreCompact") return { id: e.id, kind: "compact" };
  return null;
}

/** A stroke with its geometry for the current pane, and how much of it is drawn so far. */
interface Laid { stroke: Stroke; thread: Thread; color: string; drawn: number; total: number }

export function ContextLoom({ sessionId }: { sessionId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useTheme();
  const frac = useStore((s) => contextFraction(s.usage.perSession[sessionId]));
  const latest = useStore((s) => s.events.find((e) => e.sessionId === sessionId)?.id);
  const strength = SKIES[theme.sky];
  const on = strength > 0 && frac !== undefined;

  const f = useRef(frac ?? 0);
  const loom = useRef<Loom | null>(null);
  const beats = useRef<Beat[] | null>(null);
  const seen = useRef(new Set<string>());
  const lastRoll = useRef(0);
  // Bound by the drawing effect; the event and fraction effects below call through them.
  const lay = useRef<(kind: Kind, seed: number) => void>(() => {});
  const swell = useRef<(grew: number) => void>(() => {});
  const roll = useRef<() => void>(() => {});
  const build = useRef<() => void>(() => {});

  // The history, once per session. A peer's session (or a daemon too old to answer) falls back
  // to the live feed, which holds only the recent past.
  useEffect(() => {
    let live = true;
    const take = (events: HenryEvent[]) => {
      if (!live) return;
      const mine = events.filter((e) => e.sessionId === sessionId).sort((a, b) => a.ts - b.ts);
      for (const e of mine) seen.current.add(e.id);
      beats.current = mine.map(beatOf).filter((b): b is Beat => b !== null);
      build.current();
    };
    fetch(`/api/events?session=${encodeURIComponent(sessionId)}&limit=3000`)
      .then((r) => (r.ok ? (r.json() as Promise<HenryEvent[]>) : Promise.reject()))
      .then(take, () => take(getState().events));
    return () => void (live = false);
  }, [sessionId]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const L0 = SHADES[theme.shade];
    const up = L0 > 0.5 ? -1 : 1;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ink = (hue: number, lift = 0) => oklch(L0 + up * (0.4 + lift), 0.09, hue);
    let w = 0, h = 0, dpr = 1, raf = 0, last = 0;
    let laid: Laid[] = [];
    /** Rings spreading through the water; `k` is strength, 1 for a percent of the window. */
    let ripples: { x: number; y: number; t0: number; k: number }[] = [];
    /** Where the latest real stroke began, which is where the context it brought swells from. */
    let origin: [number, number] | null = null;
    const ripple = (x: number, y: number, k: number) => {
      if (still || k < 0.05) return;
      ripples.push({ x, y, t0: performance.now() / 1000, k });
      if (ripples.length > 8) ripples.shift();
    };
    const sw: [number, number] = [0, 0];
    const rand = rng(hashStr(sessionId) ^ 0x2545f491);
    const motes = Array.from({ length: MOTES }, () => ({
      x: rand(), y: rand(), z: rand() < 0.4 ? 0 : rand() < 0.6 ? 1 : 2, v: (rand() - 0.3) * 0.004, r: 0.5 + rand() * 0.9, a: 0.25 + rand() * 0.35,
    }));
    let rolling: { start: number; snap: HTMLCanvasElement; hue: number; k: number } | null = null;

    const geometry = (s: Stroke, drawn?: number): Laid => {
      const thread = weave(s, loom.current!.aspect, loom.current!.salt);
      const total = Math.max(...thread.lines.map((x) => x.length));
      return { stroke: s, thread, color: ink(s.hue), drawn: drawn ?? total, total };
    };
    const braid = (k: number, hue: number, upTo = w) => {
      const y = h - 9 - k * BRAID_GAP;
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = ink(hue, 0.04);
      for (let s = 0; s < 3; s++) {
        ctx.globalAlpha = 0.6 - s * 0.1;
        ctx.beginPath();
        for (let x = 0; x <= upTo; x += 3) {
          const yy = y + 3.4 * Math.sin(x * 0.055 + (s * Math.PI * 2) / 3);
          if (x === 0) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    // The depths out of focus are drawn into small canvases and scaled up: the smoothing is the
    // blur, for the price of one drawImage, and it works where canvas filters do not.
    const soft = DEPTHS.map((D) => (D.scale < 1 ? el.ownerDocument.createElement("canvas") : null));
    const sizeLayers = () => soft.forEach((c, i) => {
      if (!c) return;
      c.width = Math.max(1, Math.round(w * DEPTHS[i]!.scale));
      c.height = Math.max(1, Math.round(h * DEPTHS[i]!.scale));
    });

    /** One frame at time `t` (seconds): the braids, then each depth, far to near, every thread on
     * it carried by the current, its tail swinging further than its anchor, and pushed aside by
     * the ripples of tool calls landing. Motes drift through all three. */
    const frame = (t: number) => {
      const l = loom.current;
      ctx.clearRect(0, 0, w, h);
      if (!l) return;
      const shown = l.braids.slice(-BRAIDS_SHOWN);
      shown.forEach((hue, i) => (rolling && i === shown.length - 1 ? null : braid(i, hue)));
      const amp = still ? 0 : SWAY + SWAY_TURBULENT * turbulence(f.current);
      ripples = ripples.filter((r) => t - r.t0 < RIPPLE_LIFE);
      const needles: [number, number][] = [];
      const d: [number, number] = [0, 0];
      DEPTHS.forEach((D, z) => {
        const layer = soft[z];
        const g = layer ? layer.getContext("2d")! : ctx;
        if (layer) {
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.clearRect(0, 0, layer.width, layer.height);
          g.setTransform(D.scale, 0, 0, D.scale, 0, 0);
        }
        g.lineCap = g.lineJoin = "round";
        // The whole depth drifts on its own slow orbit, so the depths slide past each other.
        const ts = t * D.speed;
        const ox = still ? 0 : D.drift * Math.sin(ts * 0.05 + z * 2.1);
        const oy = still ? 0 : D.drift * Math.cos(ts * 0.037 + z * 1.3);
        for (const p of laid) {
          if (depthOf(p.stroke) !== z) continue;
          // Filler stands for context the events did not account for: always background.
          const age = Math.max(p.stroke.kind === "fill" ? FILL_AGE : 0, l.turn - p.stroke.turn);
          g.globalAlpha = D.alpha * p.thread.alpha * (RECEDED + (1 - RECEDED) * Math.exp(-age / RECEDE_TURNS));
          g.strokeStyle = p.color;
          // Out of focus a thread spreads: never thinner than a pixel of the small canvas.
          g.lineWidth = Math.max(p.thread.width * D.width, layer ? 1 / D.scale : 0);
          g.beginPath();
          for (const line of p.thread.lines) {
            const n = Math.min(p.drawn, line.length - 1);
            const len = line.length - 1 || 1;
            for (let i = 0; i <= n; i++) {
              const [x, y] = line[i]!;
              d[0] = ox;
              d[1] = oy;
              if (amp) {
                sway(x, y, ts + z * 17, l.salt, amp * D.amp * (0.3 + 0.7 * (i / len)), sw);
                d[0] += sw[0];
                d[1] += sw[1];
              }
              for (const r of ripples) {
                const rx = x - r.x, ry = y - r.y;
                const dist = Math.hypot(rx, ry) || 1e-6;
                // A bigger swell is a wider ring as well as a harder one.
                const age = t - r.t0, u = dist - RIPPLE_SPEED * age;
                const push = RIPPLE_PUSH * r.k * D.amp * Math.exp(-(u * u) / (RIPPLE_WIDTH * (0.6 + 0.4 * r.k))) * Math.exp(-age / RIPPLE_DECAY);
                d[0] += (rx / dist) * push;
                d[1] += (ry / dist) * push;
              }
              const px = (x + d[0]) * h, py = (y + d[1]) * h;
              if (i === 0) g.moveTo(px, py);
              else g.lineTo(px, py);
              if (i === n && p.drawn < p.total) needles.push([px, py]);
            }
          }
          g.stroke();
        }
        // Motes: specks suspended at this depth, drifting with the water.
        g.fillStyle = ink(l.hue(), 0.1);
        for (const m of motes) {
          if (m.z !== z) continue;
          const mx = ((((m.x + ts * m.v) % 1) + 1) % 1) * w, my = ((((m.y + ts * m.v * 0.4) % 1) + 1) % 1) * h;
          g.globalAlpha = D.alpha * m.a;
          g.beginPath();
          g.arc(mx + ox * h, my + oy * h, Math.max(m.r * D.width, layer ? 1 / D.scale : 0), 0, Math.PI * 2);
          g.fill();
        }
        g.globalAlpha = 1;
        if (layer) ctx.drawImage(layer, 0, 0, w, h);
      });
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = ink(l.hue(), 0.3);
      for (const [x, y] of needles) {
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      raf = 0;
      if (!w || !h) return;
      const weaving = laid.some((p) => p.drawn < p.total);
      if (!still || weaving || rolling) raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS && !rolling) return;
      last = now;
      // Draw new strokes out, faster the more is waiting, so a burst of tool calls keeps up.
      const waiting = laid.filter((p) => p.drawn < p.total);
      const speed = 6 + waiting.length * 4;
      for (const p of waiting.slice(0, 3)) p.drawn = Math.min(p.total, p.drawn + speed);
      frame(now / 1000);
      if (rolling) {
        // The old cloth is squeezed down into the braid's band as the braid is wound out along it.
        const e = Math.min(1, (now - rolling.start) / ROLL_MS);
        const ease = 1 - (1 - e) ** 3;
        const by = h - 9 - rolling.k * BRAID_GAP;
        ctx.globalAlpha = 1 - ease * 0.85;
        ctx.drawImage(rolling.snap, 0, 0, rolling.snap.width, rolling.snap.height,
          w * 0.03 * ease, by * ease - 4 * ease, w * (1 - 0.06 * ease), h + (8 - h) * ease);
        ctx.globalAlpha = 1;
        braid(rolling.k, rolling.hue, w * ease);
        if (e >= 1) rolling = null;
      }
      bloom(el);
    };
    const kick = () => {
      if (!raf && w && h) raf = requestAnimationFrame(tick);
    };

    lay.current = (kind, seed) => {
      const l = loom.current;
      if (!l || rolling) return;
      const { stroke } = l.add(kind, seed, f.current);
      if (!w || !h) return;
      // Work landing touches the water: a small ring from where the stroke begins. The swell
      // that follows, sized by the tokens it added, comes with the next fraction (swell below).
      if (kind !== "fill" && kind !== "fray") {
        origin = [stroke.fx * l.aspect, stroke.fy];
        ripple(origin[0], origin[1], TOUCH);
      }
      laid.push(geometry(stroke, still ? undefined : 0));
      kick();
    };
    swell.current = (grew) => {
      const l = loom.current;
      if (!l || !w || !h) return;
      const [x, y] = origin ?? [l.aspect / 2, 0.5];
      ripple(x, y, Math.min(SWELL_MAX, grew / SWELL_UNIT));
      kick();
    };
    roll.current = () => {
      const l = loom.current;
      if (!l || !w || !h) return;
      lastRoll.current = Date.now();
      const snap = el.ownerDocument.createElement("canvas");
      snap.width = el.width;
      snap.height = el.height;
      snap.getContext("2d")!.drawImage(el, 0, 0);
      l.rollUp();
      laid = [];
      const shown = l.braids.slice(-BRAIDS_SHOWN);
      rolling = { start: performance.now(), snap, hue: shown[shown.length - 1]!, k: shown.length - 1 };
      if (still) rolling.start = -ROLL_MS; // straight to the end state
      kick();
    };
    build.current = () => {
      if (!w || !h || !beats.current) return;
      if (!loom.current) {
        loom.current = replay(hashStr(sessionId), w / h, beats.current, f.current);
        lastRoll.current = 0;
      }
      laid = loom.current.strokes.map((s) => geometry(s));
      frame(performance.now() / 1000);
      bloom(el);
      kick();
    };

    const ro = new ResizeObserver(() => {
      dpr = devicePixelRatio || 1;
      w = el.clientWidth;
      h = el.clientHeight;
      if (!w || !h) return; // a hidden dock tab: keep the loom, re-lay it when it comes back
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingQuality = "high";
      sizeLayers();
      if (loom.current) loom.current.aspect = w / h;
      rolling = null;
      build.current();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      lay.current = () => {};
      swell.current = () => {};
      roll.current = () => {};
      build.current = () => {};
    };
  }, [theme, on, sessionId]);

  // New events: a prompt starts a turn, a tool call leaves its stroke, a PreCompact rolls up.
  useEffect(() => {
    if (!latest || !loom.current) return;
    const fresh: HenryEvent[] = [];
    for (const e of getState().events) {
      if (e.sessionId !== sessionId) continue;
      if (seen.current.has(e.id)) break;
      fresh.push(e);
    }
    for (const e of fresh.reverse()) {
      seen.current.add(e.id);
      const b = beatOf(e);
      if (!b) continue;
      if (b.kind === "compact") roll.current();
      else lay.current(b.kind === "prompt" ? "weft" : kindFor(b.tool), hashStr(b.id));
    }
  }, [latest, sessionId]);

  // The fraction: a sharp drop is a compaction (or a /clear); a rise owes plain weft, and past
  // the red line, fraying.
  useEffect(() => {
    const next = frac ?? 0;
    const prev = f.current;
    f.current = next;
    const l = loom.current;
    if (!l) return;
    if (prev - next > COMPACT_DROP) {
      if (Date.now() - lastRoll.current > SAME_COMPACT_MS) roll.current();
      return;
    }
    if (next > prev) swell.current(next - prev);
    for (let i = 0; i < 150 && l.owed(next) > 0; i++) lay.current("fill", l.nextSeed());
    if (next > 0.9 && next > prev) {
      for (let i = 0; i < Math.round((next - Math.max(prev, 0.9)) * 300); i++) lay.current("fray", l.nextSeed());
    }
  }, [frac]);

  if (!on) return null;
  return <Backdrop canvas={canvas} strength={strength} />;
}
