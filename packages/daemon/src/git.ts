// Milestone 3: repo discovery incl. worktrees, per-session baselines (db.upsertBaseline),
// status/ahead/behind, diff vs baseline, watch+poll, broadcast {type:"repos:update"}.
//
// Shape: every repo any session has touched gets a RepoInfo (static: paths, worktree-ness)
// and a cached RepoBase (dynamic: branch/head/ahead/behind/dirty). Per-session fields
// (baseline, commitsSinceBaseline) are layered on in getSessionRepos(). All git work is
// `git` child processes; nothing here links libgit2.
//
// Broadcasting goes through an injected function (setBroadcast) so this module can be
// imported by tests without starting the server. server.ts wires it in startServer().
import { existsSync, readFileSync, readdirSync, statSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ChangedFile, FileDiff, HenryEvent, RepoPickerEntry, RepoState, ServerMessage, SessionFiles } from "@henry/shared";
import * as db from "./db";
import { isWindows } from "./platform";
import * as rules from "./rules";

// ---- constants ----

const STATE_TTL_MS = 2000;
const DEBOUNCE_MS = 300;
const POLL_MS = 10_000;
const DIFF_CAP_BYTES = 2 * 1024 * 1024;

// ---- types ----

/** Static facts about a checkout. `path` is the working tree root (realpath). */
export interface RepoInfo {
  path: string;
  name: string;
  /** Per-checkout git dir: `<path>/.git` or `<main>/.git/worktrees/<name>`. */
  gitDir: string;
  /** Shared git dir (`<main>/.git`); equals gitDir for a main checkout. */
  commonDir: string;
  isWorktree: boolean;
  worktreeOf?: string;
}

/** Session-independent live state. */
interface RepoBase {
  branch: string;
  head: string;
  upstream?: string;
  remoteUrl?: string;
  ahead: number;
  behind: number;
  dirty: number;
  lastCommitAt?: number;
  /** Subject of HEAD, kept for event summaries. */
  subject?: string;
  at: number;
}

export interface LogEntry {
  sha: string;
  ts: number;
  subject: string;
}

/** One row of `git log --graph`: the ASCII graph column plus the commit on it, if any. */
export interface GraphLine {
  graph: string;
  sha?: string;
  /** Decorations as git prints them: "HEAD -> main, origin/main, tag: v1". */
  refs?: string;
  subject?: string;
  ts?: number;
  author?: string;
}

// ---- module state ----

let emit: (msg: ServerMessage) => void = () => {};
/** server.ts injects its broadcast; tests inject a collector. */
export function setBroadcast(fn: (msg: ServerMessage) => void): void {
  emit = fn;
}

const dirCache = new Map<string, RepoInfo>();
/** Dirs known to be outside any repo, with the time we looked (a later `git init` must show up). */
const negCache = new Map<string, number>();
const NEG_TTL_MS = 30_000;
const repos = new Map<string, RepoInfo>();
const bases = new Map<string, RepoBase>();
const inflight = new Map<string, Promise<RepoBase | undefined>>();
const sessionRepos = new Map<string, Set<string>>();
const repoSessions = new Map<string, Set<string>>();
/** `${repo}\0${baseline}\0${head}` → commits since baseline. Immutable per key. */
const sinceCache = new Map<string, number>();
/** commonDir → known worktree paths (for "new worktree" events). */
const knownWorktrees = new Map<string, Set<string>>();
const watchers = new Map<string, FSWatcher[]>();
const debounces = new Map<string, ReturnType<typeof setTimeout>>();
let poll: ReturnType<typeof setInterval> | undefined;
let started = false;

// ---- git process helper ----

interface RunResult {
  code: number;
  out: string;
  err: string;
}

const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };

async function run(cwd: string, args: string[], opts: { maxBytes?: number } = {}): Promise<RunResult> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, env: gitEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([readCapped(proc.stdout, opts.maxBytes), new Response(proc.stderr).text(), proc.exited]);
    return { code, out, err };
  } catch (e) {
    return { code: 127, out: "", err: (e as Error).message };
  }
}

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes?: number): Promise<string> {
  if (!maxBytes) return new Response(stream).text();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (total < maxBytes) {
      chunks.push(value);
      total += value.byteLength;
    }
    // Keep draining past the cap so git does not block on a full pipe.
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

const short = (sha: string) => sha.slice(0, 7);

// ---- repo resolution ----

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Build RepoInfo for a working tree whose `.git` (dir or file) is at `gitEntry`. */
function infoFromGitEntry(root: string, gitEntry: string): RepoInfo | null {
  try {
    const st = statSync(gitEntry);
    if (st.isDirectory()) {
      return { path: root, name: basename(root), gitDir: gitEntry, commonDir: gitEntry, isWorktree: false };
    }
    const text = readFileSync(gitEntry, "utf8");
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!m) return null;
    const gitDir = safeReal(isAbsolute(m[1]) ? m[1] : resolve(root, m[1]));
    const commondirFile = join(gitDir, "commondir");
    if (existsSync(commondirFile)) {
      const rel = readFileSync(commondirFile, "utf8").trim();
      const commonDir = safeReal(isAbsolute(rel) ? rel : resolve(gitDir, rel));
      const worktreeOf = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
      return { path: root, name: basename(root), gitDir, commonDir, isWorktree: true, worktreeOf };
    }
    // A `.git` file without commondir is a submodule checkout: its own repo, not a worktree.
    return { path: root, name: basename(root), gitDir, commonDir: gitDir, isWorktree: false };
  } catch {
    return null;
  }
}

