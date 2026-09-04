// Open pull requests per checkout, read from the `gh` CLI (no new dependency, and it already
// holds the user's GitHub auth). Observe-only and best effort: a missing gh, a repo the token
// cannot see, or GitHub being down all mean "no PR badge", never a failed repo refresh.
//
// git.ts calls track() on every repo refresh; that only spawns gh when the cached answer has
// aged out. When a count changes, onChange lets git.ts re-broadcast the repo's cards.
import type { PullRequest } from "@henry/shared";

/** A PR list is worth re-reading a few times an hour, not on every git refresh. */
const TTL_MS = 5 * 60_000;
/** After a failure (private repo, no auth, offline) back off hard: it rarely fixes itself fast. */
const ERROR_TTL_MS = 15 * 60_000;
const TIMEOUT_MS = 15_000;
/** More open PRs than this and the badge stops being a number worth trusting; say so. */
const LIMIT = 100;

interface Entry {
  slug: string;
  /** Last successful list; kept across a later failure so the badge does not flicker away. */
  prs?: PullRequest[];
  /** When the last attempt finished. */
  at: number;
  ok: boolean;
  note?: string;
  inflight?: Promise<void>;
}

/** repo path → its GitHub state. Worktrees keep their own entry (same slug, own fetch). */
const cache = new Map<string, Entry>();
/** `gh` is not on PATH: stop spawning it until the daemon restarts. */
let ghMissing = false;
let onChange: (repoPath: string) => void = () => {};

/** git.ts injects a re-broadcast so a changed count reaches open windows. */
export function setOnChange(fn: (repoPath: string) => void): void {
  onChange = fn;
}

/** owner/name for a github.com web URL (as remoteWebUrl produces); undefined for anything else. */
export function githubSlug(remoteUrl: string | undefined): string | undefined {
  if (!remoteUrl) return undefined;
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** Cached open-PR count for a checkout; undefined until a fetch has answered. */
export function count(repoPath: string): number | undefined {
  return cache.get(repoPath)?.prs?.length;
}

/** Note a checkout's remote and refresh its PR list if the cached one is stale. Never throws. */
export function track(repoPath: string, remoteUrl: string | undefined): void {
  const slug = githubSlug(remoteUrl);
  if (!slug) {
    cache.delete(repoPath);
    return;
  }
  void refresh(repoPath, slug, false).catch(() => {});
}

/** Open PRs of one checkout, refreshing when stale (or when `force`). */
export async function list(repoPath: string, remoteUrl: string | undefined, force = false): Promise<{ prs: PullRequest[]; slug?: string; note?: string }> {
  const slug = githubSlug(remoteUrl);
  if (!slug) return { prs: [], note: "no github.com remote" };
  const e = await refresh(repoPath, slug, force);
  return { prs: e.prs ?? [], slug, note: e.note };
}

async function refresh(repoPath: string, slug: string, force: boolean): Promise<Entry> {
  let e = cache.get(repoPath);
  if (!e || e.slug !== slug) {
    e = { slug, at: 0, ok: false };
    cache.set(repoPath, e);
  }
  if (e.inflight) {
    await e.inflight;
    return e;
  }
  if (!force && e.at && Date.now() - e.at < (e.ok ? TTL_MS : ERROR_TTL_MS)) return e;
  if (ghMissing) return e;
  const entry = e;
  entry.inflight = (async () => {
    const before = entry.prs?.length;
    const res = await ghPrList(slug);
    entry.at = Date.now();
    entry.ok = res.prs !== undefined;
    entry.note = res.note;
    if (res.prs) entry.prs = res.prs;
    if (entry.prs?.length !== before) onChange(repoPath);
  })().finally(() => {
    entry.inflight = undefined;
  });
  await entry.inflight;
  return entry;
}

async function ghPrList(slug: string): Promise<{ prs?: PullRequest[]; note?: string }> {
  const args = ["pr", "list", "--repo", slug, "--state", "open", "--limit", String(LIMIT), "--json", "number,title,author,isDraft,url,headRefName,updatedAt"];
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    // GH_PAGER: gh pipes JSON through a pager when one is configured, which would hang here.
    proc = Bun.spawn(["gh", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1", GH_PROMPT_DISABLED: "1" } });
  } catch (err) {
    ghMissing = true;
    console.log(`[prs] cannot run \`gh\` (${(err as Error).message}); PR counts stay off until restart`);
    return { note: "gh not installed" };
  }
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [out, errOut, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code === 127) {
      ghMissing = true;
      return { note: "gh not installed" };
    }
    if (code !== 0) {
      const note = firstLine(errOut) || `gh exited ${code}`;
      console.log(`[prs] ${slug}: ${note}`);
      return { note };
    }
    const prs = parse(out);
    return { prs, note: prs.length >= LIMIT ? `first ${LIMIT}; there may be more` : undefined };
  } catch (err) {
    return { note: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

interface GhPr {
  number?: number;
  title?: string;
  author?: { login?: string };
  isDraft?: boolean;
  url?: string;
  headRefName?: string;
  updatedAt?: string;
}

/** Newest first, so a card's first few lines are the PRs that moved last. */
function parse(out: string): PullRequest[] {
  let rows: GhPr[];
  try {
    rows = JSON.parse(out) as GhPr[];
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => typeof r.number === "number")
    .map((r) => ({
      number: r.number as number,
      title: r.title ?? "",
      author: r.author?.login ?? "",
      draft: !!r.isDraft,
      branch: r.headRefName ?? "",
      url: r.url ?? "",
      updatedAt: Date.parse(r.updatedAt ?? "") || 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find((l) => l)?.slice(0, 200) ?? "";
}

/** Tests: forget every cached list. */
export function reset(): void {
  cache.clear();
  ghMissing = false;
}
