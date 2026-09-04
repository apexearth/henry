// Child of hooks.test.ts: exercises transcript.ts in-process against a fixture JSONL under a
// private HENRY_HOME (set by the parent). Prints "TAIL PASS" and exits 0 on success.
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as transcript from "../src/transcript";
import * as db from "../src/db";

const home = process.env.HENRY_HOME!;
const assert = (cond: unknown, msg: string) => {
  if (!cond) {
    console.error("TAIL FAIL:", msg);
    process.exit(1);
  }
};
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

async function waitFor(what: string, fn: () => boolean, ms = 6000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await Bun.sleep(25);
  }
  assert(false, `timeout waiting for ${what}`);
}

// price table
const est = transcript.estimateCost;
assert(close(est({ inputTokens: 1e6, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, "claude-opus-5"), 5), "opus input $5/MTok");
assert(close(est({ inputTokens: 0, outputTokens: 1e6, cacheRead: 0, cacheWrite: 0 }, "claude-sonnet-5"), 10), "sonnet output $10/MTok");
assert(close(est({ inputTokens: 0, outputTokens: 0, cacheRead: 1e6, cacheWrite: 0 }, "claude-fable-5-1"), 1), "fable cache read 10% of $10");
assert(close(est({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 1e6 }, "claude-haiku-4-5"), 1.25), "haiku cache write 125% of $1");
assert(close(est({ inputTokens: 1e6, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, "mystery"), 5), "unknown model -> opus rates");
assert(transcript.projectSlug("/Users/me/.claude-mem/x.y") === "-Users-me--claude-mem-x-y", "project slug");

// tailing
const sid = crypto.randomUUID();
const path = join(home, "t.jsonl");
const session = { id: sid, cwd: home, title: "t", createdAt: Date.now(), status: "running" as const, claudeSessionId: "c-" + sid };
transcript.startTailing(session, path); // file does not exist yet
assert(transcript.isTailing(sid), "isTailing after start");

const line = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), isSidechain: false, message: { id, model: "claude-sonnet-5", usage }, ...extra });

writeFileSync(path, line("m1", { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) + "\n");
await waitFor("first usage row", () => db.listSessionUsage()[sid]?.inputTokens === 7);

// partial write: half a line, then the rest (must not be counted early or lost)
const l2 = line("m2", { input_tokens: 13, output_tokens: 1 });
appendFileSync(path, l2.slice(0, 20));
await Bun.sleep(2500);
assert(db.listSessionUsage()[sid].inputTokens === 7, "partial line not counted");
appendFileSync(path, l2.slice(20) + "\n");
appendFileSync(path, line("m2", { input_tokens: 13, output_tokens: 1 }, { apiBlockIndex: 1 }) + "\n"); // duplicate block
appendFileSync(path, "{ broken json\n");
appendFileSync(path, JSON.stringify({ type: "assistant", isSidechain: true, agentId: "agent-1", message: { id: "m3", model: "claude-haiku-4-5", usage: { input_tokens: 1, output_tokens: 1 } } }) + "\n");
appendFileSync(path, JSON.stringify({ type: "user", isSidechain: false, message: { role: "user" } }) + "\n");
await waitFor("second usage row", () => db.listSessionUsage()[sid]?.inputTokens === 21);
const u = db.listSessionUsage()[sid];
assert(u.outputTokens === 5, `outputTokens 5, got ${u.outputTokens}`);
assert(u.model === "claude-haiku-4-5", `model last seen, got ${u.model}`);
assert(close(u.costUsd, (21 * 1 + 5 * 5) / 1e6), `cost estimate, got ${u.costUsd}`);

const evs = db.listEvents({ sessionId: sid });
assert(JSON.stringify(evs.map((e) => e.summary)) === JSON.stringify(["subagent finished", "subagent started"]), `sidechain events: ${evs.map((e) => e.summary)}`);
assert(evs.every((e) => e.kind === "transcript"), "event kind transcript");

// switching transcripts for the same session (e.g. /clear) carries totals forward
const path2 = join(home, "t2.jsonl");
writeFileSync(path2, line("n1", { input_tokens: 100, output_tokens: 0 }) + "\n");
transcript.startTailing(session, path2);
await waitFor("carried-over totals", () => db.listSessionUsage()[sid]?.inputTokens === 121);

transcript.stopTailing(sid);
assert(!transcript.isTailing(sid), "isTailing after stop");
// Windows releases a closed fs.watch handle a moment later; the directory is busy until then.
for (let i = 0; i < 20; i++) {
  try {
    rmSync(home, { recursive: true, force: true });
    break;
  } catch {
    await Bun.sleep(100);
  }
}
console.log("TAIL PASS");
process.exit(0);
