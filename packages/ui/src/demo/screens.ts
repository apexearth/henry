// What each demo session's terminal shows: Claude Code's TUI mid-turn, drawn with plain ANSI
// so xterm renders it like the real thing. Rendered per attach at the terminal's own width, and
// padded from the top so the prompt box sits on the bottom row as it would in a live session.

const E = "\x1b[";
const R = `${E}0m`;
const dim = (s: string) => `${E}2m${s}${E}22m`;
const bold = (s: string) => `${E}1m${s}${E}22m`;
const fg = (n: number, s: string) => `${E}38;5;${n}m${s}${E}39m`;
const bg = (n: number, s: string) => `${E}48;5;${n}m${s}${E}49m`;

const ORANGE = 173, GREEN = 114, RED = 167, BLUE = 110, GREY = 245, PURPLE = 140;

const bullet = (s: string) => `${fg(GREEN, "●")} ${s}`;
const tool = (name: string, arg: string) => bullet(`${bold(name)}(${arg})`);
const res = (s: string) => `  ${fg(GREY, "⎿")}  ${dim(s)}`;
const more = (s: string) => `     ${dim(s)}`;
const user = (s: string) => `${fg(GREY, ">")} ${s}`;
const add = (n: number, s: string) => `       ${dim(String(n).padStart(3))} ${bg(22, fg(GREEN, `+ ${s}`))}`;
const del = (n: number, s: string) => `       ${dim(String(n).padStart(3))} ${bg(52, fg(RED, `- ${s}`))}`;
const ctx = (n: number, s: string) => `       ${dim(String(n).padStart(3))}   ${s}`;

/** The banner Claude Code prints on start. */
function banner(cwd: string): string[] {
  return [
    `${fg(ORANGE, " ▐▛███▜▌")}   ${bold("Claude Code")} ${dim("v2.1.34")}`,
    `${fg(ORANGE, "▝▜█████▛▘")}  ${dim("Opus 5 · Claude Max")}`,
    `${fg(ORANGE, "  ▘▘ ▝▝")}    ${dim(cwd)}`,
    "",
  ];
}

/** The prompt box: a rule, the input line, a rule, the status line. */
function promptBox(cols: number, status: string, typed = ""): string[] {
  const rule = dim("─".repeat(cols));
  return [rule, `${fg(GREY, ">")} ${typed}`, rule, `  ${dim(status)}`];
}

/** Word-wrap prose to the width, keeping the two-space hang under a bullet. */
function wrap(text: string, cols: number, indent = "  "): string[] {
  const words = text.split(" ");
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > cols - indent.length - 1) {
      out.push(line);
      line = w;
    } else line = line ? line + " " + w : w;
  }
  if (line) out.push(line);
  return out.map((l, i) => (i ? indent + l : l));
}

const say = (text: string, cols: number) => wrap(text, cols).map((l, i) => (i ? l : bullet(l)));