/**
 * `abs` inside the checkout at `root`, in git's own form (forward slashes), or undefined when
 * it lies outside. Separators and (on Windows) letter case are normalised first, since paths
 * reach here from hooks, the UI and git itself in whatever shape each of them uses.
 */
export function relIn(root: string, abs: string): string | undefined {
  const a = resolve(abs);
  const head = a.slice(0, root.length);
  const same = isWindows ? head.toLowerCase() === root.toLowerCase() : head === root;
  if (!same || a.length <= root.length || (a[root.length] !== sep && a[root.length] !== "/")) return undefined;
  return a.slice(root.length + 1).split(sep).join("/");
}

/** Walk up from `absPath` to the nearest checkout. Cached per directory. */
export function resolveRepo(absPath: string): RepoInfo | undefined {
  if (!absPath || !isAbsolute(absPath)) return undefined;
  let dir = isDir(absPath) ? absPath : dirname(absPath);
  const visited: string[] = [];
  let found: RepoInfo | null = null;
  const now = Date.now();
  while (true) {
    const cached = dirCache.get(dir);
    if (cached) {
      found = cached;
      break;
    }
    const neg = negCache.get(dir);
    if (neg !== undefined && now - neg < NEG_TTL_MS) break;
    visited.push(dir);
    const gitEntry = join(dir, ".git");
    if (existsSync(gitEntry)) {
      const real = safeReal(dir);
      found = repos.get(real) ?? infoFromGitEntry(real, join(real, ".git"));
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of visited) {
    if (found) dirCache.set(d, found);
    else negCache.set(d, now);
  }
  if (found && !repos.has(found.path)) repos.set(found.path, found);
  return found ?? undefined;
}

/** Sync branch name from the HEAD file; used before any git process has run. */
function readHeadBranch(info: RepoInfo): string {
  try {
    const head = readFileSync(join(info.gitDir, "HEAD"), "utf8").trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : "(detached)";
  } catch {
    return "";
  }
}

/**
 * For rules.ts: which repo (and branch) does this path belong to right now?
 * Sync and cheap: cached state when we have it, else the HEAD file.
 */
export function repoForPath(absPath: string): { path: string; branch: string; isWorktree: boolean; worktreeOf?: string } | undefined {
  const info = resolveRepo(absPath);
  if (!info) return undefined;
  const base = bases.get(info.path);
  const branch = base && Date.now() - base.at < STATE_TTL_MS ? base.branch : readHeadBranch(info);
  return { path: info.path, branch, isWorktree: info.isWorktree, worktreeOf: info.worktreeOf };
}

// ---- discovery (new-tab picker) ----

interface WorktreeEntry {
  path: string;
  branch?: string;
  /** Neither a branch nor `detached`: `git worktree add` has registered it but not yet written its HEAD. */
  settling?: boolean;
}

async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  const { code, out } = await run(repoPath, ["worktree", "list", "--porcelain"]);
  if (code !== 0) return [];
  const result: WorktreeEntry[] = [];
  let cur: WorktreeEntry | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), settling: true };
      result.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
      cur.settling = false;
    } else if (cur && (line === "detached" || line === "bare")) {
      cur.settling = false;
    }
  }
  return result;
}

/**
 * Checkouts under `root`: direct children with a .git, worktrees of those repos wherever
 * they live, and one level deeper (`<root>/<group>/<wt>`) for worktree collections. A plain
 * directory under root that holds no repos is listed too, as a folder (scratch space).
 */
