// Milestone 4: rules engine. Classifies hook + git events as info / notable / alarm using
// config.rules (~/.henry/config.json). Observe-only: it never blocks anything.
//
// Shape: a table of RuleDefs, each a small predicate over a lazily-built Context (tokenized
// Bash command, repo roots, current branch). classify() runs the table, keeps the highest
// severity (ties -> table order), and never throws: any internal error yields info.
//
// Adding a rule = one entry in RULES here + one entry in packages/shared/src/rules-catalog.ts.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { RULE_CATALOG, explainRule, rulesWithConfig, type HenryConfig, type HenryEvent, type RuleInfo, type Severity, type Session } from "@henry/shared";
import { config, expandHome } from "./config";
import * as git from "./git";
import { sessions } from "./sessions";

export interface Classification {
  severity: Severity;
  /** Stable rule id from the catalog (absent for info). */
  rule?: string;
  /** Short human detail for the flag (what path / branch / pattern), when known. */
  reason?: string;
}

export interface ClassifyOptions {
  /** Override config.rules (tests). */
  rules?: Partial<HenryConfig["rules"]>;
  /** Override reposRoot (tests). */
  reposRoot?: string;
  /** Override the clock (tests). */
  now?: number;
  /** Directories where writes are never "outside" (default: temp dirs and /dev); tests override. */
  ignoreDirs?: string[];
}

/** Swappable collaborators, so tests can fake a session or a branch without a PTY. */
export const deps = {
  getSession: (id: string): Pick<Session, "cwd"> | undefined => sessions.get(id),
  now: (): number => Date.now(),
};

type RulesConfig = Required<HenryConfig["rules"]>;

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function classify(event: HenryEvent, opts: ClassifyOptions = {}): Classification {
  try {
    const rules = { ...defaultRules(), ...(config.rules ?? {}), ...(opts.rules ?? {}) } as RulesConfig;
    const ctx = new Context(event, rules, opts.reposRoot ?? config.reposRoot, opts.now ?? deps.now(), opts.ignoreDirs ?? ALLOWED_OUTSIDE);
    let best: Classification = { severity: "info" };
    for (const def of RULES) {
      if (!phaseAllows(def, ctx)) continue;
      const hit = def.check(ctx);
      if (!hit || hit.severity === "info") continue;
      if (rank(hit.severity) > rank(best.severity)) best = { severity: hit.severity, rule: def.id, reason: hit.reason };
      if (best.severity === "alarm") break;
    }
    ctx.commit();
    return best;
  } catch (e) {
    if (process.env.HENRY_RULES_DEBUG) console.error("[rules] classify failed:", e);
    return { severity: "info" };
  }
}

/** One-line explanation of a rule id, for the UI and the overseer. */
export function explain(rule: string): string {
  return explainRule(rule);
}

/** Catalog with severities resolved against the live config ("info" = switched off). */
export function listRules(): RuleInfo[] {
  return rulesWithConfig(config.rules);
}

/** Drop all sliding-window state (tests). */
export function resetState(): void {
  recentPre.clear();
  recentCommits.clear();
  subagents.clear();
  rootCache.clear();
  branchCache.clear();
}

function defaultRules(): RulesConfig {
  return {
    protectedBranches: ["main", "master"],
    alarm: [],
    notable: [],
    crossRepoWrite: "notable",
    commitOnProtected: "alarm",
    pushToProtected: "notable",
    maxSubagentsPer10m: 8,
  };
}

