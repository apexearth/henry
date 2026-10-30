// `#157` in a session's output, resolved to the GitHub issue or PR it means. Read with `gh` like
// the PR badge (prs.ts): the user's own auth, no dependency, cached, never fatal. A number is
// looked for among the session's repos' own issues and the items of the projects
// config.github.repos lists for them, which Henry fills in from each repo's linked projects the
// first time a session works there. When more than one repo has that number, a small model reads
// the text around the mention and picks.
import type { GithubItem, GithubRef } from "@henry/shared";
import { config, noteGithubRepo } from "./config";
import * as db from "./db";
import * as git from "./git";
import { askBackend } from "./overseer";
import { githubSlug, runGh } from "./prs";

/** Project boards move a few times an hour; re-read them no more often than the PR list. */
const TTL_MS = 5 * 60_000;
const ERROR_TTL_MS = 15 * 60_000;
/** Paging a project is one gh call per 100 items. */
const PAGE_TIMEOUT_MS = 30_000;
const MAX_PAGES = 20;
const BODY_CHARS = 400;
const CONTEXT_CHARS = 800;
const PICK_TIMEOUT_MS = 60_000;
const PICKS_KEPT = 500;

const oneLine = (q: string) => q.replace(/\s+/g, " ").trim();

const LINKED_QUERY = oneLine(`query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    projectsV2(first: 20) { nodes { number closed owner { ... on Organization { login } ... on User { login } } } }
  }
}`);

const CONTENT = "number title url state body repository { nameWithOwner } assignees(first: 5) { nodes { login } } labels(first: 10) { nodes { name } }";
const FIELD = "field { ... on ProjectV2FieldCommon { name } }";
const ITEMS_QUERY = oneLine(`query($owner: String!, $number: Int!, $endCursor: String) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        title
        items(first: 100, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            content {
              __typename
              ... on Issue { ${CONTENT} }
              ... on PullRequest { ${CONTENT} isDraft }
            }
            fieldValues(first: 30) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue { name ${FIELD} }
                ... on ProjectV2ItemFieldTextValue { text ${FIELD} }
                ... on ProjectV2ItemFieldDateValue { date ${FIELD} }
                ... on ProjectV2ItemFieldNumberValue { number ${FIELD} }
                ... on ProjectV2ItemFieldIterationValue { title ${FIELD} }
              }
            }
          }
        }
      }
    }
  }
}`);

// ---- which projects a repo means ----

const discovering = new Map<string, Promise<void>>();

/** git.ts calls this on every refresh of a repo a session is in, so config fills in (and the
 * boards are read) before anyone asks. Cheap once both are cached. */
export function track(remoteUrl: string | undefined): void {
  const slug = githubSlug(remoteUrl);
  if (!slug) return;
  // Warm the boards too, so the first card does not wait on a page of GitHub per hundred items.
  void discover(slug)
    .then(() => Promise.all((config.github.repos[slug]?.projects ?? []).map(projectItems)))
    .catch(() => {});
}

/** Write config.github.repos[slug] from the repo's open linked projects, once per daemon run
 * (a failure is retried after a while). An entry already in config is left alone. */
function discover(slug: string): Promise<void> {
  if (slug in config.github.repos) return Promise.resolve();
  let p = discovering.get(slug);
  if (p) return p;
  p = (async () => {
    const [owner, name] = slug.split("/") as [string, string];
    const res = await runGh(["api", "graphql", "-f", `query=${LINKED_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`]);
    const nodes = res.out === undefined ? undefined : parseJson(res.out)?.data?.repository?.projectsV2?.nodes;
    if (!Array.isArray(nodes)) {
      console.log(`[github] ${slug}: could not list its projects (${res.note ?? "unexpected answer"})`);
      setTimeout(() => discovering.delete(slug), ERROR_TTL_MS).unref?.();
      return;
    }
    const projects = nodes.filter((n) => n && !n.closed && n.owner?.login).map((n) => `${n.owner.login}/${n.number}`);
    noteGithubRepo(slug, projects);
    console.log(`[github] ${slug}: ${projects.length ? `projects ${projects.join(", ")}` : "no linked projects"}; written to config`);
  })().catch(() => {});
  discovering.set(slug, p);
  return p;
}

// ---- project items ----

interface ProjectEntry {
  items?: GithubItem[];
  at: number;
  ok: boolean;
  note?: string;
  inflight?: Promise<void>;
}

const boards = new Map<string, ProjectEntry>();

