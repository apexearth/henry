// What is worth saying from outside the window: a session stopped and needs the user.
// Decided here, once, off the activity transitions and asks the daemon already has, so every
// delivery — a window raising an OS notification today, a push to a phone later — says the
// same things. The daemon never shows anything itself; it only broadcasts the notice.
import type { Attention, Notice, ServerMessage, Session } from "@henry/shared";
import { sessions } from "./sessions";

/** A turn shorter than this ending is an answer to a question, not work you walked away from. */
export const MIN_WORKED_MS = 10_000;

let emit: (msg: ServerMessage) => void = () => {};

/** server.ts injects its broadcast; tests inject a collector. */
export function setBroadcast(fn: (msg: ServerMessage) => void): void {
  emit = fn;
}

/** The last activity seen per session, so an update can be read as a transition. */
const last = new Map<string, Pick<Session, "activity" | "activitySince">>();

const notice = (s: Session, kind: Notice["kind"], body: string, ts: number): Notice => ({
  id: crypto.randomUUID().slice(0, 8),
  sessionId: s.id,
  kind,
  title: s.title,
  body,
  ts,
  ...(s.peer ? { peer: s.peer } : {}),
});

/** Pure: what `next` says given what the session was doing before. A session first seen in a
 * state is not a transition. */
export function decide(prev: Pick<Session, "activity" | "activitySince"> | undefined, next: Session, now = Date.now()): Notice | undefined {
  if (!prev || next.status !== "running" || prev.activity === next.activity) return undefined;
  if (next.activity === "needsInput") return notice(next, "needsInput", "needs your permission", now);
  if (next.activity === "waiting" && prev.activity === "working" && now - (prev.activitySince ?? now) >= MIN_WORKED_MS) {
    return notice(next, "waiting", "finished — your move", now);
  }
  return undefined;
}

/** Engagement updates come through the same event as activity; only a change of state counts. */
export function onSessionUpdate(s: Session, now = Date.now()): void {
  const prev = last.get(s.id);
  if (s.status !== "running") {
    last.delete(s.id);
    return;
  }
  last.set(s.id, { activity: s.activity, activitySince: s.activitySince });
  const n = decide(prev, s, now);
  if (n) emit({ type: "notify", notice: n });
}

/** An ask is always worth saying: the session used its one interruption on it. */
export function onAsk(ask: Attention): void {
  if (ask.done) return;
  const s = sessions.get(ask.sessionId);
  if (!s) return;
  emit({ type: "notify", notice: notice(s, "ask", ask.message, ask.ts) });
}

/** Called once activity has been restored: what every session is doing now is the baseline,
 * so a daemon restart says nothing and the first real change after it is still heard. */
export function start(): void {
  for (const s of sessions.list()) if (s.status === "running") last.set(s.id, { activity: s.activity, activitySince: s.activitySince });
  sessions.on("update", (s) => onSessionUpdate(s));
}

export function stop(): void {
  last.clear();
}