export async function listRepos(root: string): Promise<RepoPickerEntry[]> {
  if (!existsSync(root)) return [];
  const found = new Map<string, RepoPickerEntry>();
  const add = (info: RepoInfo) => {
    if (found.has(info.path)) return;
    const entry: RepoPickerEntry = { path: info.path, name: info.name, isWorktree: info.isWorktree };
    if (info.worktreeOf) entry.worktreeOf = info.worktreeOf;
    found.set(info.path, entry);
  };
  const scanDir = (dir: string): string[] => {
    const plain: string[] = [];
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return plain;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      if (!isDir(path)) continue;
      if (existsSync(join(path, ".git"))) {
        const info = resolveRepo(path);
        if (info) add(info);
      } else {
        plain.push(path);
      }
    }
    return plain;
  };
  // Non-repo dirs directly under root may hold worktree collections; look one level down.
  // One that holds none is scratch space the user may still want a session in.
  for (const group of scanDir(root)) {
    const before = found.size;
    scanDir(group);
    if (found.size === before) found.set(group, { path: group, name: basename(group), isWorktree: false, folder: true });
  }
  const mains = [...found.values()].filter((e) => !e.isWorktree);
  const lists = await Promise.all(mains.map((m) => listWorktrees(m.path)));
  for (const list of lists) {
    for (const wt of list) {
      if (found.has(safeReal(wt.path))) continue;
      const info = resolveRepo(wt.path);
      if (info) add(info);
    }
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Live state of every checkout under `root`, for the ⌘F explorer's repo list. Repos no
 * session has touched are read on demand (and cached like any other), never watched.
 */
export async function allRepoStates(root: string): Promise<RepoState[]> {
  const entries = (await listRepos(root)).filter((e) => !e.folder);
  const states = await Promise.all(entries.map((e) => getRepoState(e.path)));
  return states.filter((s): s is RepoState => !!s);
}

// ---- live state ----

function parseStatus(out: string): Pick<RepoBase, "branch" | "head" | "upstream" | "ahead" | "behind" | "dirty"> {
  let branch = "";
  let head = "";
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# ")) {
      const [key, ...rest] = line.slice(2).split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") head = val === "(initial)" ? "" : val;
      else if (key === "branch.head") branch = val;
      else if (key === "branch.upstream") upstream = val;
      else if (key === "branch.ab") {
        const m = /\+(\d+) -(\d+)/.exec(val);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      }
      continue;
    }
    dirty++;
  }
  return { branch, head, upstream, ahead, behind, dirty };
}

/**
 * Browser URL for a remote, from `git remote -v` output: scp-style (git@host:o/r.git), ssh://
 * and http(s):// forms all become https://host/o/r. Local paths and anything else: undefined.
 */
export function remoteWebUrl(remotesOut: string, remote: string): string | undefined {
  let url: string | undefined;
  for (const line of remotesOut.split("\n")) {
    const m = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(line);
    if (m && m[1] === remote && (m[3] === "fetch" || !url)) url = m[2];
  }
  if (!url) return undefined;
  let m = /^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(url) ?? /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(url);
  if (!m) return undefined;
  const path = m[2].replace(/\.git$/, "").replace(/\/+$/, "");
  return path ? `https://${m[1]}/${path}` : undefined;
}

async function readBase(info: RepoInfo): Promise<RepoBase | undefined> {
  const [status, log, remotes] = await Promise.all([
    run(info.path, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]),
    run(info.path, ["log", "-1", "--format=%ct%x09%s"]),
    run(info.path, ["remote", "-v"]),
  ]);
  if (status.code !== 0) return undefined;
  const parsed = parseStatus(status.out);
  const base: RepoBase = { ...parsed, at: Date.now() };
  if (remotes.code === 0) {
    const url = remoteWebUrl(remotes.out, parsed.upstream?.split("/")[0] ?? "origin");
    if (url) base.remoteUrl = url;
  }
  if (log.code === 0 && log.out.trim()) {
    const tab = log.out.indexOf("\t");
    base.lastCommitAt = Number(log.out.slice(0, tab)) * 1000;
    base.subject = log.out.slice(tab + 1).trim();
  }
  return base;
}

async function commitsSince(info: RepoInfo, baseline: string, head: string): Promise<number> {
  if (!baseline || !head) return 0;
  const key = `${info.path}\0${baseline}\0${head}`;
  const hit = sinceCache.get(key);
  if (hit !== undefined) return hit;
  const { code, out } = await run(info.path, ["rev-list", "--count", `${baseline}..${head}`]);
  const n = code === 0 ? Number(out.trim()) || 0 : 0;
  sinceCache.set(key, n);
  return n;
}

function toState(info: RepoInfo, base: RepoBase | undefined, sessionId?: string): RepoState {
  const state: RepoState = {
    path: info.path,
    name: info.name,
    branch: base?.branch ?? readHeadBranch(info),
    head: base?.head ?? "",
    ahead: base?.ahead ?? 0,
    behind: base?.behind ?? 0,
    dirty: base?.dirty ?? 0,
    isWorktree: info.isWorktree,
    commitsSinceBaseline: 0,
  };
  if (base?.upstream) state.upstream = base.upstream;
  if (base?.remoteUrl) state.remoteUrl = base.remoteUrl;
  if (info.worktreeOf) state.worktreeOf = info.worktreeOf;
  if (base?.lastCommitAt) state.lastCommitAt = base.lastCommitAt;
  if (sessionId) {
    const b = db.getBaseline(sessionId, info.path);
    if (b) {
      state.baseline = b.baselineSha;
      state.commitsSinceBaseline = sinceCache.get(`${info.path}\0${b.baselineSha}\0${state.head}`) ?? 0;
    }
  }
  return state;
}

