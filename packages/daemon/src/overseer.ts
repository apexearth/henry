// Milestone 5: the overseer. It stays at the user's altitude: it reads Henry's event stream
// (one-line tool/prompt summaries), flags, repo-level git summaries and the repo's
// ACTIVE-WORK.md, and never source code or diffs. After each turn (Stop hook, debounced) and on
// every flag it writes a short playbook entry (kind "entry") plus a rolling "right now"
// paragraph (kind "summary") for the session, and, at most every 10 minutes, a global entry
// across all running sessions (sessionId null). Backends: Anthropic API (@anthropic-ai/sdk)
// when a key is available, else headless `claude -p` on the subscription.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Flag, HenryEvent, PlaybookEntry, PlaybookTrigger, RepoState, ServerMessage } from "@henry/shared";
import { config } from "./config";
import * as db from "./db";
import * as git from "./git";
import { resolveClaude, spawnSpec } from "./platform";

// ---- public types ----

export interface BackendRequest {
  /** Stable instructions; identical on every call so the API backend can cache them. */
  system: string;
  /** Volatile context: session, events, flags, repos, ACTIVE-WORK.md, previous entries, trigger. */
  user: string;
  model: string;
}

/** Resolves to the model's text, or undefined when nothing usable came back (e.g. a refusal). */
export type Backend = (req: BackendRequest, signal: AbortSignal) => Promise<string | undefined>;

export type BackendName = "api" | "claude-cli" | "none";

export interface OverseerStatus {
  backend: BackendName;
  model: string;
  lastRunAt?: number;
  lastError?: string;
  /** Runs in flight right now (per-session + global). */
  running: number;
}

// ---- the stable system prompt (first in the request; cache_control on the API backend) ----

export const SYSTEM_PROMPT = `You are the overseer for Henry, a desktop host for Claude Code sessions. You watch from the user's altitude: you are given the event stream (one-line tool and prompt summaries), safeguard flags, repo-level git summaries (branch, upstream, ahead/behind, dirty count, commit subjects since the session's baseline) and the head of the repo's ACTIVE-WORK.md. You never see source code or diffs, so do not guess at implementation details; describe work at the level of files, commands, branches and commits.

Write for the person who owns these sessions and has stepped away, so they can take it in at a glance. Present tense, terse; fragments are fine, no filler, no preamble. Wrap repo, branch, file, command and tool names in backticks. Say what the session is doing, what changed at the repo level (branch, commits, pushes, dirty files), anything the user should be careful about (flags, protected branches, force pushes, cross-repo writes, unpushed or uncommitted work) and what it looks like comes next. If little changed since the previous entry, say so in HEADLINE and keep the rest short. When the trigger is a flag, lead with the flag in HEADLINE and CAREFUL. Write "none" for a section with nothing to say. Never invent activity that is not in the context.

Respond in exactly this shape and nothing else (labels upper-case, one per line, bullets start with "- "):
ENTRY:
HEADLINE: at most 12 words: what this turn did
DOING: one line: the task the session is on
CHANGED:
- one bullet per repo-level change this turn (commits, pushes, branch switches, files created or removed, dirty files), or none
CAREFUL:
- one bullet per thing to check (flags, protected branches, force pushes, cross-repo writes, unpushed or uncommitted work), or none
NEXT: one line: what looks like it comes next
NOW:
HEADLINE: at most 12 words: the session as a whole right now
DOING: one line
REPOS:
- one bullet per repo: branch, ahead/behind, dirty count, unpushed commits
CAREFUL:
- bullets, or none
NEXT: one line

For a manual question, ENTRY is instead "HEADLINE:" (the question in a few words) and "ANSWER:" (2 to 5 sentences), and NOW keeps its shape above. For the global playbook (all sessions), DOING, CHANGED and REPOS hold one bullet per running session, each starting with the session title in backticks, and HEADLINE and NEXT span all of them.`;

// ---- module state ----

const GLOBAL = "global";
const MAX_EVENTS = 40;
const ACTIVE_WORK_LINES = 80;
const ACTIVE_WORK_CHARS = 4_000;

interface RunRequest {
  trigger: PlaybookTrigger;
  flag?: Flag;
  prompt?: string;
}

