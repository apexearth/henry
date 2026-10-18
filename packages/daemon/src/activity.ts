// Is this session working, blocked on me, or idle? Derived from the hook stream hooks.ts
// already ingests: one switch per event, no polling and no PTY scraping. Background work that
// outlives a turn comes from the transcript instead, the one place both its ends are written.
// The only timer is
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
/** How far back restore() replays a running session's hooks; a blocked turn sends few. */
const RESTORE_EVENTS = 50;

/** Claude Code's permission notifications ("Claude needs your permission to use Bash"); the
 * other kind ("waiting for your input") is the 60s nudge, which is already `waiting`. */
const PERMISSION = /permission|approve|confirm/i;

/** Tools that run long and never open a permission prompt themselves. */
const NEVER_PROMPTS = new Set(["Agent", "Task"]);

/** Tools whose call is itself a question to the user, answered without a PermissionRequest. */
const ASKS_USER = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** Background work younger than this holds a finished turn out of "your move": long enough for a
 * build or a test run, short enough that a dev server left running reads as your move soon. */
export const BACKGROUND_HOLD_MS = 20 * 60_000;
/** The last background task ended after the turn did: Claude Code wakes the model to read it,
 * and this is how long that turn has to send a hook before the session reads as your move. */
export const WAKE_GRACE_MS = 60_000;

interface Payload {
  stop_hook_active?: boolean;
  message?: string;
  source?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  /** Set on hooks a subagent's tool calls fire; they interleave with the main thread's. */
  agent_id?: string;
}

/**
 * Tool calls in flight for one session. Claude issues several calls per message and Claude
 * Code prompts for them one at a time, so the first approval's PostToolUse must not read as
 * working while the next prompt is up. PermissionRequest fires the moment each prompt opens
 * but carries no tool_use_id, so the call is matched by tool name and input; the
 * permission Notification fires once per batch after ~6 s of silence, so it blocks on every
 * call in flight from the thread that made the latest call (the prompt follows its
 * PreToolUse; other subagents may be mid-tool for minutes). Working again means every
 * blocked call has answered. Denied calls (mine or the auto-mode classifier's) fire no hook
 * at all: the transcript's tool_result prunes those (toolResult), and a thread's next call
 * releases whatever it was blocked on, since it can only proceed once its prompt is gone.
 */
export interface Turn {
  /** tool_use_id -> thread ("" for the main thread, else the subagent's agent_id) and the call's identity. */
  pending: Map<string, { thread: string; sig: string }>;
  /** The calls in flight when the last permission prompt appeared. */
  blocked: Set<string>;
  /** Thread of the latest call; a prompt belongs to it. */
  last: string;
}

export const newTurn = (): Turn => ({ pending: new Map(), blocked: new Set(), last: "" });

const reset = (turn: Turn) => {
  turn.pending.clear();
  turn.blocked.clear();
};

const signature = (p: Payload) => `${p.tool_name ?? ""}\0${JSON.stringify(p.tool_input ?? null)}`;

function pendingOf(turn: Turn, pick: (id: string, e: { thread: string; sig: string }) => boolean): string[] {
  const out: string[] = [];
  for (const [id, e] of turn.pending) if (pick(id, e)) out.push(id);
  return out;
}

/**
 * The state a hook event implies, or undefined when it says nothing about activity.
 * Undefined events still count as a heartbeat. SubagentStop is deliberately one of them:
 * Claude Code fires it for background agents that outlive the turn (the "away summary"
 * it writes minutes after a Stop, plugin workers), and every one seen so far arrived after
 * a Stop or Notification. Reading it as "working" pinned finished sessions to orange
 * until the silence timeout. A subagent that runs mid-turn changes nothing: the
 * PreToolUse that launched it already said working.
 */
export function nextActivity(hookEvent: string, payload: Payload = {}, turn: Turn = newTurn()): SessionActivity | undefined {
  const id = payload.tool_use_id;
  const thread = payload.agent_id ?? "";
  switch (hookEvent) {
    case "UserPromptSubmit":
      reset(turn);
      return "working";
    case "PreToolUse":
      // Not a resolution of earlier calls (a batch fires all its PreToolUse first), but a
      // thread cannot issue one while its own prompt is up.
      for (const b of pendingOf(turn, (k, e) => e.thread === thread && turn.blocked.has(k))) turn.blocked.delete(b);
      if (id && !NEVER_PROMPTS.has(payload.tool_name ?? "")) turn.pending.set(id, { thread, sig: signature(payload) });
      turn.last = thread;
      // The question is up the moment the call starts; its PostToolUse is the answer.
      if (id && ASKS_USER.has(payload.tool_name ?? "")) {
        turn.blocked.add(id);
        return "needsInput";
      }
      // Another thread carrying on while a prompt is up is a heartbeat.
      return turn.blocked.size ? undefined : "working";
    case "PostToolUse":
      if (id) {
        turn.pending.delete(id);
        turn.blocked.delete(id);
      }
      return turn.blocked.size ? undefined : "working";
    case "PermissionRequest": {
      const sig = signature(payload);
      const match = pendingOf(turn, (_, e) => e.sig === sig);
      turn.blocked = new Set(match.length ? match : pendingOf(turn, (_, e) => e.thread === turn.last));
      return "needsInput";
    }
    case "Notification":
      if (!PERMISSION.test(payload.message ?? "")) return "waiting";
      if (!turn.blocked.size) turn.blocked = new Set(pendingOf(turn, (_, e) => e.thread === turn.last));
      return "needsInput";
    case "Stop":
      reset(turn);
      // stop_hook_active: another Stop hook sent Claude back for more, so the turn goes on.
      return payload.stop_hook_active ? "working" : "waiting";
    case "SubagentStop":
      // That thread's calls are over, hooks or no hooks; the turn itself carries on.
      if (payload.agent_id) for (const k of pendingOf(turn, (_, e) => e.thread === payload.agent_id)) turn.pending.delete(k), turn.blocked.delete(k);
      return undefined;
    case "SessionStart":
      // Startup, /clear or a resume: Claude is sitting at the prompt. After a compaction
      // the turn (or the prompt) simply carries on, so keep whatever state it was in.
      if (payload.source === "compact") return undefined;
      reset(turn);
      return "waiting";
    default:
      // PreCompact (auto-compact happens mid-turn, manual at the prompt) and anything new:
      // heartbeat only.
      return undefined;
  }
}

