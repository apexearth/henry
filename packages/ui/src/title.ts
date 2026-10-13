// What is worth saying from outside the window: a session asked for you by name, and how many
// sessions finished without you looking. Both shapes of the UI set it, so the phone's tab strip
// carries it the same way the desktop's window title and favicon do.
import { useEffect } from "react";
import { unseenRows, useStore } from "./ws";

export function useAskTitle(): void {
  const asks = useStore((s) => s.attention);
  const unseen = useStore((s) => unseenRows(s).length);
  useEffect(() => {
    const n = unseen ? `(${unseen}) ` : "";
    document.title = asks.length ? `❗ ${n}Henry — ${asks[0]!.message.slice(0, 60)}` : `${n}Henry`;
  }, [asks, unseen]);
  useEffect(() => void badgeIcon(unseen), [unseen]);
}

const ICON = "/henry.svg";
let plain: HTMLImageElement | null = null;

/** The favicon with the unseen count on it, drawn over the plain icon; none restores it. */
async function badgeIcon(n: number): Promise<void> {
  const link = document.querySelector<HTMLLinkElement>("link[rel=icon]");
  if (!link) return;
  if (!n) {
    link.type = "image/svg+xml";
    link.href = ICON;
    return;
  }
  if (!plain) {
    const img = new Image();
    img.src = ICON;
    try {
      await img.decode();
    } catch {
      return;
    }
    plain = img;
  }
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return;
  g.drawImage(plain, 0, 0, 64, 64);
  g.beginPath();
  g.arc(46, 18, 18, 0, Math.PI * 2);
  g.fillStyle = "#e5484d";
  g.fill();
  g.fillStyle = "#fff";
  g.font = "bold 26px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(n > 9 ? "9+" : String(n), 46, 19);
  link.type = "image/png";
  link.href = c.toDataURL("image/png");
}