function rank(s: Severity): number {
  return s === "alarm" ? 2 : s === "notable" ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Rule table
// ---------------------------------------------------------------------------

interface Hit {
  severity: Severity;
  reason?: string;
}

interface RuleDef {
  id: string;
  /**
   * pre:  fires on PreToolUse; on PostToolUse only if no PreToolUse for the same call was seen
   *       (so a command flags once, but still flags if only Post hooks are installed).
   * post: fires on PostToolUse only (needs the tool to have run).
   * any:  no phase gating (git events, SubagentStop, ...).
   */
  phase: "pre" | "post" | "any";
  check: (c: Context) => Hit | undefined;
}

const SECRET_BASENAME = /^(\.env(\..+)?|.+\.(pem|key)|id_(rsa|dsa|ecdsa|ed25519)|\.netrc)$/i;
const SECRET_EXAMPLE = /\.(example|sample|template|dist)$/i;
const SECRET_DIRS = new Set(["secrets", "credentials"]);
const WRITE_ALL = new Set(["rm", "tee", "touch", "mkdir", "rmdir", "chmod", "chown", "truncate"]);
const WRITE_LAST = new Set(["mv", "cp", "ln", "install", "rsync"]);
const ALLOWED_OUTSIDE = uniq(["/dev", "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/proc", tmpdir()]).map(stripSlash);

const RULES: RuleDef[] = [
  {
    id: "secret-path",
    phase: "pre",
    check: (c) => {
      if (c.kind !== "hook" || !c.tool) return;
      const p = c.pathTokens().find(isSecretPath);
      return p ? { severity: "alarm", reason: `${c.tool} touched ${p}` } : undefined;
    },
  },
  {
    id: "force-push",
    phase: "pre",
    check: (c) => {
      if (c.kind === "git") return /\bforce/i.test(c.summary) && /\bpush/i.test(c.summary) ? { severity: "alarm", reason: c.summary } : undefined;
      for (const s of c.gitSegments("push")) {
        const f = s.subArgs.find((a) => a === "--force" || a === "--force-with-lease" || a.startsWith("--force-with-lease=") || a === "--force-if-includes" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a.startsWith("+"));
        if (f) return { severity: "alarm", reason: `git push ${f}` };
      }
      return;
    },
  },
  {
    id: "history-rewrite",
    phase: "any",
    check: (c) => (c.kind === "git" && /^HEAD moved backwards/i.test(c.summary) ? { severity: "alarm", reason: c.summary } : undefined),
  },
  {
    id: "command-alarm",
    phase: "pre",
    check: (c) => {
      const m = c.cmd && matchPatterns(c.cmd, c.rules.alarm);
      return m ? { severity: "alarm", reason: `matched rules.alarm "${m}"` } : undefined;
    },
  },
  {
    id: "commit-on-protected",
    phase: "post",
    check: (c) => {
      const sev = c.rules.commitOnProtected;
      if (sev === "info") return;
      if (c.kind === "git") {
        const m = /^commit ([0-9a-f]{7,40}) on ([^\s:]+)/i.exec(c.summary);
        if (!m || !c.isProtected(m[2])) return;
        if (c.commitSeen(c.repoHint(), m[1])) return;
        return { severity: sev, reason: `commit ${m[1].slice(0, 7)} on ${m[2]}` };
      }
      for (const s of c.gitSegments("commit")) {
        if (s.subArgs.includes("--dry-run")) continue;
        const branch = c.branchAt(s.repoDir);
        if (!branch || !c.isProtected(branch)) continue;
        const sha = c.commitShaFromResponse();
        if (sha && c.commitSeen(s.repoDir, sha)) continue;
        return { severity: sev, reason: `git commit on ${branch}` };
      }
      return;
    },
  },
  {
    id: "push-to-protected",
    phase: "pre",
    check: (c) => {
      const sev = c.rules.pushToProtected;
      if (sev === "info") return;
      for (const s of c.gitSegments("push")) {
        const positional = s.subArgs.filter((a) => !a.startsWith("-"));
        const refspecs = positional.slice(1); // [remote, refspec...]
        if (refspecs.length) {
          for (const r of refspecs) {
            const dst = r.replace(/^\+/, "").split(":").pop()!.replace(/^refs\/heads\//, "");
            const target = dst === "HEAD" ? c.branchAt(s.repoDir) : dst;
            if (target && c.isProtected(target)) return { severity: sev, reason: `git push ${positional[0]} ${r}` };
          }
        } else {
          const branch = c.branchAt(s.repoDir);
          if (branch && c.isProtected(branch)) return { severity: sev, reason: `git push while on ${branch}` };
        }
      }
      return;
    },
  },
  {
    id: "cross-repo-write",
    phase: "pre",
    check: (c) => {
      const sev = c.rules.crossRepoWrite;
      if (sev === "info") return;
      const w = c.writePlacements().find((p) => p.where === "cross-repo");
      return w ? { severity: sev, reason: `wrote ${w.path} (session repo: ${w.home ?? "?"})` } : undefined;
    },
  },
  {
    id: "outside-repos-write",
    phase: "pre",
    check: (c) => {
      const w = c.writePlacements().find((p) => p.where === "outside");
      return w ? { severity: "notable", reason: `wrote ${w.path} outside ${c.reposRoot}` } : undefined;
    },
  },
  {
    id: "branch-churn",
    phase: "pre",
    check: (c) => {
      for (const s of c.gitSegments()) {
        const a = s.subArgs;
        const churn =
          (s.sub === "checkout" && a.some((x) => x === "-b" || x === "-B" || x === "--orphan")) ||
          (s.sub === "switch" && a.some((x) => x === "-c" || x === "-C" || x === "--create" || x === "--orphan")) ||
          (s.sub === "worktree" && (a[0] === "add" || a[0] === "remove" || a[0] === "prune")) ||
          (s.sub === "branch" && a.some((x) => x === "-D" || x === "-d" || x === "--delete")) ||
          (s.sub === "stash" && !["list", "show"].includes(a[0] ?? ""));
        if (churn) return { severity: "notable", reason: `git ${s.sub} ${a.join(" ")}`.trim() };
      }
      return;
    },
  },
  {
    id: "command-notable",
    phase: "pre",
    check: (c) => {
      const m = c.cmd && matchPatterns(c.cmd, c.rules.notable);
      return m ? { severity: "notable", reason: `matched rules.notable "${m}"` } : undefined;
    },
  },
  {
    id: "subagent-storm",
    phase: "any",
    check: (c) => {
      if (c.kind !== "hook" || c.hook !== "SubagentStop") return;
      const max = Number(c.rules.maxSubagentsPer10m);
      if (!Number.isFinite(max) || max <= 0) return;
      const st = subagents.get(c.sessionId) ?? { times: [], flaggedAt: 0 };
      subagents.set(c.sessionId, st);
      const cutoff = c.now - WINDOW_10M;
      st.times = st.times.filter((t) => t > cutoff);
      st.times.push(c.now);
      if (st.times.length <= max || c.now - st.flaggedAt < WINDOW_10M) return;
      st.flaggedAt = c.now;
      return { severity: "notable", reason: `${st.times.length} subagents in 10 minutes (limit ${max})` };
    },
  },
];

// Make sure every rule has a catalog entry (a missing one is a programming error, surfaced at load).
for (const r of RULES) if (!RULE_CATALOG.some((c) => c.id === r.id)) console.error(`[rules] "${r.id}" has no entry in shared/rules-catalog.ts`);

function phaseAllows(def: RuleDef, c: Context): boolean {
  if (def.phase === "any" || c.kind !== "hook") return true;
  if (c.hook === "PreToolUse") return def.phase === "pre";
  if (c.hook === "PostToolUse") return def.phase === "post" || (def.phase === "pre" && !c.preSeen());
  return false;
}

// ---------------------------------------------------------------------------
// Sliding-window state (small, bounded)
// ---------------------------------------------------------------------------

const WINDOW_10M = 10 * 60 * 1000;
const PRE_TTL = 2 * 60 * 1000;
const COMMIT_TTL = 10 * 1000;

/** Pre/Post pairing: key -> ts of the PreToolUse we already classified. */
const recentPre = new Map<string, number>();
/** "repo|sha7" -> ts, so a Bash commit and the git watcher's commit event flag once. */
const recentCommits = new Map<string, number>();
const subagents = new Map<string, { times: number[]; flaggedAt: number }>();

function sweep(m: Map<string, number>, now: number, ttl: number, cap = 1000): void {
  if (m.size < cap) return;
  for (const [k, t] of m) if (now - t > ttl) m.delete(k);
}

// ---------------------------------------------------------------------------
// Context: lazy, memoised view of one event
// ---------------------------------------------------------------------------

interface Segment {
  prog: string;
  /** Arguments after the program (env assignments and wrappers like sudo stripped). */
  args: string[];
  /** Targets of > >> &> redirects. */
  redirects: string[];
  /** Effective working directory (tracks `cd`). */
  cwd: string;
}

interface GitSegment extends Segment {
  sub: string;
  subArgs: string[];
  /** Directory the git command operates on (`-C` or the segment cwd). */
  repoDir: string;
}

interface Placement {
  path: string;
  where: "home" | "cross-repo" | "outside" | "ignored";
  home?: string;
}

class Context {
  readonly kind: string;
  readonly hook: string;
  readonly tool: string;
  readonly sessionId: string;
  readonly summary: string;
  readonly cwd: string;
  readonly input: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  /** Whitespace-normalised Bash command ("" for non-Bash events). */
  readonly cmd: string;
  readonly reposRoot: string;

  private _segments?: Segment[];
  private _gitSegments?: GitSegment[];
  private _placements?: Placement[];
  private _pathTokens?: string[];
  private _home?: string | null;
  private _preKey?: string | null;
  private _preSeen?: boolean;

  constructor(readonly e: HenryEvent, readonly rules: RulesConfig, reposRoot: string, readonly now: number, private readonly ignoreDirs: string[]) {
    this.kind = String(e.kind ?? "");
    this.hook = String(e.hookEvent ?? "");
    this.tool = String(e.toolName ?? "");
    this.sessionId = String(e.sessionId ?? "");
    this.summary = String(e.summary ?? "");
    this.payload = isObject(e.payload) ? e.payload : {};
    this.input = isObject(this.payload.tool_input) ? this.payload.tool_input : {};
    this.cwd = resolveDir(typeof e.cwd === "string" && e.cwd ? e.cwd : typeof this.payload.cwd === "string" ? this.payload.cwd : process.cwd());
    this.reposRoot = stripSlash(expandHome(reposRoot || ""));
    const raw = this.kind === "hook" && this.tool === "Bash" && typeof this.input.command === "string" ? this.input.command : "";
    this.cmd = raw.replace(/\s+/g, " ").trim();
  }

  // ---- protected branches / repos ----

  isProtected(branch: string): boolean {
    return (this.rules.protectedBranches ?? []).includes(branch);
  }

  /** Best guess at the repo an event is about (git events set e.repo). */
  repoHint(): string {
    return typeof this.e.repo === "string" && this.e.repo ? this.e.repo : repoRootOf(this.cwd) ?? this.cwd;
  }

  branchAt(dir: string): string | undefined {
    return branchOf(dir, this.now);
  }

  /** Root of the repo the session started in (its home repo); null when unknown. */
  homeRoot(): string | null {
    if (this._home !== undefined) return this._home;
    const s = deps.getSession(this.sessionId);
    this._home = s?.cwd ? repoRootOf(resolveDir(s.cwd)) ?? null : null;
    return this._home;
  }

  // ---- Bash parsing ----

  segments(): Segment[] {
    if (this._segments) return this._segments;
    return (this._segments = this.cmd ? parseCommand(this.cmd, this.cwd) : []);
  }

  gitSegments(sub?: string): GitSegment[] {
    if (!this._gitSegments) {
      this._gitSegments = [];
      for (const s of this.segments()) {
        if (s.prog !== "git") continue;
        let repoDir = s.cwd;
        let i = 0;
        for (; i < s.args.length; i++) {
          const a = s.args[i];
          if (a === "-C" && s.args[i + 1]) repoDir = resolve(repoDir, expandHome(s.args[++i]));
          else if (a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") i++;
          else if (!a.startsWith("-")) break;
        }
        this._gitSegments.push({ ...s, sub: s.args[i] ?? "", subArgs: s.args.slice(i + 1), repoDir });
      }
    }
    return sub ? this._gitSegments.filter((g) => g.sub === sub) : this._gitSegments;
  }

  /** Every path-like string the tool call mentions (for the secret check). */
  pathTokens(): string[] {
    if (this._pathTokens) return this._pathTokens;
    const out: string[] = [];
    if (this.tool === "Bash") {
      for (const s of this.segments()) out.push(...s.args.filter((a) => !a.startsWith("-")), ...s.redirects);
    } else {
      for (const k of ["file_path", "notebook_path", "path", "pattern"]) {
        const v = this.input[k];
        if (typeof v === "string" && v) out.push(v);
      }
    }
    return (this._pathTokens = out);
  }

  /** Where each write of this event lands relative to the session's home repo. */
  writePlacements(): Placement[] {
    if (this._placements) return this._placements;
    const targets: string[] = [];
    if (this.tool === "Bash") {
      for (const s of this.segments()) {
        targets.push(...s.redirects.map((r) => resolve(s.cwd, expandHome(r))));
        const positional = s.args.filter((a) => !a.startsWith("-") && !a.includes("://") && !a.startsWith("$"));
        if (s.prog === "git") {
          const g = this.gitSegments().find((x) => x.args === s.args); // same Segment (args array is per-segment)
          if (!READ_ONLY_GIT.has(g?.sub ?? "")) targets.push(g?.repoDir ?? s.cwd);
        } else if (WRITE_ALL.has(s.prog)) {
          targets.push(...(positional.length ? positional.map((p) => resolve(s.cwd, expandHome(p))) : [s.cwd]));
        } else if (WRITE_LAST.has(s.prog) && positional.length) {
          targets.push(resolve(s.cwd, expandHome(positional[positional.length - 1])));
        } else if (s.prog === "sed" && s.args.some((a) => a === "--in-place" || /^-[a-zA-Z]*i/.test(a))) {
          targets.push(...positional.map((p) => resolve(s.cwd, expandHome(p))));
        }
      }
    } else if (WRITE_TOOLS.has(this.tool)) {
      const p = this.input.file_path ?? this.input.notebook_path;
      if (typeof p === "string" && p) targets.push(resolve(this.cwd, expandHome(p)));
    }
    const home = this.homeRoot();
    return (this._placements = uniq(targets).map((path) => this.place(path, home)));
  }

  private place(path: string, home: string | null): Placement {
    const root = repoRootOf(path);
    if (home && root && repoIdentity(root) === repoIdentity(home)) return { path, where: "home", home };
    if (isUnder(path, this.reposRoot)) {
      // Inside reposRoot but not the home repo: another repo, or a not-yet-a-repo directory.
      return home ? { path, where: "cross-repo", home } : { path, where: "ignored" };
    }
    if (this.ignoreDirs.some((d) => isUnder(path, d))) return { path, where: "ignored" };
    return { path, where: "outside" };
  }

  // ---- Pre/Post pairing & commit dedupe ----

  private preKey(): string | null {
    if (this._preKey !== undefined) return this._preKey;
    if (this.kind !== "hook" || !this.tool) return (this._preKey = null);
    const id = typeof this.payload.tool_use_id === "string" ? this.payload.tool_use_id : safeJson(this.input).slice(0, 2000);
    return (this._preKey = `${this.sessionId}|${this.tool}|${id}`);
  }

  preSeen(): boolean {
    if (this._preSeen !== undefined) return this._preSeen;
    const k = this.preKey();
    const t = k ? recentPre.get(k) : undefined;
    return (this._preSeen = t !== undefined && this.now - t < PRE_TTL);
  }

  /** Extract the new commit sha from a PostToolUse Bash response (`[main abc1234] subject`). */
  commitShaFromResponse(): string | undefined {
    const r = this.payload.tool_response;
    const text = typeof r === "string" ? r : isObject(r) ? [r.stdout, r.stderr, r.output].filter((x) => typeof x === "string").join("\n") : "";
    return /\[[^\s\]]+ (?:\(root-commit\) )?([0-9a-f]{7,40})\]/.exec(text)?.[1];
  }

  /** True if this (repo, sha) was already flagged within COMMIT_TTL; records it otherwise. */
  commitSeen(repo: string, sha: string): boolean {
    const k = `${repoIdentity(repoRootOf(repo) ?? repo)}|${sha.slice(0, 7)}`;
    const t = recentCommits.get(k);
    if (t !== undefined && this.now - t < COMMIT_TTL) return true;
    sweep(recentCommits, this.now, COMMIT_TTL);
    recentCommits.set(k, this.now);
    return false;
  }

  /** Record this PreToolUse so the matching PostToolUse does not flag again. */
  commit(): void {
    if (this.hook !== "PreToolUse") return;
    const k = this.preKey();
    if (!k) return;
    sweep(recentPre, this.now, PRE_TTL);
    recentPre.set(k, this.now);
  }
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "blame", "describe", "config", "fetch", "shortlog", "reflog", "cat-file", "grep", "for-each-ref", "ls-remote", "rev-list", "version", "help", "worktree"]);
const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "time", "exec", "builtin"]);

