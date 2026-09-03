// Is this session working, blocked on me, or idle? Derived from the hook stream hooks.ts
// already ingests: one switch per event, no polling and no PTY scraping. The only timer is
// a slow tick that ages a waiting session into idle and gives up on one that went silent
// mid-turn. Never persisted: restore() re-derives it from the event log after a restart.
import type { SessionActivity } from "@henry/shared";
import * as db from "./db";
import { sessions } from "./sessions";

/** A session waiting this long for the user has stopped being "just finished". */
export const IDLE_AFTER_MS = 10 * 60_000;
/** No hook and no statusline for this long: we no longer believe "working". */
export const SILENT_AFTER_MS = 15 * 60_000;
const TICK_MS = 10_000;

/** Claude Code's permission notifications ("Claude needs your permission to use Bash"); the
 * other kind ("waiting for your input") is the 60s nudge, which is already `waiting`. */
const PERMISSION = /permission|approve|confirm/i;

interface Payload {
  stop_hook_active?: boolean;
  message?: string;
}

/** The state a hook event implies, or undefined when it says nothing about activity. */
export function nextActivity(hookEvent: string, payload: Payload = {}): SessionActivity | undefined {
  switch (hookEvent) {
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "SubagentStop":
    case "PreCompact":
      return "working";
    case "Stop":
      // stop_hook_active: another Stop hook sent Claude back for more, so the turn goes on.
      return payload.stop_hook_active ? "working" : "waiting";
    case "Notification":
      return PERMISSION.test(payload.message ?? "") ? "needsInput" : "waiting";
    case "SessionStart":
      // Startup, /clear or a resume: Claude is sitting at the prompt.
      return "waiting";
    default:
      return undefined;
  }
}

/** Last hook or statusline seen per session; only the tick reads it. */
const lastSeen = new Map<string, number>();

export function note(sessionId: string, hookEvent: string, payload: unknown, ts = Date.now()): void {
  if (hookEvent === "SessionEnd") return clear(sessionId);
  lastSeen.set(sessionId, ts);
  const next = nextActivity(hookEvent, (payload ?? {}) as Payload);
  if (next) sessions.setActivity(sessionId, next, ts);
}

/** The statusline command fires while Claude renders: a heartbeat, not a state change. */
export function seen(sessionId: string, ts = Date.now()): void {
  lastSeen.set(sessionId, ts);
}

export function clear(sessionId: string): void {
  lastSeen.delete(sessionId);
  sessions.setActivity(sessionId, undefined);
}

/** Move stale states on. Takes `now` so tests can jump time. */
export function age(now = Date.now()): void {
  for (const s of sessions.list()) {
    if (!s.activity || s.activity === "idle" || s.status !== "running") continue;
    const since = s.activitySince ?? now;
    if (s.activity === "waiting" && now - since >= IDLE_AFTER_MS) sessions.setActivity(s.id, "idle", now);
    // "working" with nothing arriving is a claim we cannot back: a daemon that was down,
    // hooks uninstalled, a session that went away. "needsInput" stays until it is answered.
    else if (s.activity === "working" && now - (lastSeen.get(s.id) ?? since) >= SILENT_AFTER_MS) sessions.setActivity(s.id, "idle", now);
  }
}

/**
 * After a daemon restart the running sessions have no activity until their next hook —
 * and one waiting for the user sends none. Re-derive from the last hook event we stored.
 */
export function restore(now = Date.now()): void {
  for (const s of sessions.list()) {
    if (s.status !== "running" || s.activity) continue;
    for (const e of db.listEvents({ sessionId: s.id, limit: 20 })) {
      if (e.kind !== "hook" || !e.hookEvent) continue;
      const next = nextActivity(e.hookEvent, (e.payload ?? {}) as Payload);
      if (!next) continue;
      lastSeen.set(s.id, e.ts);
      sessions.setActivity(s.id, next, e.ts);
      break;
    }
  }
  age(now);
}

let timer: ReturnType<typeof setInterval> | undefined;

export function start(): void {
  restore();
  timer ??= setInterval(() => age(), TICK_MS);
}

export function stop(): void {
  clearInterval(timer);
  timer = undefined;
  lastSeen.clear();
}
