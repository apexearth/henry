/**
 * MCP over HTTP at `POST /mcp`: JSON-RPC 2.0, five methods, no SDK. One endpoint answering
 * initialize / ping / tools/list / tools/call is not worth a dependency.
 *
 * Two audiences, two tool lists. A tool definition sits in the system prompt of every request
 * of every session that has it, all day, so `?as=session` (what `launch-settings.json` points
 * at) gets exactly one tool and nothing else. The overseer's own client connects without it
 * and may have the wide set, where one process pays the cost once.
 *
 * Read-only on purpose. A session can see what its neighbours are doing; it cannot type into
 * them, and it cannot change Henry's config. The user stays the only one routing between
 * sessions.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ChangedFile, Session } from "@henry/shared";
import { config, expandHome } from "./config";
import * as db from "./db";
import * as git from "./git";
import { sessions } from "./sessions";

// Newest first. Claude Code asks for 2025-11-25; answering with an older one works, since the
// four methods here have not changed across any of these, but echoing the client's version
// keeps the handshake off the fallback path.
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "henry", version: "0.1.0" };

// Output caps. An answer is read by a model mid-task, so it is a dozen lines, not a report.
const MAX_REPOS = 6;
const MAX_FILES_PER_SESSION = 8;
const MAX_UNOWNED = 6;
const MAX_COMMITS = 3;
/** Repeated calls inside one turn (an agent checking each file) reuse one set of git spawns. */
const CACHE_MS = 5_000;

// ---- tools ----

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

const activityTool: ToolDef = {
  name: "henry_activity",
  description:
    "What other Claude Code sessions are doing in a git repo right now: which are live and whether they are working or parked, the files they have uncommitted, commits that landed recently, and uncommitted work no live session owns. Use it before editing files in a repo someone else may also be in, or when a file changed under you.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "Repo name or path. Omit for every repo with a live session." },
    },
  },
  run: (args) => repoActivity(typeof args.repo === "string" ? args.repo : undefined),
};

/** Everything Henry exposes. The chat client gets this list; today it is the session list. */
const ALL_TOOLS: ToolDef[] = [activityTool];
/** What a hosted session gets. Adding to this taxes every request of every session. */
const SESSION_TOOLS: ToolDef[] = [activityTool];

export type Audience = "session" | "full";

function toolsFor(audience: Audience): ToolDef[] {
  return audience === "session" ? SESSION_TOOLS : ALL_TOOLS;
}

// ---- henry_activity ----

const cache = new Map<string, { at: number; text: string }>();

// The live registry, not the DB: `activity` and `lastInputAt` are derived and never persisted,
// and they are the difference between "someone is editing that file" and "someone abandoned it".
let liveSessions = (): Session[] => sessions.list().filter((s) => s.status === "running");

export function setSessionsForTests(fn: (() => Session[]) | null): void {
  liveSessions = fn ?? (() => sessions.list().filter((s) => s.status === "running"));
}

/** Repos a live session is in: the ones it has touched, plus the repo its cwd sits in. */
function reposOfSession(s: Session): string[] {
  const paths = git.getSessionRepos(s.id).map((r) => r.path);
  const cwdRepo = git.resolveRepo(s.cwd);
  if (cwdRepo && !paths.includes(cwdRepo.path)) paths.push(cwdRepo.path);
  return paths;
}

/**
 * A repo name, an absolute path, or nothing. A bare name can match several checkouts (a repo
 * and its worktrees), and all of them are reported: that is exactly the case where two
 * sessions think they are alone.
 */
function targetRepos(repoArg: string | undefined, live: Session[]): string[] {
  const known = new Map<string, string>();
  for (const s of live) {
    for (const path of reposOfSession(s)) {
      const info = git.resolveRepo(path);
      if (info) known.set(info.path, info.name.toLowerCase());
    }
  }
  if (!repoArg) return [...known.keys()].slice(0, MAX_REPOS);

  const direct = git.resolveRepo(expandHome(repoArg));
  if (direct) return [direct.path];
  const wanted = repoArg.toLowerCase();
  const byName = [...known].filter(([, name]) => name === wanted).map(([path]) => path);
  if (byName.length) return byName.slice(0, MAX_REPOS);
  const underRoot = git.resolveRepo(join(config.reposRoot, repoArg));
  return underRoot ? [underRoot.path] : [];
}

