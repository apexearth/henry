// Whether you have looked at what a session did. notify.ts marks a session unseen when a turn
// ends after real work; this clears it when a window shows you the session or you type into
// it, keeps when you last had it in view, and keeps the reminders you set from the rail. The mark lives here, on the daemon that
// owns the session, so looking from the phone clears it on the desktop too.
import * as notify from "./notify";
import { sessions } from "./sessions";

/** How often due reminders are checked; a reminder is a "come back later", not an alarm clock. */
const TICK_MS = 15_000;

/** A turn ended after real work, or you marked it unread. The first time it happened is kept, so
 * "longest unseen" still means the one you have left longest. */
export function unseen(sessionId: string, ts = Date.now()): void {
  const s = sessions.get(sessionId);
  if (!s || s.status !== "running" || s.unseenSince !== undefined) return;
  sessions.setMarks(sessionId, { unseenSince: ts });
}

/** You typed into the session. */
export function seen(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s || s.unseenSince === undefined) return;
  sessions.setMarks(sessionId, { unseenSince: undefined });
}

/** lastSeenAt moves this often at most: the fade counts hours, and each move is a DB write and a broadcast. */
export const VIEW_GRAIN_MS = 60_000;

/** A window held the session in view (ui/seen.ts beats while it does): seen, and you were with it. */
export function viewed(sessionId: string, now = Date.now()): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  const stale = s.lastSeenAt === undefined || now - s.lastSeenAt >= VIEW_GRAIN_MS;
  if (s.unseenSince === undefined && !stale) return;
  sessions.setMarks(sessionId, { unseenSince: undefined, ...(stale ? { lastSeenAt: now } : {}) });
}

/** Setting a reminder is putting the session down for now, so it is also seen; null cancels. */
export function remind(sessionId: string, at: number | null): void {
  if (!sessions.get(sessionId)) return;
  sessions.setMarks(sessionId, at === null ? { remindAt: undefined } : { unseenSince: undefined, remindAt: at });
}

/** Due reminders come back unseen, with a notice. A daemon that was down past one fires it on start. */
export function tick(now = Date.now()): void {
  for (const s of sessions.list()) {
    if (s.status !== "running" || s.remindAt === undefined || s.remindAt > now) continue;
    sessions.setMarks(s.id, { unseenSince: s.unseenSince ?? now, remindAt: undefined });
    notify.onRemind(s, now);
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

export function start(): void {
  tick();
  timer = setInterval(() => tick(), TICK_MS);
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
