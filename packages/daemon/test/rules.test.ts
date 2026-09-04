// bun test packages/daemon/test/rules.test.ts
// Uses a throwaway HENRY_HOME and two temp repos under a temp reposRoot; never touches ~/.henry.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HenryConfig, HenryEvent } from "@henry/shared";
import { rmScratch, stopSessiond } from "./sessiond-helper";

const scratch = mkdtempSync(join(tmpdir(), "henry-rules-"));
process.env.HENRY_HOME = join(scratch, "home");
process.env.HENRY_PORT = "0";

// The shell commands below quote these paths: on Windows they carry forward slashes, as a
// command typed into Git Bash (Claude Code's Bash tool there) would. join() still works on them.
const shellish = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const reposRoot = shellish(join(scratch, "code"));
const repoA = shellish(join(reposRoot, "alpha"));
const repoB = shellish(join(reposRoot, "beta"));
const outside = shellish(join(scratch, "elsewhere"));

// Imported after HENRY_HOME is set (static imports would hoist above the assignment).
const rules = await import("../src/rules");
type ClassifyOptions = NonNullable<Parameters<typeof rules.classify>[1]>;

function sh(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

function initRepo(dir: string, branch: string) {
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", branch);
  writeFileSync(join(dir, "README.md"), "# x\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
}

let n = 0;
function ev(partial: Partial<HenryEvent> & { payload?: unknown }): HenryEvent {
  return {
    id: `e${++n}`,
    sessionId: "s1",
    ts: Date.now(),
    kind: "hook",
    severity: "info",
    summary: "",
    cwd: repoA,
    payload: {},
    ...partial,
  };
}

const bash = (command: string, hook = "PreToolUse", extra: Record<string, unknown> = {}, cwd = repoA) =>
  ev({ hookEvent: hook, toolName: "Bash", cwd, payload: { tool_input: { command }, cwd, ...extra } });
const tool = (toolName: string, input: Record<string, unknown>, hook = "PreToolUse") =>
  ev({ hookEvent: hook, toolName, payload: { tool_input: input, cwd: repoA } });

const baseRules: HenryConfig["rules"] = {
  protectedBranches: ["main", "master"],
  alarm: ["git reset --hard", "rm -rf", "/drop\\s+table/"],
  notable: ["git push", "git rebase", "git checkout", "git switch", "git worktree", "git stash", "gh pr"],
  crossRepoWrite: "notable",
  commitOnProtected: "alarm",
  pushToProtected: "notable",
  maxSubagentsPer10m: 3,
};
// The scratch tree lives under os.tmpdir(), which the default allowlist ignores, so tests
// pin the allowlist to /tmp and /dev only.
const opts = (): ClassifyOptions => ({ rules: baseRules, reposRoot, ignoreDirs: ["/dev", "/tmp", "/private/tmp"] });
const c = (e: HenryEvent, o: ClassifyOptions = {}) => rules.classify(e, { ...opts(), ...o });

beforeAll(() => {
  initRepo(repoA, "main");
  initRepo(repoB, "main");
  mkdirSync(outside, { recursive: true });
  rules.deps.getSession = (id) => (id === "s1" ? { cwd: repoA } : id === "s-feature" ? { cwd: repoB } : undefined);
});

afterAll(async () => {
  await stopSessiond(join(scratch, "home"));
  try {
    await rmScratch(scratch);
  } catch {
    // Windows: config.ts still watches HENRY_HOME in this process, which pins the directory.
  }
});

beforeEach(() => rules.resetState());

describe("command patterns", () => {
  test("force push is an alarm in every spelling", () => {
    for (const cmd of ["git push --force", "git push -f origin main", "git push origin main --force-with-lease", "git push origin +main", "git push -fu origin feat"]) {
      expect(c(bash(cmd))).toMatchObject({ severity: "alarm", rule: "force-push" });
    }
  });

  test("plain push to a feature ref is notable via the list", () => {
    expect(c(bash("git push origin feature/x"))).toMatchObject({ severity: "notable", rule: "command-notable" });
    expect(c(bash("git push -u origin feature/x"))).toMatchObject({ severity: "notable", rule: "command-notable" });
  });

  test("push to protected: explicit ref, or bare push while on main", () => {
    expect(c(bash("git push origin main"))).toMatchObject({ severity: "notable", rule: "push-to-protected" });
    expect(c(bash("git push origin HEAD:refs/heads/master"))).toMatchObject({ severity: "notable", rule: "push-to-protected" });
    expect(c(bash("git push"))).toMatchObject({ severity: "notable", rule: "push-to-protected" });
    expect(c(bash("git push"), { rules: { ...baseRules, pushToProtected: "alarm" } })).toMatchObject({ severity: "alarm", rule: "push-to-protected" });
    expect(c(bash("git push"), { rules: { ...baseRules, pushToProtected: "info" } })).toMatchObject({ severity: "notable", rule: "command-notable" });
  });

  test("substring patterns are case-insensitive and whitespace-normalised", () => {
    expect(c(bash("Git   Reset --HARD HEAD~1"))).toMatchObject({ severity: "alarm", rule: "command-alarm" });
    expect(c(bash("rm -rf node_modules"))).toMatchObject({ severity: "alarm", rule: "command-alarm" });
  });

  test("regex patterns wrapped in slashes", () => {
    expect(c(bash("psql -c 'DROP   TABLE users'"))).toMatchObject({ severity: "alarm", rule: "command-alarm" });
    expect(c(bash("echo drop the table"))).toMatchObject({ severity: "info" });
    // an invalid regex is ignored rather than throwing
    expect(c(bash("ls"), { rules: { ...baseRules, alarm: ["/(/"] } })).toEqual({ severity: "info" });
  });

  test("branch and worktree churn", () => {
    expect(c(bash("git checkout -b feat/x"))).toMatchObject({ severity: "notable", rule: "branch-churn" });
    expect(c(bash("git switch -c feat/x"))).toMatchObject({ severity: "notable", rule: "branch-churn" });
    expect(c(bash("git worktree add ../wt feat/x"))).toMatchObject({ severity: "notable", rule: "branch-churn" });
    expect(c(bash("git stash"))).toMatchObject({ severity: "notable", rule: "branch-churn" });
    expect(c(bash("git stash list"))).toMatchObject({ severity: "notable", rule: "command-notable" });
    expect(c(bash("git branch -D old"))).toMatchObject({ severity: "notable", rule: "branch-churn" });
    expect(c(bash("git checkout main"))).toMatchObject({ severity: "notable", rule: "command-notable" });
  });
});

describe("commits", () => {
  test("commit on main (PostToolUse) is an alarm; dry-run and feature branches are not", () => {
    expect(c(bash('git commit -m "x"', "PostToolUse"))).toMatchObject({ severity: "alarm", rule: "commit-on-protected" });
    expect(c(bash('git commit --dry-run -m "x"', "PostToolUse"))).toEqual({ severity: "info" });
    expect(c(bash('git commit -m "x"', "PreToolUse"))).toEqual({ severity: "info" });
    expect(c(bash('git commit -m "x"', "PostToolUse"), { rules: { ...baseRules, commitOnProtected: "notable" } })).toMatchObject({ severity: "notable" });
  });

  test("commit on a feature branch is quiet", () => {
    sh(repoB, "checkout", "-q", "-b", "feature");
    const inB = (cmd: string, hook: string) => ({ ...bash(cmd, hook, {}, repoB), sessionId: "s-feature" });
    try {
      expect(c(inB('git commit -m "x"', "PostToolUse"))).toEqual({ severity: "info" });
      expect(c(inB("git push", "PreToolUse"))).toMatchObject({ rule: "command-notable" });
    } finally {
      sh(repoB, "checkout", "-q", "main");
      rules.resetState();
    }
  });

  test("git event for the same commit within 10s is deduped", () => {
    const post = bash("git commit -m x", "PostToolUse", { tool_response: { stdout: "[main abc1234] x\n 1 file changed" } });
    expect(c(post)).toMatchObject({ rule: "commit-on-protected" });
    const gitEv = ev({ kind: "git", repo: repoA, summary: "commit abc1234 on main: x" });
    expect(c(gitEv)).toEqual({ severity: "info" });
    // a different commit still flags, and so does the same one after the window
    expect(c(ev({ kind: "git", repo: repoA, summary: "commit deadbee on main: y" }))).toMatchObject({ rule: "commit-on-protected" });
    expect(c(gitEv, { now: Date.now() + 20_000 })).toMatchObject({ rule: "commit-on-protected" });
    expect(c(ev({ kind: "git", repo: repoA, summary: "commit 1234567 on feature: y" }))).toEqual({ severity: "info" });
  });

  test("history rewrite git event", () => {
    expect(c(ev({ kind: "git", repo: repoA, summary: "HEAD moved backwards on main: abc1234 -> 1234567" }))).toMatchObject({ severity: "alarm", rule: "history-rewrite" });
  });
});

describe("cross-repo and outside writes", () => {
  test("Write/Edit into another repo", () => {
    expect(c(tool("Write", { file_path: join(repoB, "src/x.ts"), content: "" }))).toMatchObject({ severity: "notable", rule: "cross-repo-write" });
    expect(c(tool("Edit", { file_path: join(repoA, "src/x.ts"), old_string: "a", new_string: "b" }))).toEqual({ severity: "info" });
    expect(c(tool("Write", { file_path: "src/y.ts", content: "" }))).toEqual({ severity: "info" });
    expect(c(tool("Write", { file_path: join(repoB, "x") }), { rules: { ...baseRules, crossRepoWrite: "alarm" } })).toMatchObject({ severity: "alarm" });
    expect(c(tool("Write", { file_path: join(repoB, "x") }), { rules: { ...baseRules, crossRepoWrite: "info" } })).toEqual({ severity: "info" });
  });

  test("shell writes: redirects, sed -i, rm/mv/cp, cd + git", () => {
    expect(c(bash(`echo hi > ${repoB}/notes.txt`))).toMatchObject({ rule: "cross-repo-write" });
    expect(c(bash(`sed -i '' 's/a/b/' ${repoB}/README.md`))).toMatchObject({ rule: "cross-repo-write" });
    expect(c(bash(`cp README.md ${repoB}/`))).toMatchObject({ rule: "cross-repo-write" });
    expect(c(bash(`cd ${repoB} && git add . && git commit -m x`))).toMatchObject({ rule: "cross-repo-write" });
    expect(c(bash(`git -C ${repoB} add .`))).toMatchObject({ rule: "cross-repo-write" });
    // reads of another repo never flag
    expect(c(bash(`cat ${repoB}/README.md`))).toEqual({ severity: "info" });
    expect(c(bash(`cd ${repoB} && git status && git log --oneline`))).toEqual({ severity: "info" });
    expect(c(bash(`ls ${repoB}`))).toEqual({ severity: "info" });
    expect(c(bash("echo hi > out.txt && cat out.txt"))).toEqual({ severity: "info" });
  });

  test("writes outside reposRoot are notable; temp dirs and /dev are ignored", () => {
    expect(c(tool("Write", { file_path: join(outside, "settings.json") }))).toMatchObject({ severity: "notable", rule: "outside-repos-write" });
    expect(c(bash(`echo x > ${outside}/f`))).toMatchObject({ rule: "outside-repos-write" });
    expect(c(bash("make build > /dev/null 2>&1"))).toEqual({ severity: "info" });
    expect(c(bash("echo x > /tmp/henry-scratch.txt"))).toEqual({ severity: "info" });
    // the default allowlist also covers os.tmpdir()
    expect(rules.classify(bash(`echo x > ${join(tmpdir(), "henry-scratch.txt")}`), { rules: baseRules, reposRoot })).toEqual({ severity: "info" });
    expect(c(tool("Read", { file_path: join(outside, "settings.json") }))).toEqual({ severity: "info" });
  });

  test("a worktree of the home repo is not cross-repo", () => {
    const wt = join(reposRoot, "alpha-wt");
    sh(repoA, "worktree", "add", "-q", "-b", "wt-branch", wt);
    try {
      rules.resetState();
      expect(c(tool("Write", { file_path: join(wt, "x.ts") }))).toEqual({ severity: "info" });
    } finally {
      sh(repoA, "worktree", "remove", "--force", wt);
      sh(repoA, "branch", "-q", "-D", "wt-branch");
    }
  });

  test("unknown session: only the outside rule applies", () => {
    const e = tool("Write", { file_path: join(repoB, "x") });
    e.sessionId = "nobody";
    expect(c(e)).toEqual({ severity: "info" });
    const o = tool("Write", { file_path: join(outside, "x") });
    o.sessionId = "nobody";
    expect(c(o)).toMatchObject({ rule: "outside-repos-write" });
  });
});

describe("secrets", () => {
  test("reads and writes of secret-looking paths are alarms", () => {
    expect(c(tool("Read", { file_path: join(repoA, ".env") }))).toMatchObject({ severity: "alarm", rule: "secret-path" });
    expect(c(tool("Read", { file_path: join(repoA, ".env.local") }))).toMatchObject({ rule: "secret-path" });
    expect(c(tool("Write", { file_path: join(repoA, "certs/server.pem") }))).toMatchObject({ rule: "secret-path" });
    expect(c(tool("Edit", { file_path: join(repoA, "secrets/db.json") }))).toMatchObject({ rule: "secret-path" });
    expect(c(tool("Glob", { pattern: "**/credentials/*" }))).toMatchObject({ rule: "secret-path" });
    expect(c(bash("cat .env | grep KEY"))).toMatchObject({ rule: "secret-path" });
    expect(c(bash("cat ~/.aws/credentials"))).toMatchObject({ rule: "secret-path" });
    expect(c(bash("openssl rsa -in server.key -check"))).toMatchObject({ rule: "secret-path" });
  });

  test("templates and ordinary files are not secrets", () => {
    expect(c(tool("Read", { file_path: join(repoA, ".env.example") }))).toEqual({ severity: "info" });
    expect(c(tool("Read", { file_path: join(repoA, "src/keys.ts") }))).toEqual({ severity: "info" });
    expect(c(bash("cat environment.md"))).toEqual({ severity: "info" });
  });
});

describe("subagents", () => {
  test("storm flags once per window after the limit", () => {
    const t0 = 1_000_000;
    const stop = (i: number, session = "s1") => rules.classify(ev({ hookEvent: "SubagentStop", sessionId: session, payload: {} }), { ...opts(), now: t0 + i * 1000 });
    expect(stop(1)).toEqual({ severity: "info" });
    expect(stop(2)).toEqual({ severity: "info" });
    expect(stop(3)).toEqual({ severity: "info" });
    expect(stop(4)).toMatchObject({ severity: "notable", rule: "subagent-storm" });
    expect(stop(5)).toEqual({ severity: "info" });
    // another session has its own window
    expect(stop(6, "s2")).toEqual({ severity: "info" });
    // after the window slides past, it can fire again
    expect(rules.classify(ev({ hookEvent: "SubagentStop", payload: {} }), { ...opts(), now: t0 + 11 * 60_000 })).toEqual({ severity: "info" });
  });
});

describe("hygiene", () => {
  test("benign reads and shell commands are info", () => {
    expect(c(tool("Read", { file_path: join(repoA, "README.md") }))).toEqual({ severity: "info" });
    expect(c(bash("ls -la"))).toEqual({ severity: "info" });
    expect(c(bash("bun test && git status"))).toEqual({ severity: "info" });
    expect(c(bash("git log --oneline -5"))).toEqual({ severity: "info" });
    expect(c(ev({ hookEvent: "Stop", payload: {} }))).toEqual({ severity: "info" });
    expect(c(ev({ kind: "git", summary: "pushed feature (2 commits)" }))).toEqual({ severity: "info" });
  });

  test("malformed payloads never throw", () => {
    const bad: unknown[] = [null, undefined, "string", 42, [], { tool_input: null }, { tool_input: "x" }, { tool_input: { command: 12 } }, { tool_input: { file_path: {} } }];
    for (const payload of bad) {
      expect(c(ev({ hookEvent: "PreToolUse", toolName: "Bash", payload }))).toEqual({ severity: "info" });
      expect(c(ev({ hookEvent: "PreToolUse", toolName: "Write", payload }))).toEqual({ severity: "info" });
    }
    const weird = { id: "x", sessionId: 5, ts: "now", kind: "hook", hookEvent: 7, toolName: ["Bash"], cwd: 3, payload: { tool_input: { command: "git push --force" } }, severity: "info", summary: null } as unknown as HenryEvent;
    expect(() => rules.classify(weird)).not.toThrow();
    expect(rules.classify(ev({ cwd: "/nonexistent/dir", hookEvent: "PreToolUse", toolName: "Bash", payload: { tool_input: { command: "git push" } } }), opts()).severity).not.toBe("alarm");
  });

  test("PreToolUse flags once; the matching PostToolUse is quiet, but a lone PostToolUse still flags", () => {
    const pre = bash("git push --force", "PreToolUse", { tool_use_id: "t1" });
    const post = bash("git push --force", "PostToolUse", { tool_use_id: "t1" });
    expect(c(pre)).toMatchObject({ rule: "force-push" });
    expect(c(post)).toEqual({ severity: "info" });
    rules.resetState();
    expect(c(post)).toMatchObject({ rule: "force-push" });
  });

  test("explain and listRules come from the shared catalog", () => {
    expect(rules.explain("force-push")).toMatch(/force/);
    expect(rules.explain("nope")).toMatch(/Unknown rule/);
    const list = rules.listRules();
    expect(list.map((r) => r.id)).toContain("cross-repo-write");
    for (const r of list) expect(["info", "notable", "alarm"]).toContain(r.severity);
  });

  test("classify is fast", () => {
    const e = bash(`cd ${repoB} && sed -i '' 's/a/b/' README.md && git commit -am x && git push origin main`);
    c(e);
    const t = performance.now();
    for (let i = 0; i < 2000; i++) c(e);
    expect((performance.now() - t) / 2000).toBeLessThan(1);
  });
});
