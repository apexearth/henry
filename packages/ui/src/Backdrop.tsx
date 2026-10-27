// The canvas every backdrop scene paints into, and its bloom. Bloom is a second canvas holding a
// half-size copy of the scene, blurred, brightened and added on top (plus-lighter), so each
// line or glyph glows in its own colour like neon tubing. The copy is taken by `bloom()` after a
// scene paints, so a still scene costs nothing. Off on the light shades: added light only washes
// paper out.
import type { RefObject } from "react";
import { GLOWS, isLight, useTheme } from "./theme";

/** Copies the scene into its bloom canvas, if it has one. Call after every paint. */
export function bloom(scene: HTMLCanvasElement) {
  const b = scene.nextElementSibling;
  if (!(b instanceof HTMLCanvasElement) || !b.classList.contains("term-bloom")) return;
  const w = Math.max(1, scene.width >> 1), h = Math.max(1, scene.height >> 1);
  if (b.width !== w || b.height !== h) {
    b.width = w;
    b.height = h;
  }
  const g = b.getContext("2d");
  if (!g) return;
  g.clearRect(0, 0, w, h);
  g.drawImage(scene, 0, 0, w, h);
}

export function Backdrop({ canvas, strength }: { canvas: RefObject<HTMLCanvasElement>; strength: number }) {
  const t = useTheme();
  const glow = isLight(t.shade) ? 0 : GLOWS[t.glow];
  return (
    <>
      <canvas ref={canvas} className="term-sky" style={{ opacity: strength }} aria-hidden="true" />
      {glow > 0 && <canvas className="term-bloom" style={{ opacity: strength * glow }} aria-hidden="true" />}
    </>
  );
}
