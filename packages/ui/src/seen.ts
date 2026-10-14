// Telling the daemon you are looking at a session. Looking means the session was the one in
// view, in a window you are actually using (visible, focused, touched lately: presence.ts's
// "here"), for a moment. Flicking past a row on ⌘↑/↓ is not looking at it, and nor is a window
// left open on another monitor while a session finishes in it. It clears an unseen mark at once
// and, repeated about once a minute while you stay, keeps the session among the ones you are
// working with (the rail fades the rest).
import { isHere } from "./presence";
import { getState, isUnseen, markSeen } from "./ws";

const DWELL_MS = 1500;
/** The daemon keeps lastSeenAt to the minute; telling it more often only costs broadcasts. */
const REPEAT_MS = 60_000;

/** Marked unread from the rail while in view: it stays unread until you have moved off it. */
let held: string | null = null;

export function markUnread(sessionId: string): void {
  if (sessionId === getState().activeSessionId) held = sessionId;
  markSeen(sessionId, false);
}

export function startSeen(): () => void {
  let viewing: string | null = null;
  let since = 0;
  /** When this window last told the daemon about each session, and whether it was unseen then:
   * an unseen mark is told once per spell, so a slow round trip does not resend it every tick. */
  const told = new Map<string, { at: number; unseen: boolean }>();
  const timer = setInterval(() => {
    const s = getState();
    const id = s.activeSessionId;
    if (id !== viewing) {
      viewing = id;
      since = Date.now();
      if (held !== id) held = null;
    }
    if (!isHere()) since = Date.now();
    if (!id || held === id || Date.now() - since < DWELL_MS) return;
    const session = s.sessions.find((x) => x.id === id);
    if (!session || session.status !== "running") return;
    const unseen = isUnseen(session);
    const last = told.get(id);
    // The daemon has cleared the mark: the next unseen spell is news again.
    if (last && !unseen) last.unseen = false;
    const due = !last || Date.now() - last.at >= REPEAT_MS || (unseen && !last.unseen);
    if (!due) return;
    told.set(id, { at: Date.now(), unseen });
    markSeen(id, true);
  }, 500);
  return () => clearInterval(timer);
}
