// Topbar "theme" popover: pick a tone, highlight and shade; theme.ts derives the rest.
import { useState } from "react";
import { HIGHLIGHTS, SHADES, SKIES, TONES, oklch, setTheme, useTheme, type ThemeChoice } from "./theme";

export function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const t = useTheme();
  const row = <K extends "tone" | "highlight" | "shade" | "sky">(key: K, names: string[], color: (n: string) => string) => (
    <div className="theme-row">
      <span className="theme-label">{key} · {t[key]}</span>
      <span className="theme-swatches">
        {names.map((n) => (
          <button key={n} className={"swatch" + (t[key] === n ? " sel" : "")} title={n}
            style={{ background: color(n) }} onClick={() => setTheme({ [key]: n } as Partial<ThemeChoice>)} />
        ))}
      </span>
    </div>
  );
  return (
    <>
      <button className="topbar-btn" onClick={() => setOpen((o) => !o)} title="appearance">theme</button>
      {open && (
        <>
          <div className="pop-bg" onClick={() => setOpen(false)} />
          <div className="pop theme-pop">
            {row("tone", Object.keys(TONES), (n) => { const c = TONES[n as keyof typeof TONES]; return oklch(0.4, c.c * 2, c.h); })}
            {row("highlight", Object.keys(HIGHLIGHTS), (n) => oklch(0.76, 0.13, HIGHLIGHTS[n as keyof typeof HIGHLIGHTS]))}
            {row("shade", Object.keys(SHADES), (n) => oklch(SHADES[n as keyof typeof SHADES], TONES[t.tone].c, TONES[t.tone].h))}
            {/* The context wall (ContextSky), from off to bold; the swatches are the wall's own colour. */}
            {row("sky", Object.keys(SKIES), (n) => {
              const v = SKIES[n as keyof typeof SKIES];
              return oklch(SHADES[t.shade] + 0.13 * v, 0.055 * v, 130);
            })}
          </div>
        </>
      )}
    </>
  );
}
