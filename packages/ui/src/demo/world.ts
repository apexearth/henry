// A morning's worth of made-up work, for `?demo` (see ./install.ts). Everything the panels
// read is here: sessions on two machines, the repos they touched, flags, an open ask, usage,
// the overseer's playbook and your own day. Times are relative to now so the "4m" labels and
// the sparklines read the same whenever the page is opened.
import {
  DEFAULT_CONFIG,
  minutesFromPrompts,
  packDay,
  startOfDay,
  type Attention,
  type ChangedFile,
  type FederationStatus,
  type Flag,
  type HenryConfig,
  type HenryEvent,
  type History,
  type HumanDay,
  type HumanStats,
  type PeerStatus,
  type PhoneStatus,
  type PlaybookEntry,
  type RepoPickerEntry,
  type RepoPrs,
  type RepoState,
  type Session,
  type SessionFiles,
  type StateSnapshot,
  type Usage,
} from "@henry/shared";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const NOW = Date.now();
const ago = (ms: number) => NOW - ms;

export const HOST = "studio";
export const PEER = "laptop";
export const ROOT = "/Users/sam/code";
export const ATLAS = `${ROOT}/atlas`;
export const WEB = `${ROOT}/atlas-web`;
export const INFRA = `${ROOT}/infra`;
export const DOCS = `${ROOT}/docs`;

/** Prompt timestamps: `gaps` in minutes, newest first, back from `from`. */
function prompts(from: number, gaps: number[]): number[] {
  const out: number[] = [];
  let t = from;
  for (const g of gaps) {
    out.push(t);
    t -= g * MIN;
  }
  return out.sort((a, b) => a - b);
}

export const sessions: Session[] = [
  {
    id: "d1", claudeSessionId: "5b1e0c2a-rate", cwd: ATLAS, title: "rate limiter", createdAt: ago(2 * HOUR + 50 * MIN),
    status: "running", kind: "claude", pid: 48213, host: HOST,
    activity: "working", activitySince: ago(3 * MIN), lastInputAt: ago(3 * MIN),
    prompts: prompts(ago(3 * MIN), [4, 6, 3, 2, 9, 5, 4, 11, 3, 3, 7, 6, 14, 4, 5, 8, 6, 3, 12, 5, 4]),
  },
  {
    id: "d2", claudeSessionId: "8c4d9e10-e2e", cwd: WEB, title: "flaky e2e", createdAt: ago(1 * HOUR + 40 * MIN),
    status: "running", kind: "claude", pid: 48790, host: HOST,
    activity: "needsInput", activitySince: ago(2 * MIN), lastInputAt: ago(9 * MIN),
    prompts: prompts(ago(9 * MIN), [7, 5, 12, 6, 4, 18, 9, 5, 6]),
  },
  {
    id: "d3", claudeSessionId: "2f7a6b33-tf", cwd: INFRA, title: "terraform drift", createdAt: ago(4 * HOUR + 5 * MIN),
    status: "running", kind: "claude", pid: 47102, host: HOST,
    activity: "waiting", activitySince: ago(24 * MIN), lastInputAt: ago(31 * MIN),
    prompts: prompts(ago(31 * MIN), [22, 9, 6, 41, 8, 5, 5, 13, 7]),
  },
  {
    id: "d4", cwd: ATLAS, title: "atlas", createdAt: ago(50 * MIN), status: "running", kind: "shell", pid: 49011, host: HOST,
  },
  {
    id: "d5", claudeSessionId: "c0ffee11-bun", cwd: WEB, title: "migrate to bun", createdAt: ago(6 * HOUR + 20 * MIN),
    status: "exited", exitCode: 0, endedAt: ago(3 * HOUR + 10 * MIN), kind: "claude", host: HOST,
  },
  {
    id: "d6", claudeSessionId: "77ab12cd-docs", cwd: DOCS, title: "docs sweep", createdAt: ago(2 * HOUR + 15 * MIN),
    status: "running", kind: "claude", pid: 3120, host: PEER, peer: PEER,
    activity: "idle", activitySince: ago(68 * MIN), lastInputAt: ago(71 * MIN),
    prompts: prompts(ago(71 * MIN), [6, 9, 4, 12, 7]),
  },
];