function rateLimiter(cols: number): string[] {
  return [
    ...banner("~/code/atlas"),
    user("Put a token-bucket rate limiter in front of /v1/search: per API key, 60 a minute, 429 with a Retry-After. Tests too."),
    "",
    ...say("I'll look at how the search route is wired before adding anything.", cols),
    "",
    tool("Read", "src/routes/search.ts"),
    res("Read 142 lines"),
    "",
    tool("Search", 'pattern: "app.use(", path: "src"'),
    res("Found 6 files"),
    more("src/app.ts"),
    more("src/middleware/auth.ts"),
    more("src/middleware/logging.ts"),
    more("… 3 more"),
    "",
    tool("Read", "src/middleware/auth.ts"),
    res("Read 54 lines"),
    "",
    ...say("Auth already puts the key on `req.apiKey`, so the bucket can hang off that. Same shape as the logging middleware: a factory that returns the handler.", cols),
    "",
    tool("Write", "src/middleware/rateLimit.ts"),
    res("Wrote 71 lines to src/middleware/rateLimit.ts"),
    "",
    tool("Update", "src/routes/search.ts"),
    res("Updated src/routes/search.ts with 4 additions and 1 removal"),
    ctx(10, 'import { Router } from "express";'),
    ctx(11, 'import { search } from "../search";'),
    add(12, 'import { rateLimit } from "../middleware/rateLimit";'),
    ctx(13, ""),
    del(14, 'router.get("/v1/search", requireKey, handler);'),
    add(14, "// 60 a minute per key; the bucket sets Retry-After itself."),
    add(15, 'router.get("/v1/search", requireKey, rateLimit({ perMinute: 60 }), handler);'),
    "",
    tool("Write", "src/middleware/rateLimit.test.ts"),
    res("Wrote 58 lines to src/middleware/rateLimit.test.ts"),
    "",
    tool("Bash", "bun test src/middleware"),
    res(`${fg(GREEN, "4 pass")}`),
    more("0 fail"),
    more("Ran 4 tests across 1 file. [318.00ms]"),
    "",
    ...say("The middleware is in and its four tests pass. The 429 currently says Retry-After: 60, which is the round minute, not the truth.", cols),
    "",
    user("Make Retry-After exact, not a round minute."),
    "",
    ...say("The bucket knows when its next token lands, so Retry-After can be exact rather than a round minute. Wiring that through the 429 now, then I'll run the whole suite.", cols),
    "",
    tool("Update", "src/middleware/rateLimit.ts"),
    res("Updated src/middleware/rateLimit.ts with 3 additions and 1 removal"),
    "",
    `${fg(ORANGE, "✻")} ${fg(ORANGE, "Crunching…")} ${dim("(47s · ↓ 2.1k tokens · esc to interrupt)")}`,
    "",
    ...promptBox(cols, "⏵⏵ accept edits on (shift+tab to cycle)"),
  ];
}

/** Printed width: the escapes take no cells. */
const visible = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "").length;

function flakyE2e(cols: number): string[] {
  const w = Math.min(cols - 2, 86);
  const box = (s: string) => `${fg(BLUE, "│")} ${s}${" ".repeat(Math.max(0, w - 4 - visible(s)))} ${fg(BLUE, "│")}`;
  return [
    ...banner("~/code/atlas-web"),
    user("The checkout e2e fails one run in five on CI. Find out why and fix it properly, not with a retry."),
    "",
    tool("Read", "e2e/checkout.spec.ts"),
    res("Read 96 lines"),
    "",
    tool("Read", "e2e/fixtures.ts"),
    res("Read 44 lines"),
    "",
    tool("Search", 'pattern: "promo", path: "src"'),
    res("Found 3 files"),
    more("src/pages/Checkout.tsx"),
    more("src/components/PromoField.tsx"),
    more("src/api/cart.ts"),
    "",
    tool("Bash", "bunx playwright test e2e/checkout.spec.ts --repeat-each 10"),
    res("Running 10 tests using 4 workers"),
    more(`${fg(GREEN, "8 passed")}, ${fg(RED, "2 failed")}`),
    more(`${fg(RED, "✘")} checkout › applies a promo code (3.2s)`),
    more(`  Error: expect(locator).toHaveText("$81.00") — received "$90.00"`),
    "",
    ...say("The promo code is applied after the total is asserted: the assert races the cart fetch. The fix belongs in the page, not the test. The total should not render until the cart query has settled.", cols),
    "",
    tool("Read", "src/pages/Checkout.tsx"),
    res("Read 210 lines"),
    "",
    tool("Update", "src/pages/Checkout.tsx"),
    res("Updated src/pages/Checkout.tsx with 2 additions and 1 removal"),
    ctx(74, "const { data: cart, isPending } = useCart();"),
    del(75, "return <Total cents={cart?.total ?? 0} />;"),
    add(75, "if (isPending) return <TotalSkeleton />;"),
    add(76, "return <Total cents={cart.total} />;"),
    "",
    tool("Update", "src/api/cart.ts"),
    res("Updated src/api/cart.ts with 1 addition and 1 removal"),
    "",
    ...say("Now the same spec 25 times. If the race is what I think it is, this is the run that proves it.", cols),
    "",
    `${fg(BLUE, "╭" + "─".repeat(w - 2) + "╮")}`,
    box(bold("Bash command")),
    box(""),
    box("  bunx playwright test e2e/checkout.spec.ts --repeat-each 25"),
    box(dim("  Re-run the checkout spec 25 times to confirm the fix")),
    box(""),
    box("Do you want to proceed?"),
    box(`${fg(BLUE, "❯")} 1. Yes`),
    box("  2. Yes, and don't ask again for bunx playwright commands in atlas-web"),
    box("  3. No, and tell Claude what to do differently (esc)"),
    `${fg(BLUE, "╰" + "─".repeat(w - 2) + "╯")}`,
  ];
}

