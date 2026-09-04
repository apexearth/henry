// Your side of a Claude session: when you last typed into it and how often you have been
// prompting it. activity.ts says what Claude is doing; this says whether *you* have been
// showing up, which is what tells a parked session from a neglected one. Two signals:
// the UserPromptSubmit hook (already in the event log, so a restart recovers it) and raw
// keystrokes relayed to the PTY (throttled, never persisted). Nothing is polled.
import { isClaudeSession } from "@henry/shared";
import * as db from "./db";
import { notePresence } from "./human";
import { sessions } from "./sessions";

/** How far back the rail's prompt sparkline looks. */
export const PROMPT_WINDOW_MS = 4 * 60 * 60_000;
/** Keystrokes only move lastInputAt this often: one session:update per burst, not per key. */
export const INPUT_THROTTLE_MS = 30_000;

/** Prompt timestamps per session, ascending, pruned to the window on every write. */
const prompts = new Map<string, number[]>();
const lastInput = new Map<string, number>();

/** Terminal replies xterm sends on its own (cursor reports, DA, focus, bracketed-paste
 * markers) are CSI/OSC sequences; anything left after stripping them was a person. A bare
 * ESC goes too, so Alt+key (ESC x) and Shift+Enter (ESC CR) still count by what follows. */
const CONTROL = /\x1b\[[0-9;?<>=]*[A-Za-z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b/g;

export function isHumanInput(data: string): boolean {
  return data.replace(CONTROL, "").length > 0;
}

function publish(sessionId: string): void {
  sessions.setEngagement(sessionId, lastInput.get(sessionId), prompts.get(sessionId));
}

function prune(list: number[], now: number): number[] {
  const cutoff = now - PROMPT_WINDOW_MS;
  let i = 0;
  while (i < list.length && list[i]! < cutoff) i++;
  return i ? list.slice(i) : list;
}

/** A hook arrived (hooks.ts). Only prompts and the session's end matter here. */
export function note(sessionId: string, hookEvent: string, ts = Date.now()): void {
  if (hookEvent === "SessionEnd") return clear(sessionId);
  if (hookEvent !== "UserPromptSubmit") return;
  const list = prune(prompts.get(sessionId) ?? [], ts);
  list.push(ts);
  prompts.set(sessionId, list);
  lastInput.set(sessionId, ts);
  publish(sessionId);
}

/** Keystrokes from a window (server.ts pty:input). Only Claude sessions count for neglect:
 * a plain shell has no "waiting for you". Your hours count either way — typing into a
 * terminal is you being here, whatever is running in it. */
export function input(sessionId: string, data: string, now = Date.now()): void {
  const s = sessions.get(sessionId);
  if (!s || s.status !== "running") return;
  if (!isHumanInput(data)) return;
  notePresence("terminal", now);
  if (!isClaudeSession(s)) return;
  const prev = lastInput.get(sessionId);
  if (prev !== undefined && now - prev < INPUT_THROTTLE_MS) return;
  lastInput.set(sessionId, now);
  publish(sessionId);
}

export function clear(sessionId: string): void {
  prompts.delete(sessionId);
  lastInput.delete(sessionId);
}

/** After a daemon restart: rebuild each running Claude session's prompt history from the event log. */
export function restore(now = Date.now()): void {
  for (const s of sessions.list()) {
    if (s.status !== "running" || prompts.has(s.id)) continue;
    const times = db.listHookTimes(s.id, "UserPromptSubmit", now - PROMPT_WINDOW_MS);
    if (!times.length) continue;
    prompts.set(s.id, times);
    lastInput.set(s.id, times[times.length - 1]!);
    publish(s.id);
  }
}

export function start(): void {
  restore();
}

export function stop(): void {
  prompts.clear();
  lastInput.clear();
}

