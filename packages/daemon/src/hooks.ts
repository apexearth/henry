// POST /hook and POST /statusline ingest. Resolves the Henry session (HENRY_SESSION, then
// Claude's session_id, then a new "external" row for sessions started outside Henry), binds
// the two ids, writes HenryEvents, runs rules.classify, broadcasts {type:"event"} / {type:"flag"},
// kicks the overseer, feeds git.noteSessionPath, and drives the transcript tailer. Statusline
// payloads become the 5h/7d Usage snapshot. Neither entry point throws: the HTTP handlers
// must answer fast and Claude Code must never see a failing hook.
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { Flag, HenryEvent, RateWindow, Session, Usage } from "@henry/shared";
import * as activity from "./activity";
import { config } from "./config";
import * as db from "./db";
import * as engagement from "./engagement";
import * as git from "./git";
import * as overseer from "./overseer";
import * as rules from "./rules";
import { broadcast } from "./server";
import { sessions } from "./sessions";
import * as transcript from "./transcript";

export interface IngestResult {
  event?: HenryEvent;
  flag?: Flag;
}

type Dict = Record<string, unknown>;

/** Claude Code hook JSON, loosely typed; every field is optional in practice. */
interface HookPayload extends Dict {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Dict;
  tool_response?: unknown;
  stop_hook_active?: boolean;
  prompt?: string;
  message?: string;
  source?: string;
  reason?: string;
  trigger?: string;
  agent_type?: string;
  agent_id?: string;
}

interface HookBody {
  henrySession?: string;
  henryHookEvent?: string;
  payload?: HookPayload;
}

const isObj = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ---- hooks ----

/** Body of POST /hook: `{ henrySession, henryHookEvent, payload }` where payload is Claude Code's hook JSON. */
export function ingestHook(body: unknown): IngestResult {
  try {
    return ingestHookInner(isObj(body) ? (body as HookBody) : {});
  } catch (e) {
    console.error("[hook] ingest failed:", e);
    return {};
  }
}

function ingestHookInner(body: HookBody): IngestResult {
  const payload: HookPayload = isObj(body.payload) ? (body.payload as HookPayload) : {};
  const hookEvent = str(body.henryHookEvent) ?? str(payload.hook_event_name) ?? "unknown";
  const claudeId = str(payload.session_id);
  const cwd = str(payload.cwd);
  const session = resolveSession(str(body.henrySession), claudeId, cwd);
  if (!session) {
    console.log(`[hook] ${hookEvent} with no session id; dropped`);
    return {};
  }

  const toolName = str(payload.tool_name);
  const event: HenryEvent = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    claudeSessionId: session.claudeSessionId ?? claudeId,
    ts: Date.now(),
    kind: "hook",
    hookEvent,
    toolName,
    cwd: cwd ?? session.cwd,
    payload,
    severity: "info",
    summary: summarize(hookEvent, payload),
  };

  try {
    const cls = rules.classify(event);
    if (cls?.severity) event.severity = cls.severity;
    if (cls?.rule) event.rule = cls.rule;
  } catch (e) {
    console.error("[hook] rules.classify failed:", e);
  }

  db.insertEvent(event);
  broadcast({ type: "event", event });
  activity.note(session.id, hookEvent, payload, event.ts);
  engagement.note(session.id, hookEvent, event.ts);
  const result: IngestResult = { event };

  if (event.severity !== "info") {
    const flag: Flag = {
      id: crypto.randomUUID(),
      eventId: event.id,
      sessionId: session.id,
      ts: event.ts,
      severity: event.severity,
      rule: event.rule ?? event.severity,
      summary: event.summary,
      read: false,
    };
    db.insertFlag(flag);
    broadcast({ type: "flag", flag });
    result.flag = flag;
    if (config.overseer.onFlag) fireAndForget("overseer.onFlag", () => overseer.onFlag(flag));
  }

  // stop_hook_active means Claude is only stopping again because another Stop hook
  // sent it back for more; the turn the user cares about ends with the plain Stop.
  if (hookEvent === "Stop" && config.overseer.onStop && !payload.stop_hook_active) {
    fireAndForget("overseer.onStop", () => overseer.onStop(session.id));
  }

  notePaths(session, event.cwd, payload.tool_input);

  const transcriptPath = str(payload.transcript_path);
  if (hookEvent === "SessionEnd") {
    transcript.stopTailing(session.id);
    if (session.command === "external") sessions.kill(session.id);
    else sessions.claudeEnded(session.id);
  } else if (transcriptPath || session.claudeSessionId) {
    // SessionStart is the designed trigger, but any event will do: the daemon may have
    // started (or `henry install` run) after the session did.
    try {
      transcript.startTailing(session, transcriptPath);
    } catch (e) {
      console.error("[hook] transcript tailing failed:", e);
    }
  }

  return result;
}