/** Every issue and PR on a project ("owner/number"), cached. */
async function projectItems(ref: string): Promise<ProjectEntry> {
  let e = boards.get(ref);
  if (!e) boards.set(ref, (e = { at: 0, ok: false }));
  if (e.inflight) await e.inflight;
  else if (!e.at || Date.now() - e.at >= (e.ok ? TTL_MS : ERROR_TTL_MS)) {
    const entry = e;
    entry.inflight = fetchProject(ref)
      .then((r) => {
        entry.at = Date.now();
        entry.ok = !!r.items;
        entry.note = r.note;
        if (r.items) entry.items = r.items;
      })
      .finally(() => (entry.inflight = undefined));
    await entry.inflight;
  }
  return e;
}

async function fetchProject(ref: string): Promise<{ items?: GithubItem[]; note?: string }> {
  const m = /^([^/\s]+)\/(\d+)$/.exec(ref.trim());
  if (!m) return { note: `"${ref}" is not owner/number` };
  const items: GithubItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = ["api", "graphql", "-f", `query=${ITEMS_QUERY}`, "-F", `owner=${m[1]}`, "-F", `number=${m[2]}`];
    if (cursor) args.push("-f", `endCursor=${cursor}`);
    const res = await runGh(args, PAGE_TIMEOUT_MS);
    if (res.out === undefined) {
      console.log(`[github] project ${ref}: ${res.note}`);
      return { note: res.note };
    }
    const project = parseJson(res.out)?.data?.repositoryOwner?.projectV2;
    if (!project) return { note: `project ${ref} not found` };
    for (const node of project.items?.nodes ?? []) {
      const item = fromProjectNode(node, project.title);
      if (item) items.push(item);
    }
    if (!project.items?.pageInfo?.hasNextPage) break;
    cursor = project.items.pageInfo.endCursor;
  }
  return { items };
}

// GitHub's answers, read loosely: a field it drops is a missing value, not a crash.
type Loose = any;

export function fromProjectNode(node: Loose, project: string): GithubItem | undefined {
  const c = node?.content;
  if (!c || typeof c.number !== "number" || !c.repository?.nameWithOwner) return undefined; // a draft
  const fields: GithubItem["fields"] = [];
  for (const v of node.fieldValues?.nodes ?? []) {
    const name = v?.field?.name;
    const value = v?.name ?? v?.text ?? v?.date ?? v?.title ?? (typeof v?.number === "number" ? String(v.number) : undefined);
    if (name && name !== "Title" && value) fields.push({ name, value: String(value) });
  }
  const pr = c.__typename === "PullRequest";
  const state = String(c.state ?? "").toLowerCase();
  return {
    repo: c.repository.nameWithOwner,
    number: c.number,
    kind: pr ? "pr" : "issue",
    state: pr && c.isDraft && state === "open" ? "draft" : state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    title: c.title ?? "",
    url: c.url ?? "",
    body: clip(c.body),
    labels: (c.labels?.nodes ?? []).map((l: Loose) => l?.name).filter(Boolean),
    assignees: (c.assignees?.nodes ?? []).map((a: Loose) => a?.login).filter(Boolean),
    project,
    fields,
  };
}

// ---- one repo's own issue or PR ----

const single = new Map<string, { item?: GithubItem; at: number; ok: boolean }>();

/** `owner/name#n` straight from the repo, for repos (or numbers) no project covers. */
async function repoItem(slug: string, n: number): Promise<GithubItem | undefined> {
  const key = `${slug}#${n}`;
  const hit = single.get(key);
  if (hit && Date.now() - hit.at < (hit.ok ? TTL_MS : ERROR_TTL_MS)) return hit.item;
  const res = await runGh(["api", `repos/${slug}/issues/${n}`]);
  const r = res.out === undefined ? undefined : parseJson(res.out);
  // A 404 is an answer ("no such number"), worth caching like a hit.
  const item = r && typeof r.number === "number" ? fromRestIssue(slug, r) : undefined;
  single.set(key, { item, at: Date.now(), ok: !!item || /not found/i.test(res.note ?? "") });
  return item;
}

export function fromRestIssue(slug: string, r: Loose): GithubItem {
  const pr = !!r.pull_request;
  return {
    repo: slug,
    number: r.number,
    kind: pr ? "pr" : "issue",
    state: pr && r.pull_request?.merged_at ? "merged" : r.state === "closed" ? "closed" : pr && r.draft ? "draft" : "open",
    title: r.title ?? "",
    url: r.html_url ?? "",
    body: clip(r.body),
    labels: (r.labels ?? []).map((l: Loose) => (typeof l === "string" ? l : l?.name)).filter(Boolean),
    assignees: (r.assignees ?? []).map((a: Loose) => a?.login).filter(Boolean),
    fields: [],
  };
}

