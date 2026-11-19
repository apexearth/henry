// The model Henry asks on its own behalf: voice answers, spoken notices, PR summaries, and the
// session summaries they read. It stays at the user's altitude: event lines, flags and
// repo-level git state, never source code or diffs. Backends: Anthropic API (@anthropic-ai/sdk)
// when a key is available, else headless `claude -p` on the subscription.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HenryEvent, RepoState, Session } from "@henry/shared";
import { config } from "./config";
import * as db from "./db";
import * as git from "./git";
import { resolveClaude, spawnSpec } from "./platform";

export interface BackendRequest {
  /** Stable instructions; identical on every call so the API backend can cache them. */
  system: string;
  /** Volatile context. */
  user: string;
  model: string;
}

/** Resolves to the model's text, or undefined when nothing usable came back (e.g. a refusal). */
export type Backend = (req: BackendRequest, signal: AbortSignal) => Promise<string | undefined>;

export type BackendName = "api" | "claude-cli" | "none";

let apiClient: import("@anthropic-ai/sdk").default | undefined;

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
console.log(`[henry] model backend: ${chosen.name} (${chosen.why}); model ${config.overseer.model}`);

function currentBackend(): Backend | undefined {
  if (chosen.name === "api") return apiBackend;
  if (chosen.name === "claude-cli") return claudeCliBackend;
  return undefined;
}

// ---- shared with voice.ts ----

/**
 * Running sessions, most recently active first.
 *
 * "Running" only says a PTY is alive: on a machine carrying dozens of them (29 here on
 * 2026-09-14, of which three had seen an event that day) creation order fills a capped list
 * with whatever was opened last rather than whatever is being worked in. Every caller that
 * takes the first N must use this one, or two parts of the same prompt end up describing
 * different sets of sessions.
 */
export function liveSessions(limit: number): Session[] {
  const seen = db.lastEventTimes();
  return db
    .listSessions({ status: "running" })
    .sort((a, b) => (seen.get(b.id) ?? b.createdAt) - (seen.get(a.id) ?? a.createdAt))
    .slice(0, limit);
}

export { eventLine, oneLine, safeRepos };

/** One prompt through whichever backend was chosen, on the configured model unless the caller
 * names a cheaper one. Throws when there is none. */
export function askBackend(system: string, user: string, signal: AbortSignal, model = config.overseer.model): Promise<string | undefined> {
  const backend = currentBackend();
  if (!backend) throw new Error(chosen.why);
  return backend({ system, user, model }, signal);
}

// ---- summaries (no payloads, no file contents) ----

const hhmm = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit" });
const hhmmss = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

function eventLine(e: HenryEvent, max = 200): string {
  const what = [e.hookEvent ?? e.kind, e.toolName].filter(Boolean).join(" ");
  const sev = e.severity !== "info" ? ` [${e.severity}${e.rule ? ": " + e.rule : ""}]` : "";
  return `${hhmmss(e.ts)}  ${what}${sev}: ${oneLine(e.summary, max)}`;
}

function safeRepos(sessionId: string): RepoState[] {
  try {
    return git.getSessionRepos(sessionId);
  } catch {
    return [];
  }
}

/** One session's flags and repos. No header — the caller knows where the session is (voice.ts
 * adds the machine for a peer's). */
export function sessionDetail(sessionId: string): string {
  const flags = db.listFlags({ sessionId, limit: 50 });
  const unread = flags.filter((f) => !f.read);
  const repos = safeRepos(sessionId)
    .map((r) => `${r.name}@${r.branch || "detached"}${r.upstream ? ` ↑${r.ahead}↓${r.behind}` : " (no upstream)"}, ${r.dirty} dirty, +${r.commitsSinceBaseline} commits`)
    .join("; ");
  return [
    `flags: ${flags.length} total, ${unread.length} unread${unread.length ? " — " + unread.slice(0, 3).map((f) => `[${f.severity}] ${oneLine(f.summary, 120)}`).join("; ") : ""}`,
    `repos: ${repos || "(none recorded)"}`,
  ].join("\n");
}

export const sessionHeader = (s: Session, where?: string) => `## "${s.title}"${where ? ` — ${where}` : ""} — cwd ${s.cwd} — since ${hhmm(s.createdAt)}`;

// ---- backends ----

/** Anthropic API via @anthropic-ai/sdk: streaming, adaptive thinking at low effort, default server-side fallback. */
async function apiBackend(req: BackendRequest, signal: AbortSignal): Promise<string | undefined> {
  if (!apiClient) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    apiClient = new Anthropic({ apiKey: resolveApiKey() });
  }
  // Haiku has no server-side refusal fallback; asking for one there is a 400.
  const fallback = /haiku/i.test(req.model) ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };
  const stream = apiClient.beta.messages.stream(
    {
      model: req.model,
      max_tokens: 2048,
      ...fallback,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.user }],
    },
    { signal },
  );
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") {
    console.warn("[henry] api backend refused; writing nothing", msg.stop_details ?? "");
    return undefined;
  }
  if (msg.stop_reason === "max_tokens") console.warn("[henry] api backend hit max_tokens; using partial text");
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
    if (signal.aborted) throw new Error("claude -p timed out");
    if (code !== 0) throw new Error(`claude -p exited ${code}: ${oneLine(stderr || stdout, 300)}`);
    const text = stdout.trim();
    return text || undefined;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