/**
 * HENRY_SESSION first (a PTY Henry spawned), then a live session already bound to this
 * Claude session_id, then a new "external" row so sessions started elsewhere (Zed, a plain
 * terminal) show up in the rail too.
 */
function resolveSession(henrySession: string | undefined, claudeId: string | undefined, cwd: string | undefined): Session | undefined {
  if (henrySession) {
    const live = sessions.get(henrySession);
    if (live) {
      if (claudeId) sessions.bindClaudeSession(live.id, claudeId);
      return live;
    }
  }
  if (!claudeId) return undefined;
  const bound = sessions.list().find((s) => s.claudeSessionId === claudeId && s.status === "running");
  if (bound) return bound;
  const row = db.getSessionByClaudeId(claudeId);
  const rowLive = row && sessions.get(row.id);
  if (rowLive && rowLive.status === "running") return rowLive;

  const dir = cwd || homedir();
  const external: Session = {
    id: crypto.randomUUID(),
    claudeSessionId: claudeId,
    cwd: dir,
    title: basename(dir) || dir,
    createdAt: Date.now(),
    status: "running",
    command: "external",
  };
  sessions.registerExternal(external);
  console.log(`[hook] external session ${claudeId.slice(0, 8)} in ${dir} -> ${external.id.slice(0, 8)}`);
  return external;
}

function notePaths(session: Session, cwd: string | undefined, toolInput: unknown): void {
  const base = cwd ?? session.cwd;
  const paths = new Set<string>();
  if (base) paths.add(base);
  if (isObj(toolInput)) {
    for (const key of ["file_path", "path", "notebook_path"]) {
      const p = str(toolInput[key]);
      if (p) paths.add(isAbsolute(p) ? p : resolve(base || homedir(), p));
    }
  }
  for (const p of paths) {
    try {
      git.noteSessionPath(session.id, p);
    } catch (e) {
      console.error("[hook] git.noteSessionPath failed:", e);
    }
  }
}

