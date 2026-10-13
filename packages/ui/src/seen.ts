// Telling the daemon you have seen a session. Seen means the session was the one in view, in a
// window you are actually using (visible, focused, touched lately: presence.ts's "here"), for
// a moment. Flicking past a row on ⌘↑/↓ is not looking at it, and nor is a window left open on
// another monitor while a session finishes in it.
import { isHere } from "./presence";
import { getState, isUnseen, markSeen } from "./ws";

const DWELL_MS = 1500;

/** Marked unread from the rail while in view: it stays unread until you have moved off it. */
let held: string | null = null;

export function markUnread(sessionId: string): void {
  if (sessionId === getState().activeSessionId) held = sessionId;
  markSeen(sessionId, false);
}

export function startSeen(): () => void {
  let viewing: string | null = null;
  let since = 0;
  /** Sent once per unseen spell, so a slow round trip does not resend it every tick. */
  let told: string | null = null;
  const timer = setInterval(() => {
    const s = getState();
    const unseen = (sid: string | null) => {
      const x = sid ? s.sessions.find((y) => y.id === sid) : undefined;
      return !!x && isUnseen(x);
    };
    // The daemon has cleared it: a later unseen spell of the same session is news again.
    if (told && !unseen(told)) told = null;
    const id = s.activeSessionId;
    if (id !== viewing) {
      viewing = id;
      since = Date.now();
      if (held !== id) held = null;
    }
    if (held === id) return;
    if (!isHere()) since = Date.now();
    if (!unseen(id) || told === id || Date.now() - since < DWELL_MS) return;
    told = id;
    markSeen(id!, true);
  }, 500);
  return () => clearInterval(timer);
}
