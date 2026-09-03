// Appearance: three choices (tone, highlight, shade) derive the whole palette, which is written
// as CSS variables on <html>. Everything else, xterm included, reads those variables. Colors are
// computed in OKLCH and emitted as hex so xterm's WebGL renderer can parse them.
import type { ITheme } from "@xterm/xterm";
import { useSyncExternalStore } from "react";

export const TONES = {
  graphite: { h: 250, c: 0 },
  slate: { h: 255, c: 0.018 },
  ink: { h: 265, c: 0.028 },
  mocha: { h: 60, c: 0.012 },
  moss: { h: 150, c: 0.012 },
  plum: { h: 320, c: 0.016 },
} as const;
export const HIGHLIGHTS = { blue: 255, teal: 195, green: 145, amber: 75, coral: 30, violet: 300, rose: 350 } as const;
export const SHADES = { black: 0.11, dark: 0.18, dim: 0.24 } as const;

export interface ThemeChoice {
  tone: keyof typeof TONES;
  highlight: keyof typeof HIGHLIGHTS;
  shade: keyof typeof SHADES;
}
const DEFAULT: ThemeChoice = { tone: "slate", highlight: "blue", shade: "dark" };
const KEY = "henry.theme";

// OKLCH -> sRGB hex. Chroma is pulled in until the color fits the gamut.
export function oklch(L: number, C: number, H: number): string {
  for (let c = C; ; c = Math.max(0, c - 0.01)) {
    const hr = (H * Math.PI) / 180;
    const a = c * Math.cos(hr), b = c * Math.sin(hr);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    if (c === 0 || rgb.every((x) => x >= -0.002 && x <= 1.002)) {
      return "#" + rgb.map((x) => {
        const v = Math.min(1, Math.max(0, x));
        const g = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
        return Math.round(g * 255).toString(16).padStart(2, "0");
      }).join("");
    }
  }
}

const ANSI_HUES = { red: 25, green: 145, yellow: 85, blue: 255, magenta: 320, cyan: 200 };

export function palette(t: ThemeChoice): Record<string, string> {
  const tone = TONES[t.tone], L0 = SHADES[t.shade], hh = HIGHLIGHTS[t.highlight];
  const bg = (dl: number) => oklch(L0 + dl, tone.c, tone.h);
  const grey = (L: number, k = 1) => oklch(L, tone.c * k, tone.h);
  const accent = oklch(0.76, 0.13, hh);
  const v: Record<string, string> = {
    "--bg": bg(0), "--bg-2": bg(0.035), "--bg-3": bg(0.075), "--border": bg(0.13),
    "--fg": grey(0.88, 0.6), "--fg-dim": grey(0.64), "--fg-faint": grey(0.48),
    "--accent": accent, "--accent-soft": accent + "2e", "--accent-glow": accent + "e6", "--sel": accent + "55",
    "--ok": oklch(0.72, 0.17, 145), "--warn": oklch(0.77, 0.15, 80), "--alarm": oklch(0.68, 0.19, 25),
    "--claude": "#d97757",
    "--ansi-0": bg(0.075), "--ansi-8": grey(0.48), "--ansi-7": grey(0.82, 0.6), "--ansi-15": grey(0.96, 0.6),
  };
  let i = 1;
  for (const h of Object.values(ANSI_HUES)) {
    v[`--ansi-${i}`] = oklch(0.7, 0.15, h);
    v[`--ansi-${i + 8}`] = oklch(0.8, 0.14, h);
    i++;
  }
  return v;
}

function load(): ThemeChoice {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<ThemeChoice>;
    return {
      tone: raw.tone && raw.tone in TONES ? raw.tone : DEFAULT.tone,
      highlight: raw.highlight && raw.highlight in HIGHLIGHTS ? raw.highlight : DEFAULT.highlight,
      shade: raw.shade && raw.shade in SHADES ? raw.shade : DEFAULT.shade,
    };
  } catch {
    return DEFAULT;
  }
}

let current = load();
const listeners = new Set<() => void>();

export function applyTheme() {
  const root = document.documentElement.style;
  for (const [k, val] of Object.entries(palette(current))) root.setProperty(k, val);
}
export function setTheme(patch: Partial<ThemeChoice>) {
  current = { ...current, ...patch };
  localStorage.setItem(KEY, JSON.stringify(current));
  applyTheme();
  listeners.forEach((f) => f());
}
export function onTheme(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
export function useTheme(): ThemeChoice {
  return useSyncExternalStore(onTheme, () => current);
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function xtermTheme(): ITheme {
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  const th: Record<string, string> = {
    background: cssVar("--bg"), foreground: cssVar("--fg"),
    cursor: cssVar("--fg"), cursorAccent: cssVar("--bg"),
    selectionBackground: cssVar("--sel"), selectionInactiveBackground: cssVar("--accent-soft"),
  };
  names.forEach((n, i) => {
    th[n] = cssVar(`--ansi-${i}`);
    th["bright" + n[0]!.toUpperCase() + n.slice(1)] = cssVar(`--ansi-${i + 8}`);
  });
  return th as ITheme;
}