interface Deferred {
  promise: Promise<PlaybookEntry | undefined>;
  resolve: (e?: PlaybookEntry) => void;
}

const timing = {
  stopDebounceMs: 5_000,
  /** Floor between two Stop-triggered runs for one session; config.overseer.stopMinIntervalSec overrides. */
  stopMinIntervalMs: 60_000,
  globalIntervalMs: 10 * 60_000,
  timeoutMs: 120_000,
  promptChars: 22_000 /* ~6k tokens */,
};
const lastRunFor = new Map<string, number>();
const running = new Set<string>();
const queue = new Map<string, { req: RunRequest; d: Deferred }[]>();
const stopTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; d: Deferred }>();
let lastGlobalAt = 0;
let lastRunAt: number | undefined;
let lastError: string | undefined;
let testBackend: Backend | null = null;
let apiClient: import("@anthropic-ai/sdk").default | undefined;

interface GitApi {
  getSessionRepos?: (sessionId: string) => RepoState[];
  logSinceBaseline?: (sessionId: string, repoPath: string) => unknown;
}
let gitApi: GitApi = git as unknown as GitApi;

type Emit = (msg: ServerMessage) => void;
const defaultEmit: Emit = (msg) => {
  // server.ts imports this module; a dynamic import keeps tests free of the server.
  void import("./server").then((s) => s.broadcast(msg)).catch(() => {});
};
let emit: Emit = defaultEmit;

function deferred(): Deferred {
  let resolve!: Deferred["resolve"];
  const promise = new Promise<PlaybookEntry | undefined>((r) => (resolve = r));
  return { promise, resolve };
}

// ---- backend selection ----

function resolveApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || config.overseer.apiKey || undefined;
}

function resolveBackend(): { name: BackendName; why: string } {
  const want = config.overseer.backend;
  const key = !!resolveApiKey();
  const cli = !!Bun.which("claude");
  if (want === "api") return key ? { name: "api", why: "config" } : { name: "none", why: "backend=api but no ANTHROPIC_API_KEY / overseer.apiKey" };
  if (want === "claude-cli") return cli ? { name: "claude-cli", why: "config" } : { name: "none", why: "backend=claude-cli but `claude` is not on PATH" };
  if (key) return { name: "api", why: "auto: API key present" };
  if (cli) return { name: "claude-cli", why: "auto: no API key, `claude` on PATH" };
  return { name: "none", why: "auto: no API key and no `claude` on PATH" };
}

const chosen = resolveBackend();
console.log(`[overseer] backend: ${chosen.name} (${chosen.why}); model ${config.overseer.model}`);
if (chosen.name === "none") lastError = chosen.why;

function currentBackend(): Backend | undefined {
  if (testBackend) return testBackend;
  if (chosen.name === "api") return apiBackend;
  if (chosen.name === "claude-cli") return claudeCliBackend;
  return undefined;
}

// ---- test hooks ----

export function setBackendForTests(fn: Backend | null): void {
  testBackend = fn;
}
export function setBroadcastForTests(fn: Emit | null): void {
  emit = fn ?? defaultEmit;
}
export function setGitForTests(g: GitApi | null): void {
  gitApi = g ?? (git as unknown as GitApi);
}
export function setTimingForTests(t: Partial<typeof timing>): void {
  Object.assign(timing, t);
}
export function resetForTests(): void {
  lastGlobalAt = 0;
  lastError = undefined;
  lastRunAt = undefined;
  lastRunFor.clear();
  for (const { timer } of stopTimers.values()) clearTimeout(timer);
  stopTimers.clear();
  queue.clear();
}
/** Resolves once no run is in flight or queued and no Stop debounce is pending. */
export async function idle(): Promise<void> {
  while (running.size || queue.size || stopTimers.size) await Bun.sleep(5);
}

// ---- public API ----

export function overseerStatus(): OverseerStatus {
  return { backend: chosen.name, model: config.overseer.model, lastRunAt, lastError, running: running.size };
}

