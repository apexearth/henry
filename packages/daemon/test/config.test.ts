// First-run setup: a scratch HENRY_HOME with no config.json reports firstRun, POST /api/config
// rejects a non-folder, accepts a folder, writes config.json and clears firstRun. Run: bun test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoPickerEntry, StateSnapshot } from "@henry/shared";
import { rmScratch, stopSessiond, waitFor } from "./sessiond-helper";

const PORT = 47600 + Math.floor(Math.random() * 300);
const home = mkdtempSync(join(tmpdir(), "henry-config-"));
const daemonDir = join(import.meta.dir, "..");
const base = `http://127.0.0.1:${PORT}`;
const root = join(home, "repos");

let daemon: ReturnType<typeof Bun.spawn>;

const state = () => fetch(`${base}/api/state`).then((r) => r.json()) as Promise<StateSnapshot>;
const post = (body: unknown) => fetch(`${base}/api/config`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  mkdirSync(join(root, "proj"), { recursive: true });
  daemon = Bun.spawn(["bun", "src/index.ts", "start"], {
    cwd: daemonDir,
    env: { ...process.env, HENRY_NO_PUBLIC_LISTENERS: "1", HENRY_HOME: home, HENRY_PORT: String(PORT), CLAUDE_CONFIG_DIR: join(home, "claude-config") },
    stdout: "pipe",
    stderr: "inherit",
  });
  void (async () => {
    for await (const chunk of daemon.stdout as ReadableStream<Uint8Array>) if (process.env.HENRY_TEST_VERBOSE) process.stdout.write(chunk);
  })();
  await waitFor("daemon http", async () => {
    try {
      return (await fetch(`${base}/api/state`)).ok || undefined;
    } catch {
      return undefined;
    }
  });
});

afterAll(async () => {
  daemon?.kill();
  await daemon?.exited;
  await stopSessiond(home);
  await rmScratch(home);
});

describe("first-run setup", () => {
  test("no config.json means firstRun", async () => {
    expect(existsSync(join(home, "config.json"))).toBe(false);
    expect((await state()).firstRun).toBe(true);
  });

  test("/api/repos?root previews a folder without changing config", async () => {
    const list = (await fetch(`${base}/api/repos?root=${encodeURIComponent(root)}`).then((r) => r.json())) as RepoPickerEntry[];
    expect(list.map((r) => r.path)).toEqual([join(root, "proj")]);
    expect(list[0].folder).toBe(true);
    expect((await state()).config.reposRoot).not.toBe(root);
  });

  test("rejects an empty or missing folder", async () => {
    expect((await post({})).status).toBe(400);
    const r = await post({ reposRoot: join(home, "nope") });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("not a folder");
    expect((await state()).firstRun).toBe(true);
  });

  test("accepts a folder, writes config.json and clears firstRun", async () => {
    const r = await post({ reposRoot: root + "/" });
    expect(r.status).toBe(200);
    const s = await state();
    expect(s.firstRun).toBe(false);
    expect(s.config.reposRoot).toBe(root);
    expect(s.config.defaultRepo).toBe(root);
    const written = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(written).toEqual({ reposRoot: root, defaultRepo: root });
  });
});

describe("settings", () => {
  test("the playbook ships off", async () => {
    const { overseer } = (await state()).config;
    expect(overseer.onStop).toBe(false);
    expect(overseer.onFlag).toBe(false);
  });

  test("a patch writes only its own keys and leaves the rest alone", async () => {
    expect((await post({ retentionDays: 7, overseer: { onStop: true } })).status).toBe(200);
    const s = await state();
    expect(s.config.retentionDays).toBe(7);
    expect(s.config.overseer.onStop).toBe(true);
    // Untouched keys keep their defaults rather than being dropped or overwritten.
    expect(s.config.overseer.onFlag).toBe(false);
    expect(s.config.reposRoot).toBe(root);
    const written = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(written.retentionDays).toBe(7);
    expect(written.overseer).toEqual({ onStop: true });
  });

  test("unknown keys and the port are ignored", async () => {
    expect((await post({ port: 1234, nonsense: true, rules: { protectedBranches: ["main", "release"], bogus: 1 } })).status).toBe(200);
    const s = await state();
    expect(s.config.port).toBe(PORT);
    expect(s.config.rules.protectedBranches).toEqual(["main", "release"]);
    const written = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(written.port).toBeUndefined();
    expect(written.nonsense).toBeUndefined();
    expect(written.rules.bogus).toBeUndefined();
  });

  test("rejects an empty patch and a negative retention", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ retentionDays: -1 })).status).toBe(400);
    expect((await state()).config.retentionDays).toBe(7);
  });
});