const atlas: RepoState = {
  path: ATLAS, name: "atlas", branch: "feat/rate-limits", head: "3f9c2e1a7d4b8e0c5f6a9b2d1e3c4f5a6b7c8d9e",
  upstream: "origin/feat/rate-limits", remoteUrl: "https://github.com/sam/atlas",
  ahead: 2, behind: 0, dirty: 5, isWorktree: false, baseline: "a81d0f4c2b9e7d6f5a4c3b2e1d0f9a8b7c6d5e4f",
  commitsSinceBaseline: 2, lastCommitAt: ago(18 * MIN), openPrs: 3,
};
const web: RepoState = {
  path: WEB, name: "atlas-web", branch: "fix/e2e-retry", head: "9d2b7a4e1c3f5b6d8a0e2c4f6b8d0a2c4e6f8a0b",
  upstream: "origin/fix/e2e-retry", remoteUrl: "https://github.com/sam/atlas-web",
  ahead: 1, behind: 3, dirty: 3, isWorktree: false, baseline: "4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c8d0e2f",
  commitsSinceBaseline: 1, lastCommitAt: ago(41 * MIN), openPrs: 1,
};
const infra: RepoState = {
  path: INFRA, name: "infra", branch: "main", head: "7c1e9a0b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c",
  upstream: "origin/main", remoteUrl: "https://github.com/sam/infra",
  ahead: 1, behind: 0, dirty: 0, isWorktree: false, baseline: "1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c",
  commitsSinceBaseline: 1, lastCommitAt: ago(26 * MIN), openPrs: 0,
};
const docs: RepoState = {
  path: DOCS, name: "docs", branch: "main", head: "e2f4a6c8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0",
  upstream: "origin/main", remoteUrl: "https://github.com/sam/docs",
  ahead: 0, behind: 0, dirty: 2, isWorktree: false, baseline: "e2f4a6c8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0",
  commitsSinceBaseline: 0, lastCommitAt: ago(2 * DAY), openPrs: 0,
};

export const repos: Record<string, RepoState[]> = {
  d1: [atlas],
  d2: [web],
  d3: [infra],
  d4: [atlas],
  d5: [web],
  d6: [docs, atlas],
};

const cmd = (command: string, description?: string) => ({ tool_name: "Bash", tool_input: { command, description } });

export const events: HenryEvent[] = [
  { id: "e1", sessionId: "d3", ts: ago(26 * MIN), kind: "hook", hookEvent: "PostToolUse", toolName: "Bash", cwd: INFRA, repo: INFRA, severity: "alarm", rule: "commit-on-protected",
    payload: cmd('git commit -am "pin aws provider to 5.62"', "Commit the provider pin"), summary: '✓ Bash: git commit -am "pin aws provider to 5.62"' },
  { id: "e2", sessionId: "d6", ts: ago(58 * MIN), kind: "hook", hookEvent: "PreToolUse", toolName: "Write", cwd: DOCS, repo: ATLAS, severity: "notable", rule: "cross-repo-write",
    payload: { tool_name: "Write", tool_input: { file_path: `${ATLAS}/docs/rate-limits.md` } }, summary: `Write: ${ATLAS}/docs/rate-limits.md` },
  { id: "e3", sessionId: "d2", ts: ago(41 * MIN), kind: "hook", hookEvent: "PreToolUse", toolName: "Bash", cwd: WEB, repo: WEB, severity: "notable", rule: "command-notable",
    payload: cmd("git push -u origin fix/e2e-retry", "Push the branch"), summary: "Bash: git push -u origin fix/e2e-retry" },
  { id: "e4", sessionId: "d1", ts: ago(2 * HOUR + 45 * MIN), kind: "hook", hookEvent: "PreToolUse", toolName: "Bash", cwd: ATLAS, repo: ATLAS, severity: "notable", rule: "branch-churn",
    payload: cmd("git checkout -b feat/rate-limits", "Branch for the limiter"), summary: "Bash: git checkout -b feat/rate-limits" },
  { id: "e5", sessionId: "d1", ts: ago(3 * MIN), kind: "hook", hookEvent: "UserPromptSubmit", cwd: ATLAS, repo: ATLAS, severity: "info",
    payload: { prompt: "Make Retry-After exact, not a round minute." }, summary: "Prompt: Make Retry-After exact, not a round minute." },
];

