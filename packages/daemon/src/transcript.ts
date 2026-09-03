// Tails ~/.claude/projects/<slug>/<claude_session_id>.jsonl for per-session token totals
// (db.upsertSessionUsage -> {type:"usage:update"}) and subagent (sidechain) transitions.
// The transcript_path from a hook payload is authoritative; otherwise the path is derived
// from the session cwd the same way Claude Code does (every "/" and "." becomes "-").
//
// One API message is written as several JSONL lines (one per content block, same
// message.id, identical usage), so usage is counted once per message id.
import { closeSync, existsSync, openSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { HenryEvent, Session, SessionUsage, Usage } from "@henry/shared";
import * as activity from "./activity";
import * as db from "./db";
import { broadcast } from "./server";
import { sessions } from "./sessions";

const POLL_MS = 2000;
const BROADCAST_THROTTLE_MS = 2000;
const MAX_SEEN_IDS = 5000;

/** USD per million tokens: [input, output]. Cache read = 10% of input, cache write = 125% of input. */
const PRICES: Record<string, [number, number]> = {
  opus: [5, 25],
  sonnet: [2, 10],
  fable: [10, 50],
  haiku: [1, 5],
};

export function priceFor(model: string | undefined): [number, number] {
  const m = (model ?? "").toLowerCase();
  for (const key of Object.keys(PRICES)) if (m.includes(key)) return PRICES[key];
  return PRICES.opus;
}

export function estimateCost(u: Pick<SessionUsage, "inputTokens" | "outputTokens" | "cacheRead" | "cacheWrite">, model?: string): number {
  const [inP, outP] = priceFor(model);
  const perTok = 1 / 1_000_000;
  return (u.inputTokens * inP + u.outputTokens * outP + u.cacheRead * inP * 0.1 + u.cacheWrite * inP * 1.25) * perTok;
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Claude Code's project slug: the absolute cwd with "/" and "." replaced by "-". */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export function transcriptPathFor(cwd: string, claudeSessionId: string): string {
  return join(claudeConfigDir(), "projects", projectSlug(cwd), `${claudeSessionId}.jsonl`);
}

interface Tail {
  sessionId: string;
  path: string;
  offset: number;
  partial: string;
  watcher?: FSWatcher;
  timer: ReturnType<typeof setInterval>;
  /** Totals carried over from an earlier transcript of the same Henry session (e.g. after /clear). */
  base: Totals;
  totals: Totals;
  model?: string;
  /** Context occupancy after the latest main-chain assistant message (subagent lines excluded). */
  context?: number;
  seen: Set<string>;
  inSidechain: boolean;
  reading: boolean;
}

interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

const zero = (): Totals => ({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 });

const tails = new Map<string, Tail>();

/** Values the statusline reported for a session; cost from Claude Code wins over our estimate. */
interface StatuslineHint {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
}
const hints = new Map<string, StatuslineHint>();

/** Start (or switch) tailing for a session. `transcriptPath` from a hook payload wins over the derived path. */
export function startTailing(session: Session, transcriptPath?: string): void {
  const claudeId = session.claudeSessionId;
  const path = transcriptPath || (claudeId ? transcriptPathFor(session.cwd, claudeId) : undefined);
  if (!path) return;
  const existing = tails.get(session.id);
  if (existing?.path === path) return;
  let base = zero();
  if (existing) {
    base = sum(existing.base, existing.totals);
    stopTailing(session.id);
  }
  const tail: Tail = {
    sessionId: session.id,
    path,
    offset: 0,
    partial: "",
    timer: setInterval(() => tick(tail), POLL_MS),
    base,
    totals: zero(),
    seen: new Set(),
    inSidechain: false,
    reading: false,
  };
  tails.set(session.id, tail);
  console.log(`[transcript] tailing ${path} for ${session.id.slice(0, 8)}`);
  tick(tail);
}

export function stopTailing(sessionId: string): void {
  const tail = tails.get(sessionId);
  if (!tail) return;
  tick(tail);
  clearInterval(tail.timer);
  tail.watcher?.close();
  tails.delete(sessionId);
}

export function isTailing(sessionId: string): boolean {
  return tails.has(sessionId);
}

/** Merge what the statusline knows about a session (its cost is authoritative). */
export function noteStatuslineUsage(sessionId: string, hint: StatuslineHint): void {
  hints.set(sessionId, { ...hints.get(sessionId), ...hint });
  writeUsage(sessionId);
  scheduleBroadcast();
}

/** The Usage object every window sees: latest statusline snapshot + per-session rows. */
export function currentUsage(): Usage {
  const snapshot = db.latestUsageSnapshot<Usage>();
  const usage: Usage = snapshot?.json ?? { perSession: {}, updatedAt: 0 };
  usage.perSession = db.listSessionUsage();
  return usage;
}

let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
let lastBroadcast = 0;

/** Broadcast usage:update at most once per BROADCAST_THROTTLE_MS. */
export function scheduleBroadcast(immediate = false): void {
  const due = lastBroadcast + BROADCAST_THROTTLE_MS - Date.now();
  if (immediate || due <= 0) {
    if (broadcastTimer) clearTimeout(broadcastTimer);
    broadcastTimer = undefined;
    lastBroadcast = Date.now();
    broadcast({ type: "usage:update", usage: currentUsage() });
    return;
  }
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    lastBroadcast = Date.now();
    broadcast({ type: "usage:update", usage: currentUsage() });
  }, due);
}