/** Live state for one checkout; cached 2s per repo, coalesced while in flight. */
export async function getRepoState(path: string, sessionId?: string): Promise<RepoState | undefined> {
  const info = resolveRepo(path);
  if (!info) return undefined;
  const base = await refresh(info, false);
  if (sessionId) {
    const b = db.getBaseline(sessionId, info.path);
    if (b && base) await commitsSince(info, b.baselineSha, base.head);
  }
  return toState(info, base, sessionId);
}

async function refresh(info: RepoInfo, force: boolean): Promise<RepoBase | undefined> {
  const cached = bases.get(info.path);
  if (!force && cached && Date.now() - cached.at < STATE_TTL_MS) return cached;
  const pending = inflight.get(info.path);
  if (pending) return pending;
  const p = (async () => {
    const prev = bases.get(info.path);
    const next = await readBase(info);
    if (next) {
      bases.set(info.path, next);
      if (prev) await detectEvents(info, prev, next);
      const sids = repoSessions.get(info.path);
      if (sids) {
        for (const sid of sids) {
          const b = db.getBaseline(sid, info.path);
          if (b) await commitsSince(info, b.baselineSha, next.head);
        }
      }
      await checkWorktrees(info);
    }
    return next;
  })().finally(() => inflight.delete(info.path));
  inflight.set(info.path, p);
  return p;
}

// ---- git-side events ----

async function isAncestor(info: RepoInfo, a: string, b: string): Promise<boolean> {
  return (await run(info.path, ["merge-base", "--is-ancestor", a, b])).code === 0;
}

function activeSessionsFor(repoPath: string): string[] {
  const out: string[] = [];
  for (const sid of repoSessions.get(repoPath) ?? []) {
    const s = db.getSession(sid);
    if (s && s.status === "exited") continue;
    out.push(sid);
  }
  return out;
}

function recordGitEvent(info: RepoInfo, summary: string, payload: Record<string, unknown>): void {
  for (const sessionId of activeSessionsFor(info.path)) {
    const event: HenryEvent = {
      id: crypto.randomUUID(),
      sessionId,
      claudeSessionId: db.getSession(sessionId)?.claudeSessionId,
      ts: Date.now(),
      kind: "git",
      cwd: info.path,
      repo: info.path,
      payload: { ...payload, repo: info.path, branch: bases.get(info.path)?.branch },
      severity: "info",
      summary,
    };
    try {
      const c = rules.classify(event);
      event.severity = c.severity;
      if (c.rule) event.rule = c.rule;
    } catch (e) {
      console.error("[git] rules.classify failed:", e);
    }
    db.insertEvent(event);
    emit({ type: "event", event });
    if (event.severity !== "info") {
      const flag = { id: crypto.randomUUID(), eventId: event.id, sessionId, ts: event.ts, severity: event.severity, rule: event.rule ?? "git", summary, read: false };
      db.insertFlag(flag);
      emit({ type: "flag", flag });
    }
  }
}

async function detectEvents(info: RepoInfo, prev: RepoBase, next: RepoBase): Promise<void> {
  const label = (b: RepoBase) => (b.branch === "(detached)" ? `${short(b.head)} (detached)` : b.branch);
  if (prev.branch !== next.branch) {
    recordGitEvent(info, `checked out ${label(next)} (was ${label(prev)})`, { action: "checkout", from: prev.branch, to: next.branch, fromHead: prev.head, head: next.head });
    return;
  }
  if (prev.head !== next.head) {
    if (!prev.head) {
      recordGitEvent(info, `commit ${short(next.head)} on ${next.branch}: ${next.subject ?? ""}`, { action: "commit", to: next.head, count: 1, subject: next.subject });
    } else if (await isAncestor(info, prev.head, next.head)) {
      const { out } = await run(info.path, ["rev-list", "--count", `${prev.head}..${next.head}`]);
      const n = Number(out.trim()) || 1;
      const summary = n === 1
        ? `commit ${short(next.head)} on ${next.branch}: ${next.subject ?? ""}`
        : `${n} commits on ${next.branch}, now at ${short(next.head)}: ${next.subject ?? ""}`;
      recordGitEvent(info, summary, { action: "commit", from: prev.head, to: next.head, count: n, subject: next.subject });
    } else if (await isAncestor(info, next.head, prev.head)) {
      recordGitEvent(info, `HEAD moved backwards (reset?) from ${short(prev.head)} to ${short(next.head)} on ${next.branch}`, { action: "reset", from: prev.head, to: next.head });
    } else {
      recordGitEvent(info, `HEAD rewritten (amend/rebase?) from ${short(prev.head)} to ${short(next.head)} on ${next.branch}: ${next.subject ?? ""}`, { action: "rewrite", from: prev.head, to: next.head, subject: next.subject });
    }
    return;
  }
  if (prev.ahead > 0 && next.ahead === 0 && prev.upstream && prev.upstream === next.upstream) {
    recordGitEvent(info, `pushed ${next.branch} (${prev.ahead} commit${prev.ahead === 1 ? "" : "s"}) to ${next.upstream}`, { action: "push", count: prev.ahead, upstream: next.upstream });
  } else if (!prev.upstream && next.upstream && next.ahead === 0) {
    recordGitEvent(info, `pushed ${next.branch}, now tracking ${next.upstream}`, { action: "push", upstream: next.upstream });
  }
}