export const flags: Flag[] = [
  { id: "f1", eventId: "e1", sessionId: "d3", ts: ago(26 * MIN), severity: "alarm", rule: "commit-on-protected", summary: '✓ Bash: git commit -am "pin aws provider to 5.62"', read: false },
  { id: "f2", eventId: "e2", sessionId: "d6", ts: ago(58 * MIN), severity: "notable", rule: "cross-repo-write", summary: `Write: ${ATLAS}/docs/rate-limits.md`, read: false },
  { id: "f3", eventId: "e3", sessionId: "d2", ts: ago(41 * MIN), severity: "notable", rule: "command-notable", summary: "Bash: git push -u origin fix/e2e-retry", read: true },
  { id: "f4", eventId: "e4", sessionId: "d1", ts: ago(2 * HOUR + 45 * MIN), severity: "notable", rule: "branch-churn", summary: "Bash: git checkout -b feat/rate-limits", read: true },
];

export const attention: Attention[] = [
  { id: "a1", sessionId: "d3", ts: ago(24 * MIN), message: "drift plan is ready, applying needs your OK", deadline: NOW + 36 * MIN },
];

export const usage: Usage = {
  fiveHour: { utilization: 0.42, resetsAt: NOW + 2 * HOUR + 10 * MIN },
  sevenDay: { utilization: 0.63, resetsAt: NOW + 3 * DAY + 4 * HOUR },
  hosts: {
    [HOST]: { fiveHour: { utilization: 0.42, resetsAt: NOW + 2 * HOUR + 10 * MIN }, sevenDay: { utilization: 0.63, resetsAt: NOW + 3 * DAY + 4 * HOUR }, updatedAt: ago(MIN) },
    [PEER]: { fiveHour: { utilization: 0.12, resetsAt: NOW + 4 * HOUR + 2 * MIN }, sevenDay: { utilization: 0.31, resetsAt: NOW + 5 * DAY + 9 * HOUR }, updatedAt: ago(6 * MIN) },
  },
  perSession: {
    d1: { inputTokens: 42_300, outputTokens: 31_800, cacheRead: 6_210_000, cacheWrite: 412_000, costUsd: 4.87, model: "claude-opus-5", contextTokens: 118_400, contextWindow: 200_000 },
    d2: { inputTokens: 18_100, outputTokens: 12_400, cacheRead: 2_140_000, cacheWrite: 168_000, costUsd: 1.92, model: "claude-opus-5", contextTokens: 64_900, contextWindow: 200_000 },
    d3: { inputTokens: 27_600, outputTokens: 19_200, cacheRead: 4_420_000, cacheWrite: 301_000, costUsd: 3.15, model: "claude-opus-5", contextTokens: 151_200, contextWindow: 200_000 },
    d5: { inputTokens: 61_000, outputTokens: 40_700, cacheRead: 9_810_000, cacheWrite: 720_000, costUsd: 7.4, model: "claude-opus-5", contextTokens: 172_000, contextWindow: 200_000 },
    d6: { inputTokens: 9_200, outputTokens: 6_100, cacheRead: 903_000, cacheWrite: 88_000, costUsd: 0.8, model: "claude-sonnet-5", contextTokens: 38_500, contextWindow: 200_000 },
  },
  updatedAt: ago(MIN),
};