function fireAndForget(what: string, fn: () => Promise<unknown>): void {
  Promise.resolve()
    .then(fn)
    .catch((e) => console.error(`[hook] ${what} failed:`, e));
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/** Summaries show paths under the cwd relative to it, with forward slashes whatever the OS. */
function relPath(p: string, cwd?: string): string {
  if (cwd && (p.startsWith(cwd + "/") || p.startsWith(cwd + "\\"))) return p.slice(cwd.length + 1).replace(/\\/g, "/");
  return p;
}

/** One line per event, e.g. "Bash: git push origin main", "Edit: packages/x/y.ts", "Prompt: fix the…". */
export function summarize(hookEvent: string, p: HookPayload): string {
  const input = isObj(p.tool_input) ? p.tool_input : {};
  switch (hookEvent) {
    case "PreToolUse":
    case "PostToolUse": {
      const tool = p.tool_name ?? "tool";
      const detail = toolDetail(tool, input, p.cwd);
      const prefix = hookEvent === "PostToolUse" ? (toolFailed(p.tool_response) ? "✗ " : "✓ ") : "";
      return `${prefix}${tool}${detail ? ": " + detail : ""}`;
    }
    case "PermissionRequest": {
      const tool = p.tool_name ?? "tool";
      const detail = toolDetail(tool, input, p.cwd);
      return `Permission? ${tool}${detail ? ": " + detail : ""}`;
    }
    case "UserPromptSubmit":
      return `Prompt: ${clip(p.prompt ?? "", 80)}`;
    case "Stop":
      return p.stop_hook_active ? "Stop (hook active)" : "Stop";
    case "SubagentStop":
      return `Subagent stop${p.agent_type ? ` (${p.agent_type})` : ""}`;
    case "SessionStart":
      return `Session start${p.source ? ` (${p.source})` : ""}`;
    case "SessionEnd":
      return `Session end${p.reason ? ` (${p.reason})` : ""}`;
    case "PreCompact":
      return `Compact${p.trigger ? ` (${p.trigger})` : ""}`;
    case "Notification":
      return `Notification: ${clip(p.message ?? "", 100)}`;
    default:
      return clip(hookEvent, 80);
  }
}

function toolDetail(tool: string, input: Dict, cwd?: string): string {
  const file = str(input.file_path) ?? str(input.notebook_path);
  switch (tool) {
    case "Bash":
      return clip(str(input.command) ?? "", 120);
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "Read":
    case "NotebookEdit":
      return file ? relPath(file, cwd) : "";
    case "Grep":
    case "Glob": {
      const pat = str(input.pattern) ?? "";
      const path = str(input.path);
      return clip(path ? `${pat} in ${relPath(path, cwd)}` : pat, 100);
    }
    case "Agent":
    case "Task":
      return clip(str(input.description) ?? str(input.prompt) ?? "", 80);
    case "WebFetch":
      return clip(str(input.url) ?? "", 100);
    case "WebSearch":
      return clip(str(input.query) ?? "", 100);
    default: {
      if (file) return relPath(file, cwd);
      const keys = Object.keys(input);
      if (!keys.length) return "";
      const first = input[keys[0]];
      return clip(typeof first === "string" ? first : JSON.stringify(input), 80);
    }
  }
}

function toolFailed(response: unknown): boolean {
  if (!isObj(response)) return false;
  return response.is_error === true || (typeof response.error === "string" && response.error.length > 0) || response.success === false;
}

// ---- statusline ----

interface StatuslineBody {
  henrySession?: string;
  payload?: Dict;
}

let loggedShape = false;
const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface StatuslineResult {
  usage: Usage;
  /** What henry-statusline.sh prints for Claude Code to display. */
  text: string;
}

/** Body of POST /statusline: `{ henrySession, payload }`, payload being Claude Code's statusline JSON. */
export function ingestStatusline(body: unknown): StatuslineResult | undefined {
  try {
    return ingestStatuslineInner(isObj(body) ? (body as StatuslineBody) : {});
  } catch (e) {
    console.error("[statusline] ingest failed:", e);
    return undefined;
  }
}

function ingestStatuslineInner(body: StatuslineBody): StatuslineResult {
  const p: Dict = isObj(body.payload) ? body.payload : {};
  if (!loggedShape) {
    loggedShape = true;
    const rl = isObj(p.rate_limits) ? p.rate_limits : undefined;
    console.log(
      `[statusline] first payload keys: ${Object.keys(p).join(",")}` +
        (rl ? ` | rate_limits: ${JSON.stringify(rl)}` : " | no rate_limits") +
        (isObj(p.cost) ? ` | cost keys: ${Object.keys(p.cost).join(",")}` : "") +
        (isObj(p.context_window) ? ` | context_window keys: ${Object.keys(p.context_window).join(",")}` : ""),
    );
  }

  const rl = isObj(p.rate_limits) ? p.rate_limits : undefined;
  const claudeId = str(p.session_id);
  if (!rl && !claudeId) {
    // Not a statusline payload we recognise; do not disturb the stored snapshot.
    return { usage: transcript.currentUsage(), text: "" };
  }
  const fiveHour = parseWindow(rl?.five_hour);
  const sevenDay = parseWindow(rl?.seven_day);
  const previous = db.latestUsageSnapshot<Usage>()?.json;
  const now = Date.now();
  const snapshot: Usage = {
    fiveHour: fiveHour ?? previous?.fiveHour,
    sevenDay: sevenDay ?? previous?.sevenDay,
    perSession: {},
    updatedAt: now,
  };
  db.insertUsageSnapshot(snapshot, now);

  const session = resolveStatuslineSession(str(body.henrySession), claudeId);
  if (session) {
    if (claudeId) sessions.bindClaudeSession(session.id, claudeId);
    activity.seen(session.id, now);
    const model = isObj(p.model) ? (str(p.model.id) ?? str(p.model.display_name)) : undefined;
    const cost = isObj(p.cost) ? num(p.cost.total_cost_usd) : undefined;
    const cw = isObj(p.context_window) ? p.context_window : {};
    transcript.noteStatuslineUsage(session.id, {
      costUsd: cost,
      inputTokens: num(cw.total_input_tokens),
      outputTokens: num(cw.total_output_tokens),
      model,
      contextTokens: contextTokensOf(cw),
      contextWindow: num(cw.context_window_size),
    });
    const transcriptPath = str(p.transcript_path);
    if (transcriptPath || session.claudeSessionId) transcript.startTailing(session, transcriptPath);
  }

  const usage = transcript.currentUsage();
  transcript.scheduleBroadcast(true);
  return { usage, text: statuslineText(usage, session?.id) };
}

/** Live context size: `current_usage` (newer builds) or `used_percentage` of the window. */
function contextTokensOf(cw: Dict): number | undefined {
  const cur = isObj(cw.current_usage) ? cw.current_usage : undefined;
  if (cur) {
    const parts = [num(cur.input_tokens), num(cur.cache_read_input_tokens), num(cur.cache_creation_input_tokens)];
    if (parts.some((n) => n !== undefined)) return parts.reduce<number>((a, n) => a + (n ?? 0), 0);
  }
  const pct = num(cw.used_percentage);
  const size = num(cw.context_window_size);
  if (pct !== undefined && size) return Math.round((pct / 100) * size);
  return undefined;
}

function resolveStatuslineSession(henrySession: string | undefined, claudeId: string | undefined): Session | undefined {
  if (henrySession) {
    const live = sessions.get(henrySession);
    if (live) return live;
  }
  if (!claudeId) return undefined;
  return sessions.list().find((s) => s.claudeSessionId === claudeId && s.status === "running");
}

/**
 * Claude Code 2.1.259 sends `{ used_percentage: 0..100, resets_at: epoch seconds }` per window;
 * older/other builds carry `utilization` as a 0..1 fraction. Accept all of it.
 */
export function parseWindow(w: unknown): RateWindow | undefined {
  if (!isObj(w)) return undefined;
  let util: number | undefined;
  const pct = num(w.used_percentage);
  if (pct !== undefined) util = pct / 100;
  else {
    const u = num(w.utilization);
    if (u !== undefined) util = u > 1 ? u / 100 : u;
  }
  if (util === undefined) return undefined;
  const out: RateWindow = { utilization: Math.max(0, Math.min(1, util)) };
  const resetsAt = parseEpoch(w.resets_at ?? w.resetsAt);
  if (resetsAt) out.resetsAt = resetsAt;
  return out;
}

/** Epoch seconds, epoch ms, or an ISO string -> epoch ms. */
function parseEpoch(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === "string" && v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return parseEpoch(n);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/** The compact line henry-statusline.sh prints for Claude Code: "henry · 5h 42% · 7d 17% · $0.42". */
export function statuslineText(usage: Usage | undefined, sessionId?: string): string {
  if (!usage) return "";
  const parts = ["henry"];
  const win = (label: string, w?: RateWindow) => {
    if (!w) return;
    const pct = Math.round(w.utilization * 100);
    const left = w.resetsAt ? w.resetsAt - Date.now() : 0;
    parts.push(`${label} ${pct}%${left > 0 ? ` ↻${fmtDuration(left)}` : ""}`);
  };
  win("5h", usage.fiveHour);
  win("7d", usage.sevenDay);
  const s = sessionId ? usage.perSession[sessionId] : undefined;
  if (s?.contextTokens !== undefined) parts.push(`ctx ${Math.round((s.contextTokens / (s.contextWindow || DEFAULT_CONTEXT_WINDOW)) * 100)}%`);
  if (s && s.costUsd > 0) parts.push(`$${s.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}

function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? `${h % 24}h` : ""}`;
}