function terraformDrift(cols: number): string[] {
  return [
    ...banner("~/code/infra"),
    user("Compare what's in prod against main and tell me what drifted. Don't apply anything."),
    "",
    tool("Bash", "git status -sb && git log --oneline -3"),
    res("## main...origin/main"),
    more("1a3c5e7 lambda: nightly cleanup at 03:00 UTC"),
    more("c9d1f2a api: allow the bastion on 5432"),
    more("4b8e0a6 provider bumps"),
    "",
    tool("Read", "envs/prod.tfvars"),
    res("Read 31 lines"),
    "",
    tool("Bash", "terraform plan -no-color -lock=false -var-file=envs/prod.tfvars"),
    res("Refreshing state... 41 resources"),
    more("~ aws_security_group.api"),
    more("~ aws_lambda_function.cleanup"),
    more(bold("Plan: 0 to add, 2 to change, 0 to destroy.")),
    "",
    ...say("Two things drifted:", cols),
    `  ${fg(GREY, "-")} ${bold("aws_security_group.api")}: someone opened 0.0.0.0/0 on 5432 by hand. main has it closed.`,
    `  ${fg(GREY, "-")} ${bold("aws_lambda_function.cleanup")}: memory is 512 in prod, 256 in main.`,
    "",
    ...wrap("The first should go back to main's version today. The second is probably prod being right and main being wrong: 256 was OOMing in June, and the bump was done in the console.", cols).map((l) => "  " + l.trimStart()),
    "",
    user("Fix main for the lambda and pin the provider while you're in there. Then wait for me on the apply."),
    "",
    tool("Update", "modules/lambda/main.tf"),
    res("Updated modules/lambda/main.tf with 1 addition and 1 removal"),
    "",
    tool("Update", "versions.tf"),
    res("Updated versions.tf with 1 addition and 1 removal"),
    "",
    tool("Bash", 'git commit -am "pin aws provider to 5.62"'),
    res("[main 7c1e9a0] pin aws provider to 5.62"),
    more(" 2 files changed, 2 insertions(+), 2 deletions(-)"),
    "",
    tool("henry_attention", 'message: "drift plan is ready, applying needs your OK", minutes: 60'),
    res("waiting for you"),
    "",
    ...say("Ready when you are. Say \"apply\" and I'll close 5432 and leave the lambda's memory where prod has it.", cols),
    "",
    ...promptBox(cols, "? for shortcuts"),
  ];
}

function shell(): string[] {
  const p = `${fg(GREEN, "sam@studio")} ${fg(BLUE, "atlas")} ${fg(PURPLE, "feat/rate-limits")} ${fg(GREY, "%")} `;
  return [
    `${p}git status -sb`,
    `## feat/rate-limits...origin/feat/rate-limits [ahead 2]`,
    ` ${fg(RED, "M")} package.json`,
    ` ${fg(RED, "M")} src/routes/search.ts`,
    `${fg(RED, "??")} docs/rate-limits.md`,
    `${fg(RED, "??")} src/middleware/rateLimit.test.ts`,
    `${fg(RED, "??")} src/middleware/rateLimit.ts`,
    `${p}bun test`,
    `bun test v1.4.2 (7a9c1e3b)`,
    "",
    `src/middleware/rateLimit.test.ts:`,
    `${fg(GREEN, "✓")} rateLimit > lets 60 through in a minute ${dim("[3.12ms]")}`,
    `${fg(GREEN, "✓")} rateLimit > the 61st gets a 429 ${dim("[0.88ms]")}`,
    `${fg(GREEN, "✓")} rateLimit > Retry-After says when the next token lands ${dim("[1.04ms]")}`,
    `${fg(GREEN, "✓")} rateLimit > keys are independent ${dim("[0.71ms]")}`,
    "",
    `src/search/rank.test.ts:`,
    `${fg(GREEN, "✓")} rank > exact beats prefix ${dim("[0.40ms]")}`,
    `${fg(GREEN, "✓")} rank > stop words count once ${dim("[0.22ms]")}`,
    `${fg(GREEN, "✓")} rank > ties break on recency ${dim("[0.19ms]")}`,
    "",
    `test/search.e2e.test.ts:`,
    `${fg(GREEN, "✓")} search > 200 with a key ${dim("[41.10ms]")}`,
    `${fg(GREEN, "✓")} search > 401 without ${dim("[2.90ms]")}`,
    `${fg(GREEN, "✓")} search > 429 after 60 ${dim("[88.02ms]")}`,
    "",
    ` ${fg(GREEN, "31 pass")}`,
    ` 0 fail`,
    `Ran 31 tests across 6 files. ${dim("[1.42s]")}`,
    `${p}`,
  ];
}