/** Stop hook: debounced 5s per session, coalesced with anything else that arrives meanwhile. */
export function onStop(sessionId: string): Promise<PlaybookEntry | undefined> {
  if (!config.overseer.onStop) return Promise.resolve(undefined);
  const existing = stopTimers.get(sessionId);
  if (existing) clearTimeout(existing.timer);
  const d = existing?.d ?? deferred();
  // Debounce, then hold off until the per-session floor since the last run has passed;
  // Stops that land in the meantime just move this one timer.
  const minInterval = (config.overseer.stopMinIntervalSec ?? timing.stopMinIntervalMs / 1000) * 1000;
  const notBefore = (lastRunFor.get(sessionId) ?? 0) + minInterval;
  const delay = Math.max(timing.stopDebounceMs, notBefore - Date.now());
  const timer = setTimeout(() => {
    stopTimers.delete(sessionId);
    enqueue(sessionId, { trigger: "stop" }).then(d.resolve, () => d.resolve(undefined));
  }, delay);
  stopTimers.set(sessionId, { timer, d });
  return d.promise;
}

/** A notable/alarm flag: runs right away (a pending Stop for the session folds into it). */
export function onFlag(flag: Flag): Promise<PlaybookEntry | undefined> {
  if (!config.overseer.onFlag) return Promise.resolve(undefined);
  const pending = stopTimers.get(flag.sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    stopTimers.delete(flag.sessionId);
  }
  const p = enqueue(flag.sessionId, { trigger: "flag", flag });
  if (pending) p.then(pending.d.resolve, () => pending.d.resolve(undefined));
  return p;
}

/** A question from the UI; sessionId null asks about all sessions. */
export function writeManual(sessionId: string | null, prompt: string): Promise<PlaybookEntry | undefined> {
  return enqueue(sessionId ?? GLOBAL, { trigger: "manual", prompt });
}

/** Newest "right now" paragraph for a session (null = global). */
export function latestSummary(sessionId: string | null): PlaybookEntry | undefined {
  return db.listPlaybook(sessionId, 50).find((p) => p.kind === "summary");
}

// ---- scheduling: one run per key at a time, later triggers coalesce into one follow-up ----

function mergeRequests(a: RunRequest, b: RunRequest): RunRequest {
  const flag = b.flag ?? a.flag;
  return flag ? { trigger: "flag", flag } : a;
}

function enqueue(key: string, req: RunRequest): Promise<PlaybookEntry | undefined> {
  if (!running.has(key)) return execute(key, req);
  const q = queue.get(key) ?? [];
  const mergeable = req.trigger !== "manual" ? q.find((x) => x.req.trigger !== "manual") : undefined;
  if (mergeable) {
    mergeable.req = mergeRequests(mergeable.req, req);
    return mergeable.d.promise;
  }
  const d = deferred();
  q.push({ req, d });
  queue.set(key, q);
  return d.promise;
}

async function execute(key: string, req: RunRequest): Promise<PlaybookEntry | undefined> {
  running.add(key);
  let entry: PlaybookEntry | undefined;
  try {
    if (req.trigger !== "manual") lastRunFor.set(key, Date.now());
    entry = await runOnce(key, req);
  } catch (e) {
    recordError(e);
  } finally {
    running.delete(key);
    const q = queue.get(key);
    const next = q?.shift();
    if (q && !q.length) queue.delete(key);
    if (next) void execute(key, next.req).then(next.d.resolve, () => next.d.resolve(undefined));
  }
  return entry;
}

function recordError(e: unknown): void {
  lastError = e instanceof Error ? e.message : String(e);
  console.error("[overseer]", lastError);
}

async function runOnce(key: string, req: RunRequest): Promise<PlaybookEntry | undefined> {
  const sessionId = key === GLOBAL ? null : key;
  const backend = currentBackend();
  if (!backend) {
    lastError = chosen.why;
    return undefined;
  }
  const user = sessionId ? await buildSessionPrompt(sessionId, req) : buildGlobalPrompt(req);
  if (!user) return undefined;
  const model = config.overseer.model;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timing.timeoutMs);
  let text: string | undefined;
  try {
    text = await backend({ system: SYSTEM_PROMPT, user, model }, ctrl.signal);
  } catch (e) {
    recordError(e);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
  lastRunAt = Date.now();
  if (!text?.trim()) return undefined;

  const { entry, summary } = parseResponse(text);
  const ts = Date.now();
  const e: PlaybookEntry = { id: crypto.randomUUID(), sessionId, ts, text: entry, trigger: req.trigger, model, kind: "entry" };
  db.insertPlaybook(e);
  emit({ type: "playbook:update", entry: e });
  if (summary) {
    const s: PlaybookEntry = { id: crypto.randomUUID(), sessionId, ts: ts + 1, text: summary, trigger: req.trigger, model, kind: "summary" };
    db.insertPlaybook(s);
    emit({ type: "playbook:update", entry: s });
  }
  lastError = undefined;
  if (sessionId) maybeGlobal(req.trigger);
  return e;
}