export const playbook: PlaybookEntry[] = [
  {
    id: "p0", sessionId: "d1", ts: ago(3 * MIN), trigger: "stop", model: "claude-opus-5", kind: "summary",
    text: [
      "HEADLINE: Rate limiter written and green; wiring an exact Retry-After, then the full suite.",
      "DOING: Making the 429's Retry-After say when the next token lands, in `src/middleware/rateLimit.ts`.",
      "CHANGED:",
      "- new `src/middleware/rateLimit.ts` (token bucket per API key) and its test",
      "- `src/routes/search.ts` mounts it on /v1/search",
      "CAREFUL: on `feat/rate-limits`, 2 commits ahead of origin, 5 paths uncommitted. Nothing pushed yet.",
      "NEXT: `bun test`, commit, open the PR against main.",
    ].join("\n"),
  },
  {
    id: "p1", sessionId: "d1", ts: ago(3 * MIN), trigger: "stop", model: "claude-opus-5",
    text: [
      "HEADLINE: Middleware written, its four unit tests pass.",
      "DOING: Retry-After header on the 429.",
      "CHANGED:",
      "- `src/middleware/rateLimit.ts`, `src/middleware/rateLimit.test.ts` (new)",
      "- `src/routes/search.ts` (+4 −1)",
      "CAREFUL: none",
      "NEXT: full test run, then commit.",
    ].join("\n"),
  },
  {
    id: "p2", sessionId: "d1", ts: ago(2 * HOUR + 44 * MIN), trigger: "flag", model: "claude-opus-5",
    text: [
      "HEADLINE: Branched off main for the rate limiter.",
      "DOING: Reading the search route and the middleware that is already there.",
      "CHANGED: none",
      "CAREFUL: `git checkout -b feat/rate-limits` from a clean main. Fine.",
      "NEXT: write the bucket.",
    ].join("\n"),
  },
  {
    id: "p3", sessionId: null, ts: ago(2 * MIN), trigger: "stop", model: "claude-opus-5", kind: "summary",
    text: [
      "HEADLINE: Three sessions, two waiting on you: a permission prompt and a terraform apply.",
      "DOING:",
      "- rate limiter (atlas): Retry-After, tests green",
      "- flaky e2e (atlas-web): blocked on a permission prompt for a 25× playwright run",
      "- terraform drift (infra): committed a provider pin on main, asking before it applies",
      "CAREFUL: infra committed straight onto `main`; laptop's docs sweep wrote into atlas.",
      "NEXT: answer the two prompts; the rate limiter will want a PR in a few minutes.",
    ].join("\n"),
  },
];

export const config: HenryConfig = {
  ...DEFAULT_CONFIG,
  host: HOST,
  reposRoot: ROOT,
  defaultRepo: ROOT,
  overseer: { ...DEFAULT_CONFIG.overseer, onStop: true, onFlag: true },
};

export const peers: PeerStatus[] = [
  { name: PEER, fingerprint: "9f3a 1c77 04be d2e8 5a61 c0f9 7b23 e4d1", url: "ws://100.101.7.42:14712/fed", link: "connected", inbound: true, enabled: true, pairedAt: ago(12 * DAY), lastSeenAt: ago(5_000), sessions: 1 },
];

export const state: StateSnapshot = {
  sessions, repos, flags, attention, usage, playbook, config, firstRun: false, host: HOST, peers,
};

// ---- REST answers ----

const atlasFiles = [
  ".github/workflows/ci.yml", ".gitignore", "README.md", "package.json", "bun.lock", "tsconfig.json",
  "src/index.ts", "src/app.ts", "src/config.ts",
  "src/search/index.ts", "src/search/rank.ts", "src/search/tokenize.ts", "src/search/rank.test.ts",
  "src/routes/search.ts", "src/routes/health.ts", "src/routes/keys.ts",
  "src/middleware/auth.ts", "src/middleware/logging.ts", "src/middleware/rateLimit.ts", "src/middleware/rateLimit.test.ts",
  "src/db/client.ts", "src/db/migrations/001_init.sql", "src/db/migrations/002_api_keys.sql",
  "docs/api.md", "docs/rate-limits.md", "docs/bucket.svg", "docs/deploy.md",
  "test/helpers.ts", "test/search.e2e.test.ts",
];
const webFiles = [
  ".gitignore", "README.md", "package.json", "bun.lock", "playwright.config.ts", "vite.config.ts", "index.html",
  "src/main.tsx", "src/App.tsx", "src/api/cart.ts", "src/api/client.ts",
  "src/pages/Checkout.tsx", "src/pages/Search.tsx", "src/pages/Account.tsx",
  "src/components/Total.tsx", "src/components/PromoField.tsx",
  "e2e/checkout.spec.ts", "e2e/search.spec.ts", "e2e/fixtures.ts",
];
const infraFiles = [
  "README.md", "versions.tf", "main.tf", "variables.tf", "outputs.tf",
  "modules/api/main.tf", "modules/api/security.tf", "modules/api/variables.tf",
  "modules/lambda/main.tf", "modules/lambda/variables.tf",
  "envs/prod.tfvars", "envs/staging.tfvars",
];
const docsFiles = [
  "README.md", "getting-started.md", "install.md", "cli.md", "faq.md", "workspaces.md", "deploy/fly.md", "deploy/docker.md",
];

export const fileIndex: Record<string, string[]> = { [ATLAS]: atlasFiles, [WEB]: webFiles, [INFRA]: infraFiles, [DOCS]: docsFiles };