function migrateToBun(cols: number): string[] {
  return [
    ...banner("~/code/atlas-web"),
    user("Move this repo from yarn to bun. Lockfile, scripts, CI, the Dockerfile. Keep the same script names."),
    "",
    tool("Read", "package.json"),
    res("Read 61 lines"),
    tool("Bash", "bun install"),
    res("bun install v1.4.2 · 412 packages installed [2.31s]"),
    tool("Update", ".github/workflows/ci.yml"),
    res("Updated .github/workflows/ci.yml with 6 additions and 9 removals"),
    tool("Update", "Dockerfile"),
    res("Updated Dockerfile with 3 additions and 4 removals"),
    tool("Bash", "git rm yarn.lock && bun run test"),
    res(`${fg(GREEN, "58 pass")}, 0 fail`),
    "",
    ...say("Done. yarn.lock is gone, bun.lock is in, CI and the image build on bun 1.4.2, and every script name is the same as before.", cols),
    "",
    ...promptBox(cols, "? for shortcuts"),
  ];
}

function docsSweep(cols: number): string[] {
  return [
    ...banner("~/code/docs"),
    user('Go through docs/ and fix anything that still says "yarn".'),
    "",
    tool("Search", 'pattern: "yarn", path: "."'),
    res("Found 14 files"),
    tool("Update", "getting-started.md"),
    res("Updated getting-started.md with 4 additions and 4 removals"),
    tool("Update", "workspaces.md"),
    res("Updated workspaces.md with 11 additions and 9 removals"),
    tool("Write", "../atlas/docs/rate-limits.md"),
    res("Wrote 38 lines to ../atlas/docs/rate-limits.md"),
    "",
    ...say("Fourteen files, every yarn is now bun. Two pages described yarn workspaces behaviour that bun does differently; I rewrote those rather than swapping the word. I also wrote the rate-limits page atlas's README links to, since it did not exist yet.", cols),
    "",
    ...promptBox(cols, "? for shortcuts"),
  ];
}

const SCREENS: Record<string, (cols: number) => string[]> = {
  d1: rateLimiter,
  d2: flakyE2e,
  d3: terraformDrift,
  d4: () => shell(),
  d5: migrateToBun,
  d6: docsSweep,
};

/** Screens that end in the prompt box: the cursor belongs on its input line, not the status line. */
const AT_PROMPT = new Set(["d1", "d3", "d5", "d6"]);

/** A session's screen at this size, as one write: clear, then the lines, bottom-aligned. */
export function screen(sessionId: string, cols: number, rows: number): string {
  const lines = (SCREENS[sessionId] ?? (() => []))(Math.max(40, cols));
  const pad = Math.max(0, rows - lines.length);
  const body = [...Array<string>(pad).fill(""), ...lines].join("\r\n");
  // 3J clears the scrollback too, or every redraw on resize leaves the last screen above this one.
  return `${E}H${E}2J${E}3J${R}${body}${AT_PROMPT.has(sessionId) ? `${E}2A\r${E}2C` : ""}`;
}