function maybeGlobal(trigger: PlaybookTrigger): void {
  if (Date.now() - lastGlobalAt < timing.globalIntervalMs) return;
  if (running.has(GLOBAL) || queue.has(GLOBAL)) return;
  if (!db.listSessions({ status: "running" }).length) return;
  lastGlobalAt = Date.now();
  void enqueue(GLOBAL, { trigger });
}

export function parseResponse(text: string): { entry: string; summary?: string } {
  const m = /^\s*ENTRY:\s*([\s\S]*?)\n\s*NOW:\s*([\s\S]*)$/.exec(text);
  const clean = (s: string) => s.replace(/\n{3,}/g, "\n\n").trim();
  if (m) return { entry: clean(m[1]), summary: clean(m[2]) || undefined };
  return { entry: clean(text.replace(/^\s*ENTRY:\s*/, "")) };
}

// ---- prompt assembly (summaries only; no payloads, no file contents other than ACTIVE-WORK.md) ----

const hhmm = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit" });
const hhmmss = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

function eventLine(e: HenryEvent): string {
  const what = [e.hookEvent ?? e.kind, e.toolName].filter(Boolean).join(" ");
  const sev = e.severity !== "info" ? ` [${e.severity}${e.rule ? ": " + e.rule : ""}]` : "";
  return `${hhmmss(e.ts)}  ${what}${sev}: ${oneLine(e.summary, 200)}`;
}

function flagLine(f: Flag): string {
  return `- [${f.severity}] ${hhmm(f.ts)} ${f.rule}: ${oneLine(f.summary, 200)}${f.read ? " (seen)" : ""}`;
}

function triggerLine(req: RunRequest): string {
  if (req.trigger === "flag" && req.flag) return `Trigger: flag raised — [${req.flag.severity}] ${req.flag.rule}: ${oneLine(req.flag.summary, 300)}`;
  if (req.trigger === "manual") return `Trigger: the user asks: ${oneLine(req.prompt ?? "", 1000)}`;
  return "Trigger: the session finished a turn (Stop hook).";
}

function safeRepos(sessionId: string): RepoState[] {
  try {
    return typeof gitApi.getSessionRepos === "function" ? gitApi.getSessionRepos(sessionId) ?? [] : [];
  } catch {
    return [];
  }
}

function commitSubjects(v: unknown): string[] {
  // git.ts returns { baseline, commits: LogEntry[] }; also accept a bare array or newline-separated text.
  if (v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as { commits?: unknown }).commits)) return commitSubjects((v as { commits: unknown }).commits);
  if (typeof v === "string") return v.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    if (typeof x === "string") return x;
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      return String(o.subject ?? o.message ?? o.title ?? JSON.stringify(o));
    }
    return String(x);
  });
}

async function repoSummary(sessionId: string, r: RepoState): Promise<string> {
  const parts = [
    `branch ${r.branch || "(detached)"}`,
    r.upstream ? `upstream ${r.upstream}, ahead ${r.ahead} / behind ${r.behind}` : "no upstream",
    `${r.dirty} dirty path${r.dirty === 1 ? "" : "s"}`,
    `${r.commitsSinceBaseline} commit${r.commitsSinceBaseline === 1 ? "" : "s"} since session baseline${r.baseline ? " " + r.baseline.slice(0, 7) : ""}`,
  ];
  if (r.isWorktree) parts.push(`worktree${r.worktreeOf ? " of " + r.worktreeOf : ""}`);
  let line = `- ${r.name} (${r.path}): ${parts.join(", ")}`;
  if (r.commitsSinceBaseline > 0 && typeof gitApi.logSinceBaseline === "function") {
    try {
      const subjects = commitSubjects(await gitApi.logSinceBaseline(sessionId, r.path)).slice(0, 10);
      if (subjects.length) line += `\n    commits since baseline: ${subjects.map((s) => `"${oneLine(s, 100)}"`).join("; ")}`;
    } catch {
      // git summary is optional
    }
  }
  return line;
}