const atlasChanges: ChangedFile[] = [
  { path: "package.json", status: "M", mtime: ago(2 * HOUR + 30 * MIN) },
  { path: "src/routes/search.ts", status: "M", mtime: ago(40 * MIN) },
  { path: "src/middleware/rateLimit.ts", status: "?", mtime: ago(2 * MIN) },
  { path: "src/middleware/rateLimit.test.ts", status: "?", mtime: ago(14 * MIN) },
  { path: "docs/rate-limits.md", status: "?", mtime: ago(58 * MIN) },
];
const webChanges: ChangedFile[] = [
  { path: "src/pages/Checkout.tsx", status: "M", mtime: ago(4 * MIN) },
  { path: "e2e/checkout.spec.ts", status: "M", mtime: ago(30 * MIN) },
  { path: "src/api/cart.ts", status: "M", mtime: ago(12 * MIN) },
];
// infra's one change is committed already (the provider pin), so the tree has nothing to mark.
const infraChanges: ChangedFile[] = [];
const docsChanges: ChangedFile[] = [
  { path: "getting-started.md", status: "M", mtime: ago(65 * MIN) },
  { path: "workspaces.md", status: "M", mtime: ago(60 * MIN) },
];

export const sessionFiles: Record<string, SessionFiles> = {
  d1: { sessionId: "d1", repos: [{ path: ATLAS, name: "atlas", baseline: atlas.baseline!, files: atlasChanges }] },
  d2: { sessionId: "d2", repos: [{ path: WEB, name: "atlas-web", baseline: web.baseline!, files: webChanges }] },
  d3: { sessionId: "d3", repos: [{ path: INFRA, name: "infra", baseline: infra.baseline!, files: infraChanges }] },
  d4: { sessionId: "d4", repos: [{ path: ATLAS, name: "atlas", baseline: atlas.head, files: atlasChanges }] },
  d5: { sessionId: "d5", repos: [{ path: WEB, name: "atlas-web", baseline: web.baseline!, files: [] }] },
  d6: { sessionId: "d6", repos: [
    { path: DOCS, name: "docs", baseline: docs.baseline!, files: docsChanges },
    { path: ATLAS, name: "atlas", baseline: atlas.head, files: [{ path: "docs/rate-limits.md", status: "?", mtime: ago(58 * MIN) }] },
  ] },
};

export const prs: RepoPrs[] = [
  { repo: ATLAS, name: "atlas", slug: "sam/atlas", prs: [
    { number: 212, title: "Search: rank exact matches above prefix matches", author: "sam", draft: false, branch: "feat/exact-rank", url: "https://github.com/sam/atlas/pull/212", updatedAt: ago(3 * HOUR) },
    { number: 209, title: "API keys: rotate without downtime", author: "priya", draft: true, branch: "feat/key-rotation", url: "https://github.com/sam/atlas/pull/209", updatedAt: ago(DAY + 2 * HOUR) },
    { number: 204, title: "Bump bun to 1.4.2", author: "dependabot", draft: false, branch: "deps/bun-1.4.2", url: "https://github.com/sam/atlas/pull/204", updatedAt: ago(2 * DAY) },
  ] },
  { repo: WEB, name: "atlas-web", slug: "sam/atlas-web", prs: [
    { number: 88, title: "Checkout: wait for the cart before rendering the total", author: "sam", draft: true, branch: "fix/e2e-retry", url: "https://github.com/sam/atlas-web/pull/88", updatedAt: ago(41 * MIN) },
  ] },
  { repo: INFRA, name: "infra", slug: "sam/infra", prs: [] },
];

export const logs: Record<string, { sha: string; ts: number; subject: string }[]> = {
  [ATLAS]: [
    { sha: "3f9c2e1", ts: ago(18 * MIN), subject: "Read the rate limit from config, not the route" },
    { sha: "b72d0a9", ts: ago(HOUR + 2 * MIN), subject: "Rank: stop counting stop words twice" },
  ],
  [WEB]: [{ sha: "9d2b7a4", ts: ago(41 * MIN), subject: "Playwright: repeat-each on CI, trace on first retry" }],
  [INFRA]: [{ sha: "7c1e9a0", ts: ago(26 * MIN), subject: "pin aws provider to 5.62" }],
  [DOCS]: [],
};

