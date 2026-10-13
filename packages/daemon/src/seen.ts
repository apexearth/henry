// Whether you have looked at what a session did. notify.ts marks a session unseen when a turn
// ends after real work; this clears it when a window shows you the session or you type into
// it, and keeps the reminders you set from the rail. The mark lives here, on the daemon that
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
  sessions.setMarks(sessionId, { unseenSince: ts, remindAt: s.remindAt });
}

/** You looked (a window held the session in view) or typed into it. */
export function seen(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s || s.unseenSince === undefined) return;
  sessions.setMarks(sessionId, { unseenSince: undefined, remindAt: s.remindAt });
}

/** Setting a reminder is putting the session down for now, so it is also seen; null cancels. */
export function remind(sessionId: string, at: number | null): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.setMarks(sessionId, at === null ? { unseenSince: s.unseenSince, remindAt: undefined } : { unseenSince: undefined, remindAt: at });
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