/** Split a shell command into segments (&&, ||, ;, |, &, newlines, $(..), backticks), respecting quotes. */
function parseCommand(cmd: string, cwd: string): Segment[] {
  const segs: string[][] = [];
  let tokens: string[] = [];
  let tok = "";
  let has = false;
  const endTok = () => {
    if (has) tokens.push(tok);
    tok = "";
    has = false;
  };
  const endSeg = () => {
    endTok();
    if (tokens.length) segs.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (ch === "'" || ch === '"') {
      const q = ch;
      has = true;
      for (i++; i < cmd.length && cmd[i] !== q; i++) {
        if (q === '"' && cmd[i] === "\\" && i + 1 < cmd.length) i++;
        tok += cmd[i];
      }
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      tok += next;
      has = true;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endTok();
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "(" || ch === ")" || ch === "`") {
      endSeg();
      continue;
    }
    if (ch === "$" && next === "(") {
      endSeg();
      i++;
      continue;
    }
    if (ch === "|") {
      endSeg();
      if (next === "|") i++;
      continue;
    }
    if (ch === "&") {
      // `&>`, `>&` and `2>&1` keep the ampersand; anything else separates commands.
      if (next === ">" || tok.endsWith(">")) {
        tok += ch;
        has = true;
        continue;
      }
      endSeg();
      if (next === "&") i++;
      continue;
    }
    tok += ch;
    has = true;
  }
  endSeg();

  const out: Segment[] = [];
  let effCwd = cwd;
  for (const raw of segs) {
    const args: string[] = [];
    const redirects: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i];
      const m = /^(\d*&?>{1,2}\|?|&>>?)(.*)$/.exec(t);
      if (m) {
        const target = m[2] || raw[++i] || "";
        if (target && !target.startsWith("&")) redirects.push(target);
        continue;
      }
      if (/^\d*<.*/.test(t)) {
        if (!t.slice(t.indexOf("<") + 1)) i++;
        continue;
      }
      args.push(t);
    }
    let i = 0;
    while (i < args.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i]) || WRAPPERS.has(basename(args[i])))) i++;
    if (i >= args.length) continue;
    const prog = basename(args[i]);
    const rest = args.slice(i + 1);
    out.push({ prog, args: rest, redirects, cwd: effCwd });
    if (prog === "cd" || prog === "pushd") {
      const target = rest.find((a) => !a.startsWith("-"));
      effCwd = target ? resolve(effCwd, expandHome(target)) : homedir();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

const regexCache = new Map<string, RegExp | null>();

/** First pattern that matches; substring (case-insensitive) by default, /.../flags for a regex. */
function matchPatterns(cmd: string, patterns: readonly string[] | undefined): string | undefined {
  if (!Array.isArray(patterns)) return;
  const lower = cmd.toLowerCase();
  for (const raw of patterns) {
    if (typeof raw !== "string" || !raw) continue;
    const m = /^\/(.+)\/([a-z]*)$/.exec(raw);
    if (m) {
      let re = regexCache.get(raw);
      if (re === undefined) {
        try {
          re = new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i");
        } catch {
          re = null;
          console.error(`[rules] invalid regex pattern ${raw}; ignored`);
        }
        regexCache.set(raw, re);
      }
      if (re) {
        re.lastIndex = 0;
        if (re.test(cmd)) return raw;
      }
    } else if (lower.includes(raw.replace(/\s+/g, " ").trim().toLowerCase())) return raw;
  }
  return;
}

// ---------------------------------------------------------------------------
// Paths, repos, branches
// ---------------------------------------------------------------------------

function isSecretPath(p: string): boolean {
  const clean = p.replace(/^["']|["']$/g, "");
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  const base = parts[parts.length - 1] ?? "";
  if (parts.some((s) => SECRET_DIRS.has(s.toLowerCase()))) return true;
  return SECRET_BASENAME.test(base) && !SECRET_EXAMPLE.test(base);
}

const ROOT_TTL = 5000;
const rootCache = new Map<string, { root: string | undefined; ts: number }>();

/** Nearest ancestor (or self) containing .git; undefined when not in a repo. Cached 5s per directory. */
export function repoRootOf(absPath: string): string | undefined {
  const now = Date.now();
  let dir = absPath;
  const visited: string[] = [];
  while (true) {
    const hit = rootCache.get(dir);
    if (hit && now - hit.ts < ROOT_TTL) {
      for (const v of visited) rootCache.set(v, hit);
      return hit.root;
    }
    visited.push(dir);
    if (existsSync(join(dir, ".git"))) {
      const entry = { root: dir, ts: now };
      for (const v of visited) rootCache.set(v, entry);
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      if (rootCache.size > 4000) rootCache.clear();
      const entry = { root: undefined, ts: now };
      for (const v of visited) rootCache.set(v, entry);
      return undefined;
    }
    dir = parent;
  }
}

/** The .git directory for a checkout (follows worktree `gitdir:` files). */
function gitDirOf(root: string): string | undefined {
  const g = join(root, ".git");
  try {
    if (statSync(g).isDirectory()) return g;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, "utf8"));
    return m ? resolve(root, m[1].trim()) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Main-repo path for a worktree, or the root itself, canonicalised through realpath so two
 * checkouts of one repo compare equal (git writes realpaths into worktree gitdir files).
 */
function repoIdentity(root: string): string {
  const gd = gitDirOf(root);
  const m = gd ? /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(gd) : null;
  return realpath(m ? m[1] : root);
}

function realpath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

const BRANCH_TTL = 2000;
const branchCache = new Map<string, { branch: string | undefined; ts: number }>();

type GitWithRepoForPath = { repoForPath?: (absPath: string) => { path: string; branch: string } | undefined };

/** Current branch of the repo containing `dir` (undefined when detached or not a repo). */
export function branchOf(dir: string, now = Date.now()): string | undefined {
  const root = repoRootOf(dir);
  if (!root) return undefined;
  const hit = branchCache.get(root);
  if (hit && now - hit.ts < BRANCH_TTL) return hit.branch;
  let branch: string | undefined;
  const rp = (git as GitWithRepoForPath).repoForPath;
  if (typeof rp === "function") {
    try {
      branch = rp(dir)?.branch || undefined;
    } catch {
      branch = undefined;
    }
  }
  if (!branch) {
    try {
      const gd = gitDirOf(root);
      const head = gd ? readFileSync(join(gd, "HEAD"), "utf8").trim() : "";
      branch = head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : undefined;
    } catch {
      branch = undefined;
    }
  }
  if (branchCache.size > 500) branchCache.clear();
  branchCache.set(root, { branch, ts: now });
  return branch;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolveDir(p: string): string {
  const x = expandHome(p);
  return isAbsolute(x) ? x : resolve(x);
}

function stripSlash(p: string): string {
  return p.length > 1 ? p.replace(/[\\/]+$/, "") : p;
}

function isUnder(path: string, dir: string): boolean {
  if (!dir) return false;
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}