export const diffs: Record<string, string> = {
  [ATLAS]: `diff --git a/src/routes/search.ts b/src/routes/search.ts
index 4c1d2e3..9a8b7c6 100644
--- a/src/routes/search.ts
+++ b/src/routes/search.ts
@@ -9,10 +9,13 @@ import { Router } from "express";
 import { search } from "../search";
+import { rateLimit } from "../middleware/rateLimit";
 import { requireKey } from "../middleware/auth";

 export const router = Router();

-router.get("/v1/search", requireKey, handler);
+// 60 a minute per key; the bucket sets Retry-After itself.
+router.get("/v1/search", requireKey, rateLimit({ perMinute: 60 }), handler);

 async function handler(req: Request, res: Response) {
diff --git a/src/middleware/rateLimit.ts b/src/middleware/rateLimit.ts
new file mode 100644
index 0000000..e1f2a3b
--- /dev/null
+++ b/src/middleware/rateLimit.ts
@@ -0,0 +1,27 @@
+// Token bucket per API key. One bucket per key in memory: this service runs as one process,
+// and a limit that is a little generous across a restart is fine.
+import type { NextFunction, Request, Response } from "express";
+
+interface Bucket {
+  tokens: number;
+  at: number;
+}
+
+export function rateLimit({ perMinute }: { perMinute: number }) {
+  const buckets = new Map<string, Bucket>();
+  const rate = perMinute / 60_000;
+  return (req: Request, res: Response, next: NextFunction) => {
+    const key = req.apiKey!.id;
+    const now = Date.now();
+    const b = buckets.get(key) ?? { tokens: perMinute, at: now };
+    b.tokens = Math.min(perMinute, b.tokens + (now - b.at) * rate);
+    b.at = now;
+    if (b.tokens < 1) {
+      res.set("Retry-After", String(Math.ceil((1 - b.tokens) / rate / 1000)));
+      return res.status(429).json({ error: "rate limited" });
+    }
+    b.tokens -= 1;
+    buckets.set(key, b);
+    next();
+  };
+}
`,
};

/** The one picture in the demo: the diagram the rate-limits page links to. */
export const BUCKET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="260" viewBox="0 0 420 260" font-family="system-ui, sans-serif" font-size="13">
  <rect width="420" height="260" fill="#1a1f27"/>
  <path d="M120 60 L135 220 L285 220 L300 60 Z" fill="#242b36" stroke="#8aa4c8" stroke-width="2"/>
  <rect x="139" y="130" width="142" height="88" fill="#3b82f6" opacity=".55"/>
  <g fill="#f5c451"><circle cx="210" cy="30" r="6"/><circle cx="196" cy="14" r="4" opacity=".6"/><circle cx="226" cy="10" r="3" opacity=".4"/></g>
  <path d="M210 38 v14" stroke="#f5c451" stroke-width="2"/>
  <text x="210" y="248" fill="#c9d1d9" text-anchor="middle">60 tokens / minute, one per request</text>
  <text x="318" y="70" fill="#8b949e">capacity 60</text>
  <text x="318" y="176" fill="#8b949e">now: 37</text>
  <path d="M100 190 h16 m-6 -6 l6 6 l-6 6" stroke="#ef6b73" stroke-width="2" fill="none"/>
  <text x="8" y="176" fill="#ef6b73">429 when empty</text>
</svg>
`;

export const peek: Record<string, string> = {
  [`${ATLAS}/src/middleware/rateLimit.ts`]: `// Token bucket per API key. One bucket per key in memory: this service runs as one process,
// and a limit that is a little generous across a restart is fine.
import type { NextFunction, Request, Response } from "express";

interface Bucket {
  tokens: number;
  at: number;
}