function parseJson(s: string): Loose {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function clip(body: unknown): string {
  const s = typeof body === "string" ? body.replace(/\r\n/g, "\n").trim() : "";
  return s.length > BODY_CHARS ? s.slice(0, BODY_CHARS).trimEnd() + "…" : s;
}

// ---- resolving a mention ----

/** The session's GitHub repos, the one it was started in first. */
async function sessionSlugs(sessionId: string): Promise<string[]> {
  const cwd = db.getSession(sessionId)?.cwd;
  const home = cwd ? await git.getRepoState(cwd) : undefined;
  const repos = [...(home ? [home] : []), ...git.getSessionRepos(sessionId)];
  return [...new Set(repos.map((r) => githubSlug(r.remoteUrl)).filter((s): s is string => !!s))];
}

/**
 * What `#n` means in this session: every match across its repos and their projects, the most
 * likely first. With `pick`, a model settles a tie from `context` (the terminal text around the
 * mention); without it a tie comes back `ambiguous`, so the card can draw before the model answers.
 */
export async function resolveRef(sessionId: string, n: number, context: string, pick: boolean): Promise<GithubRef> {
  const slugs = await sessionSlugs(sessionId);
  if (!slugs.length) return { items: [], note: "this session is not in a GitHub repo" };
  await Promise.all(slugs.map(discover));
  const refs = [...new Set(slugs.flatMap((s) => config.github.repos[s]?.projects ?? []))];
  const boardsRead = await Promise.all(refs.map(projectItems));
  const onBoards = boardsRead.flatMap((b) => b.items ?? []).filter((it) => it.number === n);
  const same = (it: GithubItem, slug: string) => it.repo.toLowerCase() === slug.toLowerCase();

  const items: GithubItem[] = [];
  for (const slug of slugs) {
    const it = onBoards.find((b) => same(b, slug)) ?? (await repoItem(slug, n));
    if (it) items.push(it);
  }
  for (const it of onBoards) if (!items.some((x) => same(x, it.repo))) items.push(it);

  const failed = boardsRead.find((b) => !b.ok && b.note)?.note;
  if (!items.length) return { items, note: failed ? `nothing numbered #${n} found (${failed})` : `nothing numbered #${n} in ${[...slugs, ...refs.map((r) => `project ${r}`)].join(", ")}` };
  if (items.length === 1) return { items, pick: "only" };
  if (!pick) return { items, pick: "guess", ambiguous: true };
  return pickOne(items, slugs, n, context);
}

const picks = new Map<string, number>();

async function pickOne(items: GithubItem[], slugs: string[], n: number, context: string): Promise<GithubRef> {
  const text = context.slice(-CONTEXT_CHARS);
  const key = `${n}\n${items.map((i) => i.repo).join(",")}\n${text}`;
  let at = picks.get(key);
  if (at === undefined) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PICK_TIMEOUT_MS);
    try {
      const answer = await askBackend(PICK_SYSTEM, pickPrompt(items, slugs, n, text), ctrl.signal, config.github.pickModel);
      const k = Number(/\d+/.exec(answer ?? "")?.[0]);
      if (k >= 1 && k <= items.length) at = k - 1;
    } catch (e) {
      return { items, pick: "guess", note: `could not ask the model: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
    if (at === undefined) return { items, pick: "guess", note: "the model gave no usable answer" };
    picks.set(key, at);
    if (picks.size > PICKS_KEPT) picks.delete(picks.keys().next().value!);
  }
  return { items: [items[at]!, ...items.filter((_, i) => i !== at)], pick: "model" };
}

const PICK_SYSTEM = `You match a reference like "#157" in a coding session's terminal output to the GitHub issue or pull request it means. Several repositories have an item with that number. Read the text around the reference and the candidates, then answer with the candidate's position in the list (just the number, nothing else). When the text gives no clue, answer 1: the session's own repository comes first.`;

function pickPrompt(items: GithubItem[], slugs: string[], n: number, text: string): string {
  const lines = items.map((it, i) => {
    const fields = it.fields.map((f) => `${f.name}: ${f.value}`).join(", ");
    return `${i + 1}. ${it.repo}#${it.number} (${it.kind}, ${it.state}): ${it.title}${fields ? ` — ${fields}` : ""}`;
  });
  return `The session works in: ${slugs.join(", ")}\n\nText around #${n}:\n"""\n${text}\n"""\n\nCandidates:\n${lines.join("\n")}`;
}

/** Tests: forget every cache. */
export function reset(): void {
  discovering.clear();
  boards.clear();
  single.clear();
  picks.clear();
}
