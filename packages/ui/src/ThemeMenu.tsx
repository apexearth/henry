// The theme controls: pick a tone, highlight, shade and sky; theme.ts derives the rest. A
// popover under the topbar's "theme" on a desk, a fold in the ☰ drawer on a phone. The last
// row is where on Earth the context sky is drawn from — seeded from the time zone, so it is
// usually right already, and today's sunrise and sunset are printed underneath as the check.
import { useState } from "react";
import { clampLat, clampLon } from "./place";
import { riseSet, skyState } from "./solar";
import { FOCUS, GLOWS, HIGHLIGHTS, SCENES, SHADES, SKIES, TONES, isLight, oklch, setTheme, useTheme, type ThemeChoice } from "./theme";

const SCENE_TITLES: Record<(typeof SCENES)[number], string> = {
  life: "glyph Life fed by rain; busier as the context fills",
  loom: "the session woven as cloth: a thread per prompt, a stroke per tool call",
  sky: "a wall rising under the real sun and moon",
};
const FOCUS_TITLES: Record<keyof typeof FOCUS, string> = {
  sharp: "the backdrop in focus",
  soft: "a slight blur: lines become texture",
  hazy: "out of focus: shapes and colour, no lines",
  dream: "a wash of colour",
};
const GLOW_TITLES: Record<keyof typeof GLOWS, string> = {
  off: "no bloom",
  soft: "a halo of light around the backdrop",
  neon: "full bloom: every line glows like neon tubing",
};

const hhmm =(d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** A latitude or longitude. Edits are held as text until they parse, so a "-" can be typed. */
function Coord({ k, title, clamp }: { k: "lat" | "lon"; title: string; clamp: (n: number) => number }) {
  const t = useTheme();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (v: string) => {
    const n = Number(v);
    if (v.trim() && Number.isFinite(n)) setTheme({ [k]: clamp(n) } as Partial<ThemeChoice>);
    setDraft(null);
  };
  return (
    <input className="theme-num" title={title} inputMode="decimal" value={draft ?? String(t[k])}
      onChange={(e) => setDraft(e.target.value)} onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget.value)} />
  );
}

function Place() {
  const t = useTheme();
  const [asking, setAsking] = useState(false);
  const now = new Date();
  const sun = riseSet(now, skyState(now, t.lat, t.lon).sun);
  // Only on a click, and only where the browser offers it at all (it wants a secure origin, so
  // it is there on localhost and gone when Henry is opened from a phone over the LAN).
  const locate = () => {
    setAsking(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setTheme({ lat: clampLat(+p.coords.latitude.toFixed(2)), lon: clampLon(+p.coords.longitude.toFixed(2)) });
        setAsking(false);
      },
      () => setAsking(false),
      { timeout: 10_000 },
    );
  };
  return (
    <>
      <div className="theme-row">
        <span className="theme-label">place · {t.lat.toFixed(1)}, {t.lon.toFixed(1)}</span>
        <span className="theme-swatches">
          <Coord k="lat" title="latitude, degrees north" clamp={clampLat} />
          <Coord k="lon" title="longitude, degrees east" clamp={clampLon} />
          {navigator.geolocation && (
            <button className="theme-btn" onClick={locate} disabled={asking} title="ask the browser where you are">
              {asking ? "…" : "locate"}
            </button>
          )}
        </span>
      </div>
      <div className="theme-note">{sun ? `sunrise ${hhmm(sun.rise)} · sunset ${hhmm(sun.set)}` : "the sun neither rises nor sets here today"}</div>
    </>
  );
}

/** The choices themselves: the topbar popover on a desk, a fold in the ☰ drawer on a phone. */
export function ThemeRows() {
  const t = useTheme();
  const row = <K extends "tone" | "highlight" | "shade" | "sky">(key: K, names: string[], color: (n: string) => string, label: string = key) => (
    <div className="theme-row">
      <span className="theme-label">{label} · {t[key]}</span>
      <span className="theme-swatches">
        {names.map((n) => (
          <button key={n} className={"swatch" + (t[key] === n ? " sel" : "")} title={n}
            style={{ background: color(n) }} onClick={() => setTheme({ [key]: n } as Partial<ThemeChoice>)} />
        ))}
      </span>
    </div>
  );
  /** A row of named choices, for the ones a colour swatch cannot show. */
  const words = <K extends "scene" | "focus" | "glow">(key: K, names: readonly ThemeChoice[K][], title: (n: ThemeChoice[K]) => string) => (
    <div className="theme-row">
      <span className="theme-label">{key} · {t[key]}</span>
      <span className="theme-swatches">
        {names.map((n) => (
          <button key={n} className={"theme-btn" + (t[key] === n ? " sel" : "")} title={title(n)}
            onClick={() => setTheme({ [key]: n } as Partial<ThemeChoice>)}>
            {n}
          </button>
        ))}
      </span>
    </div>
  );
  return (
    <>
      {row("tone", Object.keys(TONES), (n) => { const c = TONES[n as keyof typeof TONES]; return oklch(0.4, c.c * 2, c.h); })}
      {row("highlight", Object.keys(HIGHLIGHTS), (n) => oklch(0.76, 0.13, HIGHLIGHTS[n as keyof typeof HIGHLIGHTS]))}
      {row("shade", Object.keys(SHADES), (n) => oklch(SHADES[n as keyof typeof SHADES], TONES[t.tone].c, TONES[t.tone].h))}
      {/* The context backdrop (ContextSky), from off to bold; the swatches are its own colour. */}
      {row("sky", Object.keys(SKIES), (n) => {
        const v = SKIES[n as keyof typeof SKIES];
        return oklch(SHADES[t.shade] + (isLight(t.shade) ? -0.13 : 0.13) * v, 0.055 * v, 130);
      }, "backdrop")}
      {SKIES[t.sky] > 0 && words("scene", SCENES, (s) => SCENE_TITLES[s])}
      {SKIES[t.sky] > 0 && words("focus", Object.keys(FOCUS) as (keyof typeof FOCUS)[], (s) => FOCUS_TITLES[s])}
      {SKIES[t.sky] > 0 && !isLight(t.shade) && words("glow", Object.keys(GLOWS) as (keyof typeof GLOWS)[], (s) => GLOW_TITLES[s])}
      {SKIES[t.sky] > 0 && t.scene === "sky" && <Place />}
    </>
  );
}

export function ThemeMenu() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="topbar-btn" onClick={() => setOpen((o) => !o)} title="appearance">theme</button>
      {open && (
        <>
          <div className="pop-bg" onClick={() => setOpen(false)} />
          <div className="pop theme-pop">
            <ThemeRows />
          </div>
        </>
      )}
    </>
  );
}
