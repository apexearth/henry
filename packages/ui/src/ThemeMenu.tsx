// Topbar "theme" popover: pick a tone, highlight and shade; theme.ts derives the rest.
import { useState } from "react";
import { HIGHLIGHTS, SHADES, TONES, oklch, setTheme, useTheme, type ThemeChoice } from "./theme";

export function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const t = useTheme();
  const row = <K extends keyof ThemeChoice>(key: K, names: string[], color: (n: string) => string) => (
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
          </div>
        </>
      )}
    </>
  );
}
