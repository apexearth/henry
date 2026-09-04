// The window telling the daemon you are here. Reading a diff, walking a repo tree, watching a
// turn run: none of it produces a prompt, and all of it is time you spent. A beat every 30 s
// marks the current minute (POST /api/presence); the daemon stores the minute and nothing
// else — not the panel, not the file, not the keystroke.
//
// "Here" means this window is visible and focused, and you have touched something within the
// idle window. Focus alone is not enough for long: a window left open on a second monitor
// while you are at lunch would otherwise bill you for the afternoon.
import { IDLE_MS, minuteOf, PRESENCE_BEAT_MS, type PresenceBeat } from "@henry/shared";

const EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "focus"] as const;

let lastTouch = Date.now();
/** Minutes we were here for but could not report (daemon restarting, machine asleep). */
const missed = new Set<number>();

function here(): boolean {
  return document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastTouch <= IDLE_MS;
}

async function beat(): Promise<void> {
  if (!here()) return;
  const body: PresenceBeat = { source: "reading", backfill: missed.size ? [...missed] : undefined };
  try {
    await fetch("/api/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    missed.clear();
  } catch {
    // Daemon down or asleep: remember the minute and send it with the next beat that lands.
    missed.add(minuteOf(Date.now()));
    if (missed.size > 1440) missed.delete([...missed][0]!);
  }
}

export function startPresence(): () => void {
  const touch = () => (lastTouch = Date.now());
  for (const e of EVENTS) window.addEventListener(e, touch, { passive: true, capture: true });
  // Coming back to the window is itself the touch that makes the beat count.
  const onVisible = () => {
    if (document.visibilityState === "visible") {
      touch();
      void beat();
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  void beat();
  const timer = setInterval(() => void beat(), PRESENCE_BEAT_MS);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    for (const e of EVENTS) window.removeEventListener(e, touch, { capture: true });
  };
}

/** Whether this window would beat right now: the strip counts the current minute locally. */
export const isHere = here;