async function checkWorktrees(info: RepoInfo): Promise<void> {
  // The watcher fires while `git worktree add` is still writing the new checkout; one still
  // settling is left unknown so the next refresh reports it complete with its branch.
  const list = (await listWorktrees(info.path)).filter((w) => !w.settling);
  const paths = new Set(list.map((w) => safeReal(w.path)));
  const known = knownWorktrees.get(info.commonDir);
  knownWorktrees.set(info.commonDir, paths);
  if (!known) return;
  for (const wt of list) {
    const real = safeReal(wt.path);
    if (known.has(real) || real === info.path) continue;
    recordGitEvent(info, `new worktree ${real}${wt.branch ? ` on ${wt.branch}` : ""}`, { action: "worktree", path: real, branch: wt.branch });
  }
}

// ---- session association ----

function associate(sessionId: string, info: RepoInfo): boolean {
  let set = sessionRepos.get(sessionId);
  if (!set) sessionRepos.set(sessionId, (set = new Set()));
  const fresh = !set.has(info.path);
  set.add(info.path);
  let rs = repoSessions.get(info.path);
  if (!rs) repoSessions.set(info.path, (rs = new Set()));
  rs.add(sessionId);
  ensureWatch(info);
  return fresh;
}

function broadcastSession(sessionId: string): void {
  emit({ type: "repos:update", sessionId, repos: getSessionRepos(sessionId) });
}

/**
 * Called by hooks.ts whenever a session's hook event carries a cwd or file path.
 * Resolves `absPath` to its repo, records the session→repo association and baseline
 * (db.upsertBaseline on first touch), then refreshes and broadcasts repos:update.
 */
export function noteSessionPath(sessionId: string, absPath: string): void {
  const info = resolveRepo(absPath);
  if (!info) return;
  const fresh = associate(sessionId, info);
  void (async () => {
    try {
      if (!db.getBaseline(sessionId, info.path)) {
        const { code, out } = await run(info.path, ["rev-parse", "HEAD"]);
        const sha = code === 0 ? out.trim() : "";
        if (sha) db.upsertBaseline({ sessionId, repoPath: info.path, baselineSha: sha, firstSeen: Date.now() });
      }
      const before = bases.get(info.path);
      const after = await refresh(info, false);
      // Skip the broadcast when nothing changed and this session already had the repo.
      if (fresh || before !== after || !before) {
        for (const sid of repoSessions.get(info.path) ?? []) broadcastSession(sid);
      }
    } catch (e) {
      console.error(`[git] noteSessionPath ${info.path}:`, e);
    }
  })();
}

/** Repos this session has touched, with live state. */
export function getSessionRepos(sessionId: string): RepoState[] {
  const out: RepoState[] = [];
  for (const path of sessionRepos.get(sessionId) ?? []) {
    const info = repos.get(path);
    if (!info) continue;
    out.push(toState(info, bases.get(path), sessionId));
  }
  return out;
}

/** All sessions' repo state, keyed by session id (used for the state snapshot). */
export function getAllSessionRepos(): Record<string, RepoState[]> {
  const out: Record<string, RepoState[]> = {};
  for (const sid of sessionRepos.keys()) out[sid] = getSessionRepos(sid);
  return out;
}

/** Forget a session's associations (kept in the DB; only the live map is cleared). */
export function forgetSession(sessionId: string): void {
  for (const path of sessionRepos.get(sessionId) ?? []) repoSessions.get(path)?.delete(sessionId);
  sessionRepos.delete(sessionId);
}

// ---- diff / log vs baseline ----

