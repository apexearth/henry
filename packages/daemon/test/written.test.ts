// sessionWrites: the Changes pane's answer. Newest write first, one row per file, and the
// last prompt that was yours (not one Claude Code sent itself) as the line between.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./sessiond-helper";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "henry-written-test-")));
const home = join(tmp, "home");
const repo = join(tmp, "app");
mkdirSync(home, { recursive: true });
mkdirSync(join(repo, "src"), { recursive: true });
process.env.HENRY_HOME = home;
process.env.HENRY_PORT = "0";

let db: typeof import("../src/db");
let written: typeof import("../src/written");

beforeAll(async () => {
  Bun.spawnSync(["git", "init", "-q", repo]);
  db = await import("../src/db");
  written = await import("../src/written");
});
afterAll(() => rmScratch(tmp));

let n = 0;
function hook(sessionId: string, ts: number, hookEvent: string, extra: { toolName?: string; payload?: unknown } = {}): void {
  db.insertEvent({ id: `e${n++}`, sessionId, ts, kind: "hook", hookEvent, cwd: repo, payload: extra.payload ?? {}, toolName: extra.toolName, severity: "info", summary: hookEvent });
}
const edit = (sid: string, ts: number, file: string, hookEvent = "PostToolUse") =>
  hook(sid, ts, hookEvent, { toolName: "Edit", payload: { tool_input: { file_path: file } } });

test("newest first, deduped, split by your last prompt", () => {
  hook("s1", 1000, "UserPromptSubmit", { payload: { prompt: "first" } });
  edit("s1", 1100, join(repo, "src", "a.ts"));
  edit("s1", 1200, "src/b.ts");
  hook("s1", 2000, "UserPromptSubmit", { payload: { prompt: "second" } });
  edit("s1", 2100, join(repo, "src", "a.ts"));
  // Claude Code's own wake-up is not a prompt of yours, and a denied call never posts.
  hook("s1", 2200, "UserPromptSubmit", { payload: { prompt: "<task-notification> done" } });
  edit("s1", 2300, join(repo, "README.md"), "PreToolUse");
  edit("other", 2400, join(repo, "x.ts"));

  const w = written.sessionWrites("s1");
  expect(w.promptAt).toBe(2000);
  expect(w.files.map((f) => [f.rel, f.at])).toEqual([
    ["src/a.ts", 2100],
    ["src/b.ts", 1200],
  ]);
  expect(w.files[0]!.repo).toBe(repo);
});

test("a session with nothing on record", () => {
  expect(written.sessionWrites("nobody")).toEqual({ sessionId: "nobody", promptAt: undefined, files: [] });
});