/** Tools whose payload names the file they write. A Bash `sed -i` or `>` is not traced. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "str_replace_editor"]);
/** How far back to read a session's events when asking which files it wrote. */
const WRITE_EVENT_LIMIT = 400;

/**
 * Repo-relative paths this session is on record as having written, from the hook stream.
 * `git.changedFiles` cannot answer this: it diffs the repo, so in a repo two sessions share it
 * hands every dirty file to both of them. Bash writes leave no `file_path`, so a file missing
 * here means "not traced", never "nobody touched it" — the caller words it that way.
 */
function writtenPaths(sessionId: string, repoPath: string): Set<string> {
  const out = new Set<string>();
  for (const e of db.listEvents({ sessionId, limit: WRITE_EVENT_LIMIT })) {
    if (!e.toolName || !WRITE_TOOLS.has(e.toolName)) continue;
    const input = (e.payload as { tool_input?: Record<string, unknown> } | null)?.tool_input;
    if (!input) continue;
    for (const key of ["file_path", "notebook_path"]) {
      const v = input[key];
      if (typeof v !== "string" || !v) continue;
      const abs = isAbsolute(v) ? v : resolve(e.cwd ?? repoPath, expandHome(v));
      const rel = git.relIn(repoPath, abs);
      if (rel) out.add(rel);
    }
  }
  return out;
}

const short = (p: string) => (p.startsWith(homedir() + "/") ? "~" + p.slice(homedir().length) : p);