const turns = new Map<string, Turn>();
const turnOf = (sessionId: string): Turn => {
  let t = turns.get(sessionId);
  if (!t) turns.set(sessionId, (t = newTurn()));
  return t;
};

/** Last hook or statusline seen per session; only the tick reads it. */
const lastSeen = new Map<string, number>();

/**
 * Work a session left running past its turn: tool_use_id -> when it started. The transcript is
 * the only place both ends are written (transcript.ts), so it alone opens and closes them; a
 * task whose end never shows up stops counting at BACKGROUND_HOLD_MS.
 */
const background = new Map<string, Map<string, number>>();
/** When a session's last background task ended with its turn already over. */
const woke = new Map<string, number>();

export function stats(): Record<string, number> {
  let tasks = 0;
  for (const m of background.values()) tasks += m.size;
  return { activityTurns: turns.size, activityLastSeen: lastSeen.size, activityBackground: tasks };
}

function holding(sessionId: string, now: number): boolean {
  for (const started of background.get(sessionId)?.values() ?? []) if (now - started < BACKGROUND_HOLD_MS) return true;
  return now - (woke.get(sessionId) ?? -Infinity) < WAKE_GRACE_MS;
}

/** A finished turn is `background` while work it started is still running, and your move after. */
function settle(sessionId: string, now: number): void {
  const s = sessions.get(sessionId);
  if (!s || s.status !== "running") return;
  if (s.activity !== "waiting" && s.activity !== "idle" && s.activity !== "background") return;
  const hold = holding(sessionId, now);
  if (hold && s.activity !== "background") sessions.setActivity(sessionId, "background", now);
  else if (!hold && s.activity === "background") sessions.setActivity(sessionId, "waiting", now);
}

export function note(sessionId: string, hookEvent: string, payload: unknown, ts = Date.now()): void {
  if (hookEvent === "SessionEnd") return clear(sessionId);
  lastSeen.set(sessionId, ts);
  let next = nextActivity(hookEvent, (payload ?? {}) as Payload, turnOf(sessionId));
  if (next === "working") woke.delete(sessionId);
  if (next === "waiting" && holding(sessionId, ts)) next = "background";
  if (next) sessions.setActivity(sessionId, next, ts);
}

/** The transcript says a tool call left work running (a backgrounded command, an async agent). */
export function backgroundStarted(sessionId: string, toolUseId: string, ts: number): void {
  let open = background.get(sessionId);
  if (!open) background.set(sessionId, (open = new Map()));
  open.set(toolUseId, ts);
  settle(sessionId, Date.now());
}

/** The transcript carries that work's <task-notification>: it finished, failed or was killed. */
export function backgroundEnded(sessionId: string, toolUseId: string, ts: number): void {
  const open = background.get(sessionId);
  if (!open?.delete(toolUseId)) return;
  if (!open.size) background.delete(sessionId);
  if (sessions.get(sessionId)?.activity === "background") woke.set(sessionId, ts);
  settle(sessionId, Date.now());
}

/** The transcript answered a tool call (transcript.ts). Denials come only this way; a prune, never a state change. */
export function toolResult(sessionId: string, toolUseId: string): void {
  const turn = turns.get(sessionId);
  if (!turn) return;
  turn.pending.delete(toolUseId);
  turn.blocked.delete(toolUseId);
}

/** The statusline command fires while Claude renders: a heartbeat, not a state change. */
export function seen(sessionId: string, ts = Date.now()): void {
  lastSeen.set(sessionId, ts);
}

export function clear(sessionId: string): void {
  lastSeen.delete(sessionId);
  turns.delete(sessionId);
  background.delete(sessionId);
  woke.delete(sessionId);
  sessions.setActivity(sessionId, undefined);
}

/** Move stale states on. Takes `now` so tests can jump time. */
export function age(now = Date.now()): void {
  for (const [id, open] of background) {
    for (const [k, started] of open) if (now - started >= BACKGROUND_HOLD_MS) open.delete(k);
    if (!open.size) background.delete(id);
  }
  for (const s of sessions.list()) settle(s.id, now);
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
 * and one waiting for the user sends none. Replay the last stored hook events in order,
 * so a turn blocked on a permission prompt comes back with its in-flight calls too.
 */
export function restore(now = Date.now()): void {
  for (const s of sessions.list()) {
    if (s.status !== "running" || s.activity) continue;
    for (const e of db.listEvents({ sessionId: s.id, limit: RESTORE_EVENTS }).reverse()) {
      if (e.kind === "hook" && e.hookEvent) note(s.id, e.hookEvent, e.payload, e.ts);
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
  turns.clear();
  background.clear();
  woke.clear();
}
