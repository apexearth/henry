// A right-click menu at the pointer that stays on screen: it opens down and right of the click,
// flips up or left when that side has no room, and scrolls when even the taller side is too short.
// It is placed again whenever its contents or the window change size. Esc or a click outside closes it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

const MARGIN = 4;

export function ContextMenu({ x, y, className, onClose, children }: { x: number; y: number; className?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight?: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Full height even while capped: the scrolled content plus the border.
      const w = el.offsetWidth;
      const h = el.scrollHeight + el.offsetHeight - el.clientHeight;
      const left = x + w + MARGIN <= vw ? x : Math.max(MARGIN, Math.min(x, vw) - w);
      const below = vh - y - MARGIN;
      const above = y - MARGIN;
      let top: number;
      let maxHeight: number | undefined;
      if (h <= below) top = y;
      else if (h <= above) top = y - h;
      // Too tall either way: the roomier side, scrolling.
      else if (below >= above) { top = y; maxHeight = below; }
      else { top = MARGIN; maxHeight = above; }
      setPlace((p) => (p && p.left === left && p.top === top && p.maxHeight === maxHeight ? p : { left, top, maxHeight }));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="pop-bg" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={ref} className={"pop files-menu" + (className ? " " + className : "")}
        style={place
          ? { left: place.left, top: place.top, maxHeight: place.maxHeight, boxSizing: "border-box", overflowY: place.maxHeight ? "auto" : undefined }
          : { left: x, top: y, visibility: "hidden" }}>
        {children}
      </div>
    </>
  );
}