function repoRootOf(dir: string): string | undefined {
  let d = dir;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(d, ".git"))) return d;
    const parent = dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
  return undefined;
}

function readActiveWork(cwd: string, repoPaths: string[]): { path: string; text: string } | undefined {
  const candidates = [...new Set([cwd, repoRootOf(cwd), ...repoPaths].filter((p): p is string => !!p))];
  for (const dir of candidates) {
    const path = join(dir, "ACTIVE-WORK.md");
    if (!existsSync(path)) continue;
    try {
      const lines = readFileSync(path, "utf8").split("\n");
      let text = lines.slice(0, ACTIVE_WORK_LINES).join("\n");
      if (text.length > ACTIVE_WORK_CHARS) text = text.slice(0, ACTIVE_WORK_CHARS) + "\n…";
      else if (lines.length > ACTIVE_WORK_LINES) text += "\n…";
      return { path, text };
    } catch {
      // unreadable; try the next candidate
    }
  }
  return undefined;
}

function previousEntries(sessionId: string | null): string {
  const prev = db.listPlaybook(sessionId, 12).filter((p) => p.kind !== "summary").slice(0, 3);
  if (!prev.length) return "(none yet)";
  return prev.map((p) => `- ${hhmm(p.ts)} (${p.trigger}): ${oneLine(p.text, 600)}`).join("\n");
}