async function baselineFor(sessionId: string, info: RepoInfo): Promise<string> {
  const b = db.getBaseline(sessionId, info.path);
  if (b) return b.baselineSha;
  const { code, out } = await run(info.path, ["rev-parse", "HEAD"]);
  return code === 0 ? out.trim() : "";
}

/**
 * Working tree vs the session baseline: `git diff <baseline>` for tracked paths, plus a
 * "new file" diff for every untracked (non-ignored) file. Capped at ~2MB.
 */
export async function diffSinceBaseline(sessionId: string, repoPath: string): Promise<{ diff: string; baseline: string }> {
  const info = resolveRepo(repoPath);
  if (!info) return { diff: "", baseline: "" };
  const baseline = await baselineFor(sessionId, info);
  if (!baseline) return { diff: "", baseline: "" };
  const parts: string[] = [];
  let bytes = 0;
  let truncated = false;
  const push = (s: string) => {
    if (!s) return;
    if (bytes + s.length > DIFF_CAP_BYTES) {
      parts.push(s.slice(0, Math.max(0, DIFF_CAP_BYTES - bytes)));
      bytes = DIFF_CAP_BYTES;
      truncated = true;
      return;
    }
    parts.push(s);
    bytes += s.length;
  };
  const tracked = await run(info.path, ["diff", "--no-color", "--no-ext-diff", baseline, "--", "."], { maxBytes: DIFF_CAP_BYTES + 1 });
  if (tracked.code !== 0 && tracked.code !== 1) return { diff: `# git diff failed: ${tracked.err.trim()}\n`, baseline };
  push(tracked.out);
  const untracked = await run(info.path, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.code === 0) {
    for (const file of untracked.out.split("\0").filter(Boolean)) {
      if (truncated) break;
      const one = await run(info.path, ["diff", "--no-color", "--no-index", "--", "/dev/null", file], { maxBytes: DIFF_CAP_BYTES + 1 });
      push(one.out);
    }
  }
  if (truncated) parts.push(`\n# diff truncated at ${Math.round(DIFF_CAP_BYTES / 1024 / 1024)}MB\n`);
  return { diff: parts.join(""), baseline };
}

// ---- files: changed since baseline, repo index, one-file diff ----

const FILES_CAP = 2000;
const INDEX_TTL_MS = 10_000;
const INDEX_CAP_BYTES = 8 * 1024 * 1024;

/** Working tree vs the session baseline, one row per path, untracked files as `?`. */
export async function changedFiles(sessionId: string, repoPath: string): Promise<ChangedFile[]> {
  const info = resolveRepo(repoPath);
  if (!info) return [];
  const baseline = await baselineFor(sessionId, info);
  const out: ChangedFile[] = [];
  if (baseline) {
    const r = await run(info.path, ["diff", "--name-status", "-z", "-M", baseline, "--", "."]);
    if (r.code === 0 || r.code === 1) {
      const parts = r.out.split("\0");
      for (let i = 0; i < parts.length && out.length < FILES_CAP; ) {
        const code = parts[i++];
        if (!code) continue;
        const c = code[0];
        if (c === "R" || c === "C") {
          const from = parts[i++];
          const path = parts[i++];
          if (path) out.push({ path, status: "R", from });
        } else {
          const path = parts[i++];
          if (path) out.push({ path, status: c === "A" || c === "D" ? c : "M" });
        }
      }
    }
  }
  const u = await run(info.path, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (u.code === 0) {
    for (const path of u.out.split("\0")) {
      if (out.length >= FILES_CAP) break;
      if (path) out.push({ path, status: "?" });
    }
  }
  for (const f of out) {
    if (f.status === "D") continue;
    try {
      f.mtime = statSync(join(info.path, f.path)).mtimeMs;
    } catch {
      /* gone between listing and stat */
    }
  }
  return out;
}

/** Changed files for every repo the session touched, plus the repo its cwd sits in. */
export async function sessionFiles(sessionId: string): Promise<SessionFiles> {
  const paths = new Set<string>(sessionRepos.get(sessionId) ?? []);
  const cwdRepo = resolveRepo(db.getSession(sessionId)?.cwd ?? "");
  if (cwdRepo) paths.add(cwdRepo.path);
  const repos: SessionFiles["repos"] = [];
  for (const path of paths) {
    const info = resolveRepo(path);
    if (!info) continue;
    repos.push({ path: info.path, name: info.name, baseline: await baselineFor(sessionId, info), files: await changedFiles(sessionId, info.path) });
  }
  return { sessionId, repos };
}

const indexCache = new Map<string, { at: number; files: string[] }>();

/** Every tracked and untracked (not ignored) path under the repo, for ⌘K. Cached briefly. */
export async function listFiles(anyPath: string): Promise<string[]> {
  const info = resolveRepo(anyPath);
  if (!info) return [];
  const hit = indexCache.get(info.path);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.files;
  const r = await run(info.path, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBytes: INDEX_CAP_BYTES });
  const files = r.code === 0 ? r.out.split("\0").filter(Boolean) : [];
  indexCache.set(info.path, { at: Date.now(), files });
  return files;
}