function age(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function activityPhrase(s: Session, now: number): string {
  const since = s.activitySince ? ` ${age(s.activitySince, now)}` : "";
  switch (s.activity) {
    case "working":
      return `working${since}`;
    case "needsInput":
      return `stopped at a permission prompt${since}`;
    case "waiting":
      return `waiting on the human${since}`;
    case "idle":
      return `idle${since}`;
    default:
      return s.kind === "shell" ? "shell" : "no activity yet";
  }
}

function fileLine(f: ChangedFile, now: number): string {
  return `${f.path} (${f.status}${f.mtime ? ", " + age(f.mtime, now) : ""})`;
}

const byMtime = (a: ChangedFile, b: ChangedFile) => (b.mtime ?? 0) - (a.mtime ?? 0);

async function repoBlock(repoPath: string, live: Session[], now: number): Promise<string> {
  const info = git.resolveRepo(repoPath);
  if (!info) return "";
  const here = live.filter((s) => reposOfSession(s).includes(info.path));
  const dirty = await git.dirtyPaths(info.path);
  const dirtySet = new Set(dirty.map((f) => f.path));
  const state = await git.getRepoState(info.path);

  const head = [
    `${info.name} ${short(info.path)}${info.isWorktree ? ` (worktree of ${short(info.worktreeOf ?? "?")})` : ""}`,
    state ? `${state.branch || "detached"}${state.upstream ? `, ${state.ahead} ahead / ${state.behind} behind ${state.upstream}` : ", no upstream"}` : "",
    `${dirty.length} uncommitted`,
  ]
    .filter(Boolean)
    .join(" — ");

  const lines = [head];

  // Who is live here, and which uncommitted files each is on record as having written. A
  // session's committed work is not a collision; the recent-commits line below covers it.
  const traced = new Set<string>();
  if (here.length) {
    lines.push(`live here (${here.length}):`);
    for (const s of here) {
      const written = writtenPaths(s.id, info.path);
      const mine = dirty.filter((f) => written.has(f.path)).sort(byMtime);
      for (const f of mine) traced.add(f.path);
      const committed = git.getSessionRepos(s.id).find((r) => r.path === info.path)?.commitsSinceBaseline ?? 0;
      // cwd only when it is not simply the repo, where it would say nothing.
      const where = s.cwd === info.path ? "" : `, cwd ${short(s.cwd)}`;
      lines.push(`  "${s.title}" ${activityPhrase(s, now)}${where}`);
      if (mine.length) {
        const shown = mine.slice(0, MAX_FILES_PER_SESSION);
        const more = mine.length - shown.length;
        lines.push(`    editing: ${shown.map((f) => fileLine(f, now)).join(", ")}${more > 0 ? `, +${more} more` : ""}`);
      }
      if (committed > 0) lines.push(`    +${committed} commit${committed === 1 ? "" : "s"} since it started`);
    }
  } else {
    lines.push("live here: none");
  }

  const commits = await git.recentCommits(info.path, MAX_COMMITS);
  if (commits.length) {
    lines.push(`recent commits: ${commits.map((c) => `${c.sha} ${age(c.ts, now)} "${c.subject}"`).join("; ")}`);
  }

  // The rest of the dirty tree. Bash writes carry no file path, so this is "not traced to a
  // live session", which covers an exited session, your own editor, and a `sed -i` alike.
  const rest = dirty.filter((f) => !traced.has(f.path)).sort(byMtime);
  if (rest.length) {
    const shown = rest.slice(0, MAX_UNOWNED);
    const more = rest.length - shown.length;
    lines.push(`also uncommitted, not traced to a live session: ${shown.map((f) => fileLine(f, now)).join(", ")}${more > 0 ? `, +${more} more` : ""}`);
  }
  return lines.join("\n");
}

export async function repoActivity(repoArg?: string, now = Date.now()): Promise<string> {
  const key = repoArg ?? "";
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.text;

  const live = liveSessions();
  const targets = targetRepos(repoArg, live);
  let text: string;
  if (!targets.length) {
    text = repoArg
      ? `No repo matching "${repoArg}" under ${config.reposRoot}, and no live session is in one by that name.`
      : "No live session is in a git repo right now.";
  } else {
    const blocks = (await Promise.all(targets.map((p) => repoBlock(p, live, now)))).filter(Boolean);
    text = blocks.join("\n\n") || "Nothing to report.";
  }
  cache.set(key, { at: now, text });
  return text;
}

export function resetCacheForTests(): void {
  cache.clear();
}

// ---- JSON-RPC ----

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const result = (id: RpcRequest["id"], value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function dispatch(msg: RpcRequest, audience: Audience): Promise<object | undefined> {
  // A notification (no id) is answered with nothing, per JSON-RPC.
  if (msg.id === undefined || msg.id === null) return undefined;
  switch (msg.method) {
    case "initialize": {
      const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
      const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return result(msg.id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case "ping":
      return result(msg.id, {});
    case "tools/list":
      return result(msg.id, {
        tools: toolsFor(audience).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = toolsFor(audience).find((t) => t.name === name);
      if (!tool) return failure(msg.id, -32602, `unknown tool: ${name}`);
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return result(msg.id, { content: [{ type: "text", text: await tool.run(args) }] });
      } catch (e) {
        // A tool error is reported in-band so the model can react rather than the turn failing.
        const text = e instanceof Error ? e.message : String(e);
        console.error(`[mcp] ${name} failed:`, text);
        return result(msg.id, { content: [{ type: "text", text: `henry: ${text}` }], isError: true });
      }
    }
    default:
      return failure(msg.id, -32601, `unknown method: ${msg.method}`);
  }
}

/** `POST /mcp` (and `?as=session`). Batches are accepted; an all-notification body gets 202. */
export async function handleMcp(req: Request, url: URL): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!config.mcp.enabled) return new Response("mcp disabled", { status: 404 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(failure(null, -32700, "parse error"), { status: 400 });
  }
  const audience: Audience = url.searchParams.get("as") === "session" ? "session" : "full";
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as RpcRequest[];
  const out: object[] = [];
  for (const m of msgs) {
    const r = await dispatch(m ?? {}, audience);
    if (r) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(batch ? out : out[0]);
}