async function buildSessionPrompt(sessionId: string, req: RunRequest): Promise<string | undefined> {
  const session = db.getSession(sessionId);
  if (!session) return undefined;
  const events = db.listEvents({ sessionId, limit: MAX_EVENTS }); // newest first
  const flags = db.listFlags({ sessionId, limit: 20 });
  const repos = safeRepos(sessionId);
  const repoLines = await Promise.all(repos.map((r) => repoSummary(sessionId, r)));
  const activeWork = readActiveWork(session.cwd, repos.map((r) => r.path));
  const summary = latestSummary(sessionId);

  const head = [
    triggerLine(req),
    `Session: "${session.title}" — cwd ${session.cwd} — ${session.status}${session.exitCode != null ? " (exit " + session.exitCode + ")" : ""} — started ${hhmm(session.createdAt)} — now ${hhmm(Date.now())}`,
    "",
    `Flags (${flags.length}${flags.length ? ", " + flags.filter((f) => !f.read).length + " unread" : ""}):`,
    flags.length ? flags.map(flagLine).join("\n") : "(none)",
    "",
    "Repos touched by this session:",
    repoLines.length ? repoLines.join("\n") : "(none recorded yet)",
    "",
    activeWork ? `ACTIVE-WORK.md (first ${ACTIVE_WORK_LINES} lines of ${activeWork.path}):\n${activeWork.text}` : "ACTIVE-WORK.md: none found",
    "",
    "Previous playbook entries (newest first):",
    previousEntries(sessionId),
    "",
    `Previous "right now" summary: ${summary ? oneLine(summary.text, 800) : "(none yet)"}`,
    "",
  ].join("\n");

  // Events fill whatever budget is left, newest first, then shown oldest first.
  const budget = timing.promptChars - head.length - 200;
  const kept: string[] = [];
  let used = 0;
  for (const e of events) {
    const line = eventLine(e);
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  kept.reverse();
  const label = `Recent events (oldest first; ${kept.length} of the last ${events.length}):`;
  return head + label + "\n" + (kept.length ? kept.join("\n") : "(no events recorded yet)");
}

function buildGlobalPrompt(req: RunRequest): string {
  const sessions = db.listSessions({ status: "running" }).slice(0, 8);
  const blocks = sessions.map((s) => {
    const flags = db.listFlags({ sessionId: s.id, limit: 50 });
    const unread = flags.filter((f) => !f.read);
    const repos = safeRepos(s.id)
      .map((r) => `${r.name}@${r.branch || "detached"}${r.upstream ? ` ↑${r.ahead}↓${r.behind}` : " (no upstream)"}, ${r.dirty} dirty, +${r.commitsSinceBaseline} commits`)
      .join("; ");
    const summary = latestSummary(s.id);
    const last = db.listPlaybook(s.id, 12).filter((p) => p.kind !== "summary").slice(0, 2);
    return [
      `## "${s.title}" — cwd ${s.cwd} — since ${hhmm(s.createdAt)}`,
      `right now: ${summary ? oneLine(summary.text, 700) : "(no summary yet)"}`,
      last.length ? `latest entries: ${last.map((p) => `[${hhmm(p.ts)} ${p.trigger}] ${oneLine(p.text, 400)}`).join(" | ")}` : "latest entries: (none)",
      `flags: ${flags.length} total, ${unread.length} unread${unread.length ? " — " + unread.slice(0, 3).map((f) => `[${f.severity}] ${oneLine(f.summary, 120)}`).join("; ") : ""}`,
      `repos: ${repos || "(none recorded)"}`,
    ].join("\n");
  });
  return [
    triggerLine(req),
    `Scope: the global playbook across all running sessions — now ${hhmm(Date.now())}`,
    "",
    `Running sessions (${sessions.length}):`,
    blocks.length ? blocks.join("\n\n") : "(none)",
    "",
    "Previous global entries (newest first):",
    previousEntries(null),
    "",
    `Previous global "right now" summary: ${(() => { const s = latestSummary(null); return s ? oneLine(s.text, 800) : "(none yet)"; })()}`,
  ].join("\n");
}

// ---- backends ----

/** Anthropic API via @anthropic-ai/sdk: streaming, adaptive thinking at low effort, default server-side fallback. */
async function apiBackend(req: BackendRequest, signal: AbortSignal): Promise<string | undefined> {
  if (!apiClient) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    apiClient = new Anthropic({ apiKey: resolveApiKey() });
  }
  const stream = apiClient.beta.messages.stream(
    {
      model: req.model,
      max_tokens: 2048,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.user }],
    },
    { signal },
  );
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") {
    console.warn("[overseer] api backend refused; writing nothing", msg.stop_details ?? "");
    return undefined;
  }
  if (msg.stop_reason === "max_tokens") console.warn("[overseer] api backend hit max_tokens; using partial text");
  const text = msg.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return text || undefined;
}

let neutralDir: string | undefined;
function getNeutralDir(): string {
  if (!neutralDir) {
    neutralDir = join(tmpdir(), "henry-overseer");
    mkdirSync(neutralDir, { recursive: true });
  }
  return neutralDir;
}

/**
 * Headless `claude -p` on the subscription. --safe-mode drops hooks, CLAUDE.md, MCP and other
 * customisation (auth still works), --tools "" removes every tool, --no-session-persistence
 * keeps it out of ~/.claude/projects. cwd is a neutral temp dir, HENRY_SESSION/HENRY_PORT are
 * stripped so nothing loops back into Henry, and HENRY_OVERSEER=1 marks the process.
 */
async function claudeCliBackend(req: BackendRequest, signal: AbortSignal): Promise<string | undefined> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.HENRY_SESSION;
  delete env.HENRY_PORT;
  delete env.CLAUDECODE;
  env.HENRY_OVERSEER = "1";
  const args = [
    "-p", "--safe-mode", "--tools", "", "--no-session-persistence", "--output-format", "text",
    "--model", req.model, "--effort", "low", "--system-prompt", req.system,
  ];
  const spec = spawnSpec(resolveClaude(), args);
  const proc = Bun.spawn([spec.command, ...spec.args], { cwd: getNeutralDir(), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const onAbort = () => proc.kill();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    proc.stdin.write(req.user);
    await proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (signal.aborted) throw new Error(`claude -p timed out after ${timing.timeoutMs / 1000}s`);
    if (code !== 0) throw new Error(`claude -p exited ${code}: ${oneLine(stderr || stdout, 300)}`);
    const text = stdout.trim();
    return text || undefined;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