/**
 * One file vs the session baseline (HEAD when no session is given). An untracked file diffs
 * against /dev/null; an unchanged or ignored file yields an empty diff. Undefined: not in a repo.
 */
export async function fileDiff(sessionId: string | undefined, absPath: string): Promise<FileDiff | undefined> {
  const info = resolveRepo(absPath);
  const rel = info && relIn(info.path, absPath);
  if (!info || rel === undefined) return undefined;
  const baseline = sessionId ? await baselineFor(sessionId, info) : (await run(info.path, ["rev-parse", "HEAD"])).out.trim();
  if (!baseline) return { baseline: "", diff: "" };
  const tracked = await run(info.path, ["diff", "--no-color", "--no-ext-diff", baseline, "--", rel], { maxBytes: DIFF_CAP_BYTES });
  if (tracked.out) return { baseline, diff: tracked.out };
  const untracked = await run(info.path, ["ls-files", "--others", "--exclude-standard", "--", rel]);
  if (!untracked.out.trim()) return { baseline, diff: "" };
  const one = await run(info.path, ["diff", "--no-color", "--no-index", "--", "/dev/null", rel], { maxBytes: DIFF_CAP_BYTES });
  return { baseline, diff: one.out };
}

/** Commits between the session baseline and HEAD, newest first. */
export async function logSinceBaseline(sessionId: string, repoPath: string): Promise<{ baseline: string; commits: LogEntry[] }> {
  const info = resolveRepo(repoPath);
  if (!info) return { baseline: "", commits: [] };
  const baseline = await baselineFor(sessionId, info);
  if (!baseline) return { baseline: "", commits: [] };
  const { code, out } = await run(info.path, ["log", "--format=%h%x09%ct%x09%s", `${baseline}..HEAD`]);
  if (code !== 0) return { baseline, commits: [] };
  const commits: LogEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [sha, ts, ...rest] = line.split("\t");
    commits.push({ sha, ts: Number(ts) * 1000, subject: rest.join("\t") });
  }
  return { baseline, commits };
}

const GRAPH_CAP_BYTES = 512 * 1024;
const GRAPH_MAX_COMMITS = 400;

/**
 * The commit graph across every branch and tag, newest first, as `git log --graph` draws it.
 * Rows with a commit carry its fields; the rest are pure graph connectors. `head` lets the
 * UI mark the current commit even when nothing is decorated.
 */
export async function commitGraph(repoPath: string, limit = GRAPH_MAX_COMMITS): Promise<{ head: string; lines: GraphLine[]; truncated: boolean }> {
  const info = resolveRepo(repoPath);
  if (!info) return { head: "", lines: [], truncated: false };
  const n = Math.max(1, Math.min(limit, GRAPH_MAX_COMMITS));
  // \x1f separates the graph column from the fields; a row without one is a connector.
  const fmt = "--format=%x1f%h%x1f%D%x1f%s%x1f%ct%x1f%an";
  const [head, { code, out }] = await Promise.all([
    run(info.path, ["rev-parse", "--short", "HEAD"]),
    run(info.path, ["log", "--graph", "--all", "--date-order", "--no-color", `-n${n + 1}`, fmt], { maxBytes: GRAPH_CAP_BYTES }),
  ]);
  if (code !== 0) return { head: "", lines: [], truncated: false };
  const lines: GraphLine[] = [];
  let commits = 0;
  for (const raw of out.split("\n")) {
    if (!raw) continue;
    const i = raw.indexOf("\x1f");
    if (i < 0) {
      lines.push({ graph: raw.trimEnd() });
      continue;
    }
    if (++commits > n) break;
    const [sha, refs, subject, ts, author] = raw.slice(i + 1).split("\x1f");
    lines.push({ graph: raw.slice(0, i).trimEnd(), sha, refs: refs || undefined, subject, ts: Number(ts) * 1000, author });
  }
  return { head: head.code === 0 ? head.out.trim() : "", lines, truncated: commits > n };
}

export interface CommitDetail {
  sha: string;
  fullSha: string;
  parents: string[];
  refs?: string;
  author: string;
  email: string;
  ts: number;
  subject: string;
  body: string;
  /** Patch vs the first parent (the whole tree for a root commit), capped like a repo diff. */
  diff: string;
}

