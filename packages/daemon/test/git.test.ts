// Milestone 3 tests: real git repos in a temp dir, HENRY_HOME pointed at a scratch home.
// Run: cd packages/daemon && bun test test/git.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HenryEvent, RepoState, ServerMessage } from "@henry/shared";
import { rmScratch, stopSessiond } from "./sessiond-helper";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "henry-git-test-")));
const home = join(tmp, "home");
const root = join(tmp, "code");
const bare = join(tmp, "remote.git");
const repo = join(root, "app");
const wt = join(root, "app-worktrees", "feat");
const clone = join(tmp, "clone");
mkdirSync(home, { recursive: true });
mkdirSync(root, { recursive: true });
process.env.HENRY_HOME = home;
process.env.HENRY_PORT = "0";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function g(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

type Git = typeof import("../src/git");
type Db = typeof import("../src/db");
let git: Git;
let db: Db;
const inbox: ServerMessage[] = [];

async function waitFor<T>(what: string, fn: () => T | undefined, ms = 8000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v !== undefined) return v;
    await Bun.sleep(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

const nextMsg = <T extends ServerMessage["type"]>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, ms?: number) =>
  waitFor(type, () => {
    const i = inbox.findIndex((m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
    return i >= 0 ? (inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>) : undefined;
  }, ms);

beforeAll(async () => {
  g(tmp, "init", "-q", "--bare", "-b", "main", bare);
  g(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");
  writeFileSync(join(repo, "b.txt"), "b\n");
  g(repo, "add", "b.txt");
  g(repo, "commit", "-q", "-m", "add b");
  g(repo, "remote", "add", "origin", bare);
  g(repo, "push", "-q", "-u", "origin", "main");
  mkdirSync(join(root, "app-worktrees"), { recursive: true });
  mkdirSync(join(root, "scratch"), { recursive: true });
  g(repo, "worktree", "add", "-q", "-b", "feat", wt, "HEAD");

  git = await import("../src/git");
  db = await import("../src/db");
  git.setBroadcast((m) => inbox.push(m));
  git.start();
});

afterAll(async () => {
  git?.stop();
  await stopSessiond(home);
  await rmScratch(tmp);
});

describe("git", () => {
  let baselineSha = "";

  test("noteSessionPath records a baseline and broadcasts repos:update", async () => {
    baselineSha = g(repo, "rev-parse", "HEAD");
    git.noteSessionPath("s1", join(repo, "a.txt"));
    const upd = await nextMsg("repos:update", (m) => m.sessionId === "s1");
    expect(upd.repos).toHaveLength(1);
    expect(upd.repos[0].path).toBe(repo);
    expect(upd.repos[0].branch).toBe("main");
    expect(upd.repos[0].isWorktree).toBe(false);
    const b = db.getBaseline("s1", repo);
    expect(b?.baselineSha).toBe(baselineSha);
    expect(git.getSessionRepos("s1").map((r) => r.path)).toEqual([repo]);
    expect(Object.keys(git.getAllSessionRepos())).toContain("s1");
  });

  test("remoteWebUrl turns hosted remote URLs into browser links", () => {
    const out = (u: string) => `origin\t${u} (fetch)\norigin\t${u} (push)\n`;
    expect(git.remoteWebUrl(out("git@github.com:apexearth/henry.git"), "origin")).toBe("https://github.com/apexearth/henry");
    expect(git.remoteWebUrl(out("https://github.com/apexearth/henry.git"), "origin")).toBe("https://github.com/apexearth/henry");
    expect(git.remoteWebUrl(out("ssh://git@gitlab.example.com:2222/group/sub/repo.git"), "origin")).toBe("https://gitlab.example.com/group/sub/repo");
    expect(git.remoteWebUrl(out("/tmp/some/bare.git"), "origin")).toBeUndefined();
    expect(git.remoteWebUrl(out("git@github.com:a/b.git"), "upstream")).toBeUndefined();
  });

  test("repoForPath resolves the repo and branch synchronously", () => {
    expect(git.repoForPath(join(repo, "deep", "missing", "file.ts"))).toMatchObject({ path: repo, branch: "main", isWorktree: false });
    expect(git.repoForPath(wt)).toMatchObject({ path: wt, branch: "feat", isWorktree: true, worktreeOf: repo });
    expect(git.repoForPath(tmp)).toBeUndefined();
  });

  test("getRepoState: ahead/behind/dirty/commitsSinceBaseline/upstream", async () => {
    // Behind: a commit reaches the remote from elsewhere.
    g(tmp, "clone", "-q", bare, clone);
    writeFileSync(join(clone, "c.txt"), "c\n");
    g(clone, "add", "c.txt");
    g(clone, "commit", "-q", "-m", "remote c");
    g(clone, "push", "-q", "origin", "main");
    g(repo, "fetch", "-q", "origin");
    // Ahead + commits since baseline: a local commit.
    writeFileSync(join(repo, "d.txt"), "d\n");
    g(repo, "add", "d.txt");
    g(repo, "commit", "-q", "-m", "local d");
    // Dirty: one modified tracked file, one untracked, one ignored.
    appendFileSync(join(repo, "a.txt"), "two\n");
    writeFileSync(join(repo, "untracked.txt"), "new\n");
    writeFileSync(join(repo, "ignored.txt"), "x\n");
    // Let the watcher settle so the commit event below is unambiguous.
    await Bun.sleep(600);
    inbox.length = 0;

    const s = (await git.getRepoState(repo, "s1")) as RepoState;
    expect(s.branch).toBe("main");
    expect(s.head).toBe(g(repo, "rev-parse", "HEAD"));
    expect(s.upstream).toBe("origin/main");
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(1);
    expect(s.dirty).toBe(2);
    expect(s.baseline).toBe(baselineSha);
    expect(s.commitsSinceBaseline).toBe(1);
    expect(s.lastCommitAt).toBeGreaterThan(Date.now() - 60_000);
    expect(git.getSessionRepos("s1")[0].commitsSinceBaseline).toBe(1);
  });

  test("diffSinceBaseline covers tracked changes and untracked files, not ignored", async () => {
    const { diff, baseline } = await git.diffSinceBaseline("s1", repo);
    expect(baseline).toBe(baselineSha);
    expect(diff).toContain("diff --git a/a.txt b/a.txt");
    expect(diff).toContain("+two");
    expect(diff).toContain("diff --git a/d.txt b/d.txt"); // committed since baseline
    expect(diff).toContain("diff --git a/untracked.txt b/untracked.txt");
    expect(diff).toContain("new file mode");
    expect(diff).toContain("+new");
    expect(diff).not.toContain("ignored.txt");
  });

  test("changedFiles, listFiles and fileDiff see the same picture as the repo diff", async () => {
    const changed = await git.changedFiles("s1", repo);
    const byPath = Object.fromEntries(changed.map((f) => [f.path, f]));
    expect(byPath["a.txt"].status).toBe("M");
    expect(byPath["d.txt"].status).toBe("A"); // committed since baseline still counts
    expect(byPath["untracked.txt"].status).toBe("?");
    expect(byPath["untracked.txt"].mtime).toBeGreaterThan(0);
    expect(byPath["ignored.txt"]).toBeUndefined();
    const all = await git.listFiles(join(repo, "a.txt"));
    expect(all).toContain("a.txt");
    expect(all).toContain("untracked.txt");
    expect(all).not.toContain("ignored.txt");
    const d = await git.fileDiff("s1", join(repo, "a.txt"));
    expect(d?.baseline).toBe(baselineSha);
    expect(d?.diff).toContain("+two");
    expect((await git.fileDiff("s1", join(repo, "untracked.txt")))?.diff).toContain("+new");
    expect((await git.fileDiff("s1", join(repo, "ignored.txt")))?.diff).toBe("");
    expect(await git.fileDiff("s1", "/")).toBeUndefined();
    const sf = await git.sessionFiles("s1");
    expect(sf.repos.find((r) => r.path === repo)?.files.length).toBe(changed.length);
  });

  test("explorer: allRepoStates covers every checkout; changedFiles without a session is vs HEAD", async () => {
    const states = await git.allRepoStates(root);
    const byPath = Object.fromEntries(states.map((s) => [s.path, s]));
    expect(byPath[repo]).toMatchObject({ name: "app", branch: "main", isWorktree: false });
    expect(byPath[repo].dirty).toBeGreaterThan(0);
    expect(byPath[join(root, "scratch")]).toBeUndefined(); // a folder, not a repo
    // d.txt was committed after the baseline: changed for the session, clean vs HEAD.
    const vsHead = Object.fromEntries((await git.changedFiles("", repo)).map((f) => [f.path, f.status]));
    expect(vsHead["a.txt"]).toBe("M");
    expect(vsHead["untracked.txt"]).toBe("?");
    expect(vsHead["d.txt"]).toBeUndefined();
  });

  test("grepRepo is literal and smart-case, sees untracked files, and windows long lines", async () => {
    writeFileSync(join(repo, "grep-me.txt"), "Needle here\nneedle again\nno hay\n" + "x".repeat(1000) + "needle" + "y".repeat(1000) + "\n");
    const lower = await git.grepRepo(repo, "needle");
    const relOf = (h: { rel: string; line: number }) => `${h.rel}:${h.line}`;
    expect(lower.hits.map(relOf)).toEqual(["grep-me.txt:1", "grep-me.txt:2", "grep-me.txt:4"]);
    expect(lower.hits[0].col).toBe(1);
    const long = lower.hits[2];
    expect(long.text.length).toBeLessThan(300);
    expect(long.text.slice(long.col - 1, long.col - 1 + 6)).toBe("needle");
    const upper = await git.grepRepo(repo, "Needle");
    expect(upper.hits.map(relOf)).toEqual(["grep-me.txt:1"]);
    expect((await git.grepRepo(repo, "a.b")).hits).toEqual([]); // literal: no regex dot
    expect((await git.grepRepo(repo, "")).hits).toEqual([]);
    expect(await git.grepRepo(repo, "needle", 2)).toMatchObject({ truncated: true });
    // Every repo under the root: hits carry the repo they came from.
    const all = await git.grepRepos(root, "needle");
    expect(all.hits.every((h) => h.repo === repo)).toBe(true);
    expect(all.hits.length).toBe(3);
    rmSync(join(repo, "grep-me.txt"));
  });

  test("logSinceBaseline lists commits after the baseline", async () => {
    const { baseline, commits } = await git.logSinceBaseline("s1", repo);
    expect(baseline).toBe(baselineSha);
    expect(commits).toHaveLength(1);
    expect(commits[0].subject).toBe("local d");
    expect(commits[0].sha).toBe(g(repo, "rev-parse", "--short", "HEAD"));
    expect(commits[0].ts).toBeGreaterThan(Date.now() - 60_000);
  });

  test("commitGraph draws every branch with decorations, newest first", async () => {
    const { head, lines, truncated } = await git.commitGraph(repo);
    expect(head).toBe(g(repo, "rev-parse", "--short", "HEAD"));
    expect(truncated).toBe(false);
    const commits = lines.filter((l) => l.sha);
    expect(commits.length).toBe(Number(g(repo, "rev-list", "--all", "--count")));
    expect(commits[0]).toMatchObject({ sha: head, subject: "local d", author: "t" });
    expect(commits[0].refs).toContain("HEAD -> main");
    expect(commits.some((c) => c.refs?.includes("feat"))).toBe(true);
    for (const l of lines) expect(l.graph).toMatch(/^[*|\\/ _.-]*$/);
    expect(lines.some((l) => l.graph.startsWith("*"))).toBe(true);
    // A cap that cuts the history reports it.
    const capped = await git.commitGraph(repo, 1);
    expect(capped.lines.filter((l) => l.sha)).toHaveLength(1);
    expect(capped.truncated).toBe(true);
    expect(await git.commitGraph(join(tmp, "nowhere"))).toEqual({ head: "", lines: [], truncated: false });
  });

  test("commitDetail returns metadata and the patch vs the first parent", async () => {
    const c = await git.commitDetail(repo, "HEAD");
    expect(c).toMatchObject({ sha: g(repo, "rev-parse", "--short", "HEAD"), fullSha: g(repo, "rev-parse", "HEAD"), subject: "local d", author: "t", email: "t@example.com" });
    expect(c!.parents).toEqual([g(repo, "rev-parse", "--short", "HEAD~1")]);
    expect(c!.refs).toContain("HEAD -> main");
    expect(c!.ts).toBeGreaterThan(Date.now() - 60_000);
    expect(c!.diff).toContain("diff --git a/d.txt b/d.txt");
    expect(c!.diff).toContain("new file mode");
    expect(await git.commitDetail(repo, "0000000")).toBeUndefined();
    expect(await git.commitDetail(repo, "--output=/tmp/x")).toBeUndefined();
    expect(await git.commitDetail(join(tmp, "nowhere"), "HEAD")).toBeUndefined();
  });

  test("worktree detection via noteSessionPath and listRepos", async () => {
    git.noteSessionPath("s2", join(wt, "a.txt"));
    const upd = await nextMsg("repos:update", (m) => m.sessionId === "s2");
    expect(upd.repos[0]).toMatchObject({ path: wt, name: "feat", branch: "feat", isWorktree: true, worktreeOf: repo });
    expect(upd.repos[0].upstream).toBeUndefined();
    expect(db.getBaseline("s2", wt)?.baselineSha).toBe(baselineSha);

    const list = await git.listRepos(root);
    const byPath = Object.fromEntries(list.map((e) => [e.path, e]));
    expect(byPath[repo]).toMatchObject({ name: "app", isWorktree: false });
    expect(byPath[wt]).toMatchObject({ name: "feat", isWorktree: true, worktreeOf: repo });
    expect(list.filter((e) => e.path === wt)).toHaveLength(1); // deduped
    expect(byPath[join(root, "app-worktrees")]).toBeUndefined(); // a container of repos, not a place to work
    expect(byPath[join(root, "scratch")]).toMatchObject({ name: "scratch", isWorktree: false, folder: true });
  });

  test("a new commit triggers a git HenryEvent and a repos:update", async () => {
    inbox.length = 0;
    writeFileSync(join(repo, "e.txt"), "e\n");
    g(repo, "add", "e.txt");
    g(repo, "commit", "-q", "-m", "watched commit");
    const sha = g(repo, "rev-parse", "--short", "HEAD");
    const ev = await nextMsg("event", (m) => m.event.kind === "git" && m.event.sessionId === "s1");
    expect(ev.event.summary).toBe(`commit ${sha} on main: watched commit`);
    expect(ev.event.repo).toBe(repo);
    // main is a protected branch by default, so the rules engine flags the commit.
    expect(ev.event.severity).toBe("alarm");
    expect(ev.event.rule).toBe("commit-on-protected");
    const stored = db.listEvents({ sessionId: "s1" }).find((e: HenryEvent) => e.id === ev.event.id);
    expect(stored?.kind).toBe("git");
    const upd = await nextMsg("repos:update", (m) => m.sessionId === "s1" && m.repos[0].commitsSinceBaseline === 2);
    expect(upd.repos[0].ahead).toBe(2);
  }, 20_000);

  test("a push produces a 'pushed' event and ahead drops to 0", async () => {
    inbox.length = 0;
    g(repo, "pull", "-q", "--rebase", "--autostash", "origin", "main");
    await nextMsg("event", (m) => m.event.kind === "git" && m.event.sessionId === "s1" && /rewritten|commits on main/.test(m.event.summary));
    inbox.length = 0;
    g(repo, "push", "-q", "origin", "main");
    const ev = await nextMsg("event", (m) => m.event.kind === "git" && m.event.sessionId === "s1" && m.event.summary.startsWith("pushed"));
    expect(ev.event.summary).toBe("pushed main (2 commits) to origin/main");
    const upd = await nextMsg("repos:update", (m) => m.sessionId === "s1" && m.repos[0].ahead === 0);
    expect(upd.repos[0].behind).toBe(0);
  }, 20_000);

  test("checkout produces a 'checked out' event", async () => {
    inbox.length = 0;
    g(repo, "checkout", "-q", "-b", "topic");
    const ev = await nextMsg("event", (m) => m.event.kind === "git" && m.event.sessionId === "s1" && m.event.summary.startsWith("checked out"));
    expect(ev.event.summary).toBe("checked out topic (was main)");
    expect(git.repoForPath(repo)?.branch).toBe("topic");
    g(repo, "checkout", "-q", "main");
    await nextMsg("event", (m) => m.event.kind === "git" && m.event.summary === "checked out main (was topic)");
  }, 20_000);

  test("a new worktree produces an event", async () => {
    inbox.length = 0;
    const wt2 = join(root, "app-worktrees", "feat2");
    g(repo, "worktree", "add", "-q", "-b", "feat2", wt2, "HEAD");
    const ev = await nextMsg("event", (m) => m.event.kind === "git" && m.event.summary.startsWith("new worktree"));
    expect(ev.event.summary).toBe(`new worktree ${wt2} on feat2`);
  }, 20_000);
});
