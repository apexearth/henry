// When Henry is a phone, how tall the phone actually is, and how far the terminal is zoomed out.
import { useEffect, useState } from "react";

/**
 * A touch screen too narrow for the dock, or any window narrow enough that the three columns
 * would be unusable anyway. `?desktop=1` forces the full layout onto a tablet; `?mobile=1`
 * brings the phone layout up on a desktop, which is how it gets looked at while it is built.
 */
const QUERY = "(pointer: coarse) and (max-width: 1024px), (max-width: 700px)";

function override(): boolean | undefined {
  const p = new URLSearchParams(location.search);
  if (p.has("mobile")) return p.get("mobile") !== "0";
  if (p.has("desktop")) return p.get("desktop") === "0";
  return undefined;
}

export function useMobile(): boolean {
  const forced = override();
  const [mobile, setMobile] = useState(() => forced ?? window.matchMedia(QUERY).matches);
  useEffect(() => {
    if (forced !== undefined) return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [forced]);
  return mobile;
}

const SIZE_KEY = "henry.mobile.fontSize";
const MIN = 4;
const MAX = 18;
/** Claude Code draws for 80 columns; below that its boxes wrap and the output is a mess. */
const WANT_COLS = 80;
/** A monospace cell is about 0.6 em wide, which is close enough to pick a starting size. */
const CELL_RATIO = 0.6;

function defaultSize(): number {
  const cols = Math.floor(window.innerWidth / (WANT_COLS * CELL_RATIO));
  return Math.max(MIN, Math.min(MAX, cols || 9));
}

function readSize(): number {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    if (Number.isFinite(n) && n >= MIN && n <= MAX) return n;
  } catch {}
  return defaultSize();
}

/** The terminal's text size, persisted per browser. Zooming out is how 80 columns fit. */
export function useFontSize(): { fontSize: number; zoom: (by: number) => void } {
  const [fontSize, setFontSize] = useState(readSize);
  const zoom = (by: number) => {
    setFontSize((n) => {
      const next = Math.max(MIN, Math.min(MAX, n + by));
      try {
        localStorage.setItem(SIZE_KEY, String(next));
      } catch {}
      return next;
    });
  };
  return { fontSize, zoom };
}

/**
 * The height the page can actually use. On a phone the on-screen keyboard covers the bottom of
 * the window without changing its height, so `100dvh` leaves the composer under the keyboard;
 * visualViewport is the part still on screen.
 */
export function useViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => document.documentElement.style.setProperty("--m-vh", `${Math.round(vv.height)}px`);
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      document.documentElement.style.removeProperty("--m-vh");
    };
  }, []);
}