/** One commit's metadata and patch, for the commit view. `sha` is anything rev-parse accepts. */
export async function commitDetail(repoPath: string, sha: string): Promise<CommitDetail | undefined> {
  const info = resolveRepo(repoPath);
  if (!info || !/^[\w./~^-]{1,80}$/.test(sha) || sha.startsWith("-")) return undefined;
  const fmt = "--format=%h%x1f%H%x1f%p%x1f%D%x1f%an%x1f%ae%x1f%ct%x1f%s%x1f%b%x1e";
  const meta = await run(info.path, ["show", "--no-patch", fmt, `${sha}^{commit}`, "--"]);
  if (meta.code !== 0) return undefined;
  const [short, fullSha, parents, refs, author, email, ts, subject, body] = meta.out.split("\x1e")[0].split("\x1f");
  // --first-parent keeps a merge's patch to what the merge itself brought in.
  const patch = await run(info.path, ["show", "--first-parent", "--no-color", "--no-ext-diff", "--format=", "-m", "--patch", fullSha, "--"], { maxBytes: DIFF_CAP_BYTES + 1 });
  let diff = patch.out;
  if (diff.length > DIFF_CAP_BYTES) diff = diff.slice(0, DIFF_CAP_BYTES) + `\n# diff truncated at ${Math.round(DIFF_CAP_BYTES / 1024 / 1024)}MB\n`;
  return {
    sha: short,
    fullSha,
    parents: parents ? parents.split(" ") : [],
    refs: refs || undefined,
    author,
    email,
    ts: Number(ts) * 1000,
    subject,
    body: body.replace(/\s+$/, ""),
    diff,
  };
}

// ---- watching ----

function scheduleRefresh(commonDir: string): void {
  const prev = debounces.get(commonDir);
  if (prev) clearTimeout(prev);
  debounces.set(
    commonDir,
    setTimeout(() => {
      debounces.delete(commonDir);
      void refreshShared(commonDir);
    }, DEBOUNCE_MS),
  );
}

/** Refresh every touched checkout that shares this common dir, then broadcast. */
async function refreshShared(commonDir: string): Promise<void> {
  const touched = new Set<string>();
  for (const [path, info] of repos) {
    if (info.commonDir !== commonDir || !repoSessions.get(path)?.size) continue;
    try {
      await refresh(info, true);
    } catch (e) {
      console.error(`[git] refresh ${path}:`, e);
    }
    for (const sid of repoSessions.get(path) ?? []) touched.add(sid);
  }
  for (const sid of touched) broadcastSession(sid);
}

function ensureWatch(info: RepoInfo): void {
  if (watchers.has(info.path)) return;
  const list: FSWatcher[] = [];
  const on = () => scheduleRefresh(info.commonDir);
  const add = (target: string, recursive = false) => {
    if (!existsSync(target)) return;
    try {
      const w = watch(target, { persistent: false, recursive }, on);
      w.on("error", () => {});
      list.push(w);
    } catch {
      // unsupported target or platform; the poll covers it
    }
  };
  add(info.gitDir); // HEAD, index, FETCH_HEAD, ORIG_HEAD, packed-refs
  add(join(info.gitDir, "HEAD"));
  if (info.commonDir !== info.gitDir) {
    add(info.commonDir);
    add(join(info.path, ".git"));
  }
  add(join(info.commonDir, "refs"), true);
  add(join(info.commonDir, "worktrees"));
  watchers.set(info.path, list);
}

/** Rebuild the session→repo map from persisted baselines and start watch + poll. */
export function start(): void {
  if (started) return;
  started = true;
  const rows = db.db.prepare("SELECT session_id, repo_path FROM repo_baselines").all() as { session_id: string; repo_path: string }[];
  for (const r of rows) {
    const s = db.getSession(r.session_id);
    // Exited sessions still in the rail keep their repo cards; older ones are dropped.
    if (!s || (s.status === "exited" && s.createdAt < Date.now() - db.SESSION_RESTORE_WINDOW_MS)) continue;
    const info = resolveRepo(r.repo_path);
    if (info) associate(r.session_id, info);
  }
  poll = setInterval(() => {
    const dirs = new Set<string>();
    for (const [path, info] of repos) if (repoSessions.get(path)?.size) dirs.add(info.commonDir);
    for (const d of dirs) void refreshShared(d);
  }, POLL_MS);
  poll.unref();
  const dirs = new Set([...repos.values()].filter((i) => repoSessions.get(i.path)?.size).map((i) => i.commonDir));
  for (const d of dirs) void refreshShared(d);
}

/** Stop watchers and the poll (tests, shutdown). Associations stay in memory. */
export function stop(): void {
  if (poll) clearInterval(poll);
  poll = undefined;
  for (const t of debounces.values()) clearTimeout(t);
  debounces.clear();
  for (const list of watchers.values()) for (const w of list) w.close();
  watchers.clear();
  started = false;
}