// ---- internals ----

function sum(a: Totals, b: Totals): Totals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

function writeUsage(sessionId: string): void {
  const tail = tails.get(sessionId);
  const hint = hints.get(sessionId);
  const totals = tail ? sum(tail.base, tail.totals) : undefined;
  const hasTranscript = !!totals && (totals.inputTokens || totals.outputTokens || totals.cacheRead || totals.cacheWrite);
  const prev = db.listSessionUsage()[sessionId];
  const model = tail?.model ?? hint?.model ?? prev?.model;
  const row: SessionUsage = hasTranscript
    ? { ...totals!, costUsd: 0, model }
    : {
        inputTokens: hint?.inputTokens ?? 0,
        outputTokens: hint?.outputTokens ?? 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
        model,
      };
  row.costUsd = hint?.costUsd ?? estimateCost(row, model);
  // The transcript sees every turn; the statusline fills in until the first one lands (and after /clear).
  const context = tail?.context ?? hint?.contextTokens;
  if (context !== undefined) row.contextTokens = context;
  const window = hint?.contextWindow ?? prev?.contextWindow;
  if (window !== undefined) row.contextWindow = window;
  db.upsertSessionUsage(sessionId, row);
}

function ensureWatcher(tail: Tail): void {
  if (tail.watcher || !existsSync(tail.path)) return;
  try {
    tail.watcher = watch(tail.path, () => tick(tail));
    tail.watcher.on("error", () => {
      tail.watcher?.close();
      tail.watcher = undefined;
    });
  } catch {
    // poll fallback covers it
  }
}

function tick(tail: Tail): void {
  if (tail.reading) return;
  tail.reading = true;
  try {
    let size: number;
    try {
      size = statSync(tail.path).size;
    } catch {
      return; // not written yet
    }
    ensureWatcher(tail);
    if (size < tail.offset) {
      // truncated / rewritten: start over
      tail.offset = 0;
      tail.partial = "";
      tail.totals = zero();
      tail.context = undefined;
      tail.seen.clear();
    }
    if (size === tail.offset) return;
    const fd = openSync(tail.path, "r");
    let changed = false;
    try {
      const buf = Buffer.alloc(size - tail.offset);
      const n = readSync(fd, buf, 0, buf.length, tail.offset);
      tail.offset += n;
      const text = tail.partial + buf.toString("utf8", 0, n);
      const lines = text.split("\n");
      tail.partial = lines.pop() ?? "";
      for (const line of lines) if (line.trim() && handleLine(tail, line)) changed = true;
    } finally {
      closeSync(fd);
    }
    if (changed) {
      writeUsage(tail.sessionId);
      scheduleBroadcast();
    }
  } catch (e) {
    console.error(`[transcript] ${basename(tail.path)}: ${(e as Error).message}`);
  } finally {
    tail.reading = false;
  }
}

interface TranscriptLine {
  type?: string;
  uuid?: string;
  requestId?: string;
  isSidechain?: boolean;
  agentId?: string;
  /** `/rename` writes {type:"custom-title", customTitle}. */
  customTitle?: string;
  message?: {
    id?: string;
    model?: string;
    /** Blocks; a "user" line carries the tool_result answering each tool_use. */
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/** Returns true when usage totals changed. */
function handleLine(tail: Tail, raw: string): boolean {
  let line: TranscriptLine;
  try {
    line = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!line || typeof line !== "object") return false;
  noteSidechain(tail, line);
  if (line.type === "custom-title" && typeof line.customTitle === "string") sessions.setTitle(tail.sessionId, line.customTitle);
  if (line.type === "user") noteToolResults(tail, line);
  if (line.type !== "assistant") return false;
  const usage = line.message?.usage;
  if (!usage) return false;
  if (line.isSidechain !== true) {
    tail.context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  }
  const key = line.message?.id ?? line.requestId ?? line.uuid;
  if (key) {
    if (tail.seen.has(key)) return false;
    tail.seen.add(key);
    if (tail.seen.size > MAX_SEEN_IDS) tail.seen.delete(tail.seen.values().next().value as string);
  }
  tail.totals.inputTokens += usage.input_tokens ?? 0;
  tail.totals.outputTokens += usage.output_tokens ?? 0;
  tail.totals.cacheRead += usage.cache_read_input_tokens ?? 0;
  tail.totals.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  if (line.message?.model) tail.model = line.message.model;
  return true;
}

/** A denied tool call fires no PostToolUse; its tool_result here is the only word that it is over. */
function noteToolResults(tail: Tail, line: TranscriptLine): void {
  const content = line.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
      activity.toolResult(tail.sessionId, block.tool_use_id);
    }
  }
}

function noteSidechain(tail: Tail, line: TranscriptLine): void {
  if (typeof line.isSidechain !== "boolean") return;
  if (line.isSidechain === tail.inSidechain) return;
  tail.inSidechain = line.isSidechain;
  const event: HenryEvent = {
    id: crypto.randomUUID(),
    sessionId: tail.sessionId,
    ts: Date.now(),
    kind: "transcript",
    payload: { agentId: line.agentId, uuid: line.uuid },
    severity: "info",
    summary: line.isSidechain ? "subagent started" : "subagent finished",
  };
  try {
    db.insertEvent(event);
    broadcast({ type: "event", event });
  } catch (e) {
    console.error("[transcript] event insert failed:", e);
  }
}

sessions.on("exit", (id) => stopTailing(id));
