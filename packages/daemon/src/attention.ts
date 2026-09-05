/**
 * Asks: a session reaching for the human, raised through the `henry_attention` MCP tool.
 *
 * Henry's tools are otherwise read-only, and this is the one exception, so it is drawn tightly.
 * An ask is addressed to the user and to nobody else: it cannot reach another session, it says
 * nothing about Henry's config, and it never blocks the session that raised it. It carries a
 * deadline because that is what makes it different from a flag — a session that wants the user
 * *eventually* already has the rail, where a finished turn shows as "your move". This is for the
 * thing that goes stale: an expiring code, a deploy window, a question worth interrupting for.
 *
 * Live asks are kept in memory and mirrored to SQLite, so a daemon restart brings them back and
 * a finished one stays as history until the retention sweep.
 */
import type { Attention, ServerMessage } from "@henry/shared";
import * as db from "./db";

/** One line, and short enough to read in a rail tooltip. */
export const MAX_MESSAGE = 200;
/** Per session. A session with three unanswered asks does not need a fourth; it needs the user. */
export const MAX_OPEN_PER_SESSION = 3;
export const DEFAULT_TTL_MS = 30 * 60_000;
export const MAX_TTL_MS = 12 * 60 * 60_000;
/**
 * The longest a `henry_attention` call is held open waiting for the user. Claude Code gives up
 * on an MCP tool call at 60s (verified 2026-09-04: a tool that sleeps 70s comes back to the
 * model as "The operation timed out"), so holding longer would turn a patient session into an
 * error. Under that ceiling the answer is always Henry's, not a timeout's; a session that needs
 * longer calls again, and the ask stands the whole time either way.
 */
export const MAX_WAIT_MS = 55_000;
const SWEEP_MS = 15_000;

const live = new Map<string, Attention>();
const waiters = new Map<string, Set<(a: Attention) => void>>();

let emit: (msg: ServerMessage) => void = () => {};
let windows = () => 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** server.ts injects its broadcast; tests inject a collector. */
export function setBroadcast(fn: (msg: ServerMessage) => void): void {
  emit = fn;
}

/** How many windows are attached. An ask nobody can see is worth saying so to the session. */
export function setWindowCount(fn: () => number): void {
  windows = fn;
}

export function windowCount(): number {
  return windows();
}

/** Oldest first: the ask that has waited longest is the one the user is kept from. */
export function open(): Attention[] {
  return [...live.values()].sort((a, b) => a.ts - b.ts);
}

export function openFor(sessionId: string): Attention[] {
  return open().filter((a) => a.sessionId === sessionId);
}

export function get(id: string): Attention | undefined {
  return live.get(id);
}

function oneLine(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > MAX_MESSAGE ? s.slice(0, MAX_MESSAGE - 1) + "…" : s;
}

export interface RaiseInput {
  /** "" when Henry could not tell which session called: the ask still shows, with nothing to jump to. */
  sessionId: string;
  message: string;
  /** Minutes it stays worth interrupting for. */
  minutes?: number;
}

export type RaiseResult = { ok: true; ask: Attention; already?: boolean } | { ok: false; reason: string };

export function raise(input: RaiseInput, now = Date.now()): RaiseResult {
  const message = oneLine(input.message);
  if (!message) return { ok: false, reason: "an ask needs a message: one line saying what you need from the user" };
  const minutes = Number.isFinite(input.minutes) ? Math.max(1, Math.min(MAX_TTL_MS / 60_000, input.minutes!)) : DEFAULT_TTL_MS / 60_000;

  const mine = openFor(input.sessionId);
  // The same words twice is a retry, not a second ask; hand back the one already showing.
  const same = mine.find((a) => a.message === message);
  if (same) return { ok: true, ask: same, already: true };
  if (mine.length >= MAX_OPEN_PER_SESSION) {
    return { ok: false, reason: `already ${mine.length} asks open for this session and none answered yet; withdraw one (done:"<id>") before raising another` };
  }

  // Short: the model reads it out of the answer and types it back to withdraw the ask.
  let id = crypto.randomUUID().slice(0, 8);
  while (live.has(id)) id = crypto.randomUUID().slice(0, 8);
  const ask: Attention = { id, sessionId: input.sessionId, ts: now, message, deadline: now + minutes * 60_000 };
  live.set(ask.id, ask);
  db.upsertAttention(ask);
  emit({ type: "attention:update", attention: ask });
  ensureSweep();
  return { ok: true, ask };
}

/** End an ask: the user came, the session withdrew it, or its deadline passed. */
export function finish(id: string, done: NonNullable<Attention["done"]>, now = Date.now()): Attention | undefined {
  const ask = live.get(id);
  if (!ask) return undefined;
  const closed: Attention = { ...ask, done, doneAt: now };
  live.delete(id);
  db.upsertAttention(closed);
  emit({ type: "attention:update", attention: closed });
  for (const w of waiters.get(id) ?? []) w(closed);
  waiters.delete(id);
  return closed;
}

/** The user showed up in this session (typed into it, or opened its ask). */
export function answered(sessionId: string, now = Date.now()): void {
  for (const a of openFor(sessionId)) finish(a.id, "answered", now);
}

/** Hold until the ask ends, or until `ms` runs out; the ask itself is untouched either way. */
export function waitFor(id: string, ms: number): Promise<Attention | undefined> {
  const ask = live.get(id);
  if (!ask) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const set = waiters.get(id) ?? new Set();
    waiters.set(id, set);
    const done = (a: Attention | undefined) => {
      set.delete(cb);
      clearTimeout(t);
      resolve(a);
    };
    const cb = (a: Attention) => done(a);
    set.add(cb);
    const t = setTimeout(() => done(undefined), Math.max(0, ms));
  });
}

/** A session that ended takes its asks with it: nobody is there to answer them. */
export function clearSession(sessionId: string, now = Date.now()): void {
  for (const a of openFor(sessionId)) finish(a.id, "expired", now);
}

export function sweep(now = Date.now()): void {
  for (const a of open()) if (a.deadline <= now) finish(a.id, "expired", now);
  if (!live.size) stopSweep();
}

function ensureSweep(): void {
  if (timer || !live.size) return;
  timer = setInterval(() => sweep(), SWEEP_MS);
  timer.unref?.();
}

function stopSweep(): void {
  clearInterval(timer);
  timer = undefined;
}

/** Bring live asks back after a restart, dropping any whose deadline passed while we were down. */
export function start(now = Date.now()): void {
  for (const a of db.listOpenAttention()) live.set(a.id, a);
  sweep(now);
  ensureSweep();
}

export function stop(): void {
  stopSweep();
  live.clear();
  waiters.clear();
}