export function rateLimit({ perMinute }: { perMinute: number }) {
  const buckets = new Map<string, Bucket>();
  const rate = perMinute / 60_000;
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.apiKey!.id;
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + (now - b.at) * rate);
    b.at = now;
    if (b.tokens < 1) {
      res.set("Retry-After", String(Math.ceil((1 - b.tokens) / rate / 1000)));
      return res.status(429).json({ error: "rate limited" });
    }
    b.tokens -= 1;
    buckets.set(key, b);
    next();
  };
}
`,
};

export const histories: Record<string, History> = {
  d1: { sessionId: "d1", complete: true, turns: [
    { uuid: "t1", at: ago(2 * HOUR + 48 * MIN), role: "user", blocks: [{ kind: "text", text: "Put a token-bucket rate limiter in front of /v1/search: per API key, 60 a minute, 429 with a Retry-After. Tests too." }] },
    { uuid: "t2", at: ago(2 * HOUR + 47 * MIN), role: "assistant", model: "claude-opus-5", blocks: [
      { kind: "text", text: "I'll look at how the search route is wired before adding anything." },
      { kind: "tool", name: "Read", text: "src/routes/search.ts" },
      { kind: "result", text: "142 lines" },
      { kind: "tool", name: "Grep", text: "app.use( in src" },
      { kind: "result", text: "6 files" },
      { kind: "tool", name: "Write", text: "src/middleware/rateLimit.ts" },
      { kind: "tool", name: "Edit", text: "src/routes/search.ts" },
      { kind: "tool", name: "Bash", text: "bun test src/middleware" },
      { kind: "result", text: "4 pass\n0 fail\nRan 4 tests across 1 file. [318.00ms]" },
      { kind: "text", text: "The middleware is in and its four tests pass. The 429 currently says Retry-After: 60, which is the round minute, not the truth." },
    ] },
    { uuid: "t3", at: ago(3 * MIN), role: "user", blocks: [{ kind: "text", text: "Make Retry-After exact, not a round minute." }] },
    { uuid: "t4", at: ago(2 * MIN), role: "assistant", model: "claude-opus-5", blocks: [
      { kind: "text", text: "The bucket knows when its next token lands, so Retry-After can be exact rather than a round minute. Wiring that through the 429 now, then I'll run the whole suite." },
      { kind: "tool", name: "Edit", text: "src/middleware/rateLimit.ts" },
    ] },
  ] },
};

export const federation: FederationStatus = {
  name: HOST, fingerprint: "1e4b 8d20 c3a7 f915 6b0d e2c8 4a71 93f6",
  listening: { address: "100.98.3.17", port: 14712 }, peers,
};

export const phone: PhoneStatus = {
  listening: { address: "100.98.3.17", port: 14714, secure: true, certName: "studio.tail3f9a.ts.net" },
  url: "https://studio.tail3f9a.ts.net:14714/",
  devices: [{ id: "ph1", name: "iPhone · Safari", grantedAt: ago(9 * DAY), lastSeenAt: ago(3 * HOUR) }],
};

export const repoPicker: RepoPickerEntry[] = [
  { path: ATLAS, name: "atlas", isWorktree: false },
  { path: WEB, name: "atlas-web", isWorktree: false },
  { path: DOCS, name: "docs", isWorktree: false },
  { path: INFRA, name: "infra", isWorktree: false },
  { path: `${ROOT}/scratch`, name: "scratch", isWorktree: false, folder: true },
];

/** Your day: every Claude prompt above, plus a fortnight of made-up days behind it. */
export function human(): HumanStats {
  const dayStart = startOfDay(NOW);
  const today = sessions.flatMap((s) => s.prompts ?? []).filter((t) => t >= dayStart).sort((a, b) => a - b);
  const minutes = minutesFromPrompts(today, NOW);
  // Reading minutes around the prompts: the window was open the whole time.
  for (const [m] of [...minutes]) minutes.set(m + MIN, (minutes.get(m + MIN) ?? 0) | 4);
  const days: HumanDay[] = [];
  const shape = [0, 3.2, 4.1, 2.6, 5.0, 3.8, 0, 0, 2.9, 4.4, 3.5, 4.8, 1.2, 0];
  for (let i = 13; i >= 1; i--) {
    const hours = shape[13 - i]!;
    const d = new Date(dayStart);
    d.setDate(d.getDate() - i);
    days.push({ dayStart: d.getTime(), prompts: Math.round(hours * 11), activeMs: hours * HOUR, readingMs: hours * HOUR * 0.38, longestMs: Math.min(hours, 2.4) * HOUR, stretches: hours ? Math.ceil(hours / 2) : 0, sessions: hours ? Math.ceil(hours / 1.5) : 0 });
  }
  days.push({ dayStart, prompts: today.length, activeMs: minutes.size * MIN, readingMs: 0, longestMs: 0, stretches: 1, sessions: 4 });
  return { dayStart, today, todayMinutes: packDay(dayStart, minutes), days, since: dayStart - 13 * DAY, idleMs: 15 * MIN };
}
