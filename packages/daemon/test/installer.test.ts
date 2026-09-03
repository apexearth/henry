// `henry install | uninstall | status` against a scratch CLAUDE_CONFIG_DIR. Never touches ~/.claude.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopSessiond } from "./sessiond-helper";

const daemonDir = join(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "henry-install-"));
const claudeDir = join(root, "claude");
const home = join(root, "henry-home");
const settings = join(claudeDir, "settings.json");
const backup = settings + ".henry-backup";
const PORT = 47600 + Math.floor(Math.random() * 300); // nothing listens here: status must report "not responding"

const fixture = {
  includeCoAuthoredBy: false,
  permissions: { allow: ["Bash(git status:*)"], deny: ["Bash(rm -rf:*)", "Read(.env)"] },
  model: "opus",
  hooks: {
    Notification: [{ matcher: "", hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/my-linter.sh" }] }],
  },
  statusLine: { type: "command", command: "~/.claude/my-status.sh", padding: 0 },
  someFutureKey: { nested: [1, 2, { three: true }] },
};

async function henry(cmd: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", "src/index.ts", cmd], {
    cwd: daemonDir,
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, HENRY_HOME: home, HENRY_PORT: String(PORT), HENRY_FORCE_STATUSLINE: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out, err };
}

const read = () => JSON.parse(readFileSync(settings, "utf8"));
const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop", "SubagentStop", "UserPromptSubmit", "SessionStart", "SessionEnd", "PreCompact", "Notification", "PermissionRequest"];

beforeAll(() => {
  writeFileSync(join(claudeDir, "..", ".keep"), "");
  require("node:fs").mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settings, JSON.stringify(fixture, null, 2) + "\n");
});
afterAll(async () => {
  await stopSessiond(home);
  rmSync(root, { recursive: true, force: true });
});

describe("henry install / uninstall / status", () => {
  test("install merges hooks, keeps foreign content, skips a foreign statusLine", async () => {
    const r = await henry("install");
    expect(r.code).toBe(0);
    expect(r.out).toContain("statusLine: SKIPPED");
    expect(r.out).toContain("HENRY_FORCE_STATUSLINE=1");
    expect(existsSync(backup)).toBe(true);
    expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual(fixture);

    const s = read();
    // Foreign content survives byte-for-byte semantically.
    expect(s.permissions).toEqual(fixture.permissions);
    expect(s.someFutureKey).toEqual(fixture.someFutureKey);
    expect(s.model).toBe("opus");
    expect(s.statusLine).toEqual(fixture.statusLine);
    expect(s._henryPreviousStatusLine).toBeUndefined();
    // Existing hooks kept, Henry's appended.
    expect(s.hooks.Notification[0]).toEqual(fixture.hooks.Notification[0]);
    expect(s.hooks.PreToolUse[0]).toEqual(fixture.hooks.PreToolUse[0]);
    for (const ev of HOOK_EVENTS) {
      const ours = s.hooks[ev].filter((e: { hooks: { command: string }[] }) => e.hooks.some((h) => h.command.includes("henry-hook.sh")));
      expect(ours.length).toBe(1);
      expect(ours[0]).toEqual({ matcher: "", hooks: [{ type: "command", command: expect.stringMatching(new RegExp(`^/.*hooks/henry-hook\\.sh ${ev}$`)) }] });
    }
    expect(s.hooks.PreToolUse.length).toBe(2);
    expect(s.hooks.Notification.length).toBe(2);
  });

  test("install is idempotent and never overwrites the backup", async () => {
    writeFileSync(backup, "ORIGINAL BACKUP");
    const before = read();
    const r = await henry("install");
    expect(r.code).toBe(0);
    expect(r.out).toContain("hooks: all present already");
    expect(read()).toEqual(before);
    expect(readFileSync(backup, "utf8")).toBe("ORIGINAL BACKUP");
    writeFileSync(backup, JSON.stringify(fixture, null, 2) + "\n");
  });

  test("status reports installed events, a foreign statusLine, and a dead daemon", async () => {
    const r = await henry("status");
    expect(r.code).toBe(0);
    for (const ev of HOOK_EVENTS) expect(r.out).toContain(`✓ ${ev}`);
    expect(r.out).toContain("statusLine: someone else's");
    expect(r.out).toContain(`http://127.0.0.1:${PORT} not responding`);
  });

  test("HENRY_FORCE_STATUSLINE=1 replaces the statusLine and remembers the old one", async () => {
    const r = await henry("install", { HENRY_FORCE_STATUSLINE: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("statusLine: replaced");
    const s = read();
    expect(s.statusLine.command).toMatch(/\/hooks\/henry-statusline\.sh$/);
    expect(s.statusLine.type).toBe("command");
    expect(s._henryPreviousStatusLine).toEqual(fixture.statusLine);
    const st = await henry("status");
    expect(st.out).toContain("statusLine: Henry's");
  });

  test("uninstall removes only Henry's entries and restores the original exactly", async () => {
    const r = await henry("uninstall");
    expect(r.code).toBe(0);
    expect(r.out).toContain("statusLine: restored");
    expect(read()).toEqual(fixture);
    const st = await henry("status");
    for (const ev of HOOK_EVENTS) expect(st.out).toContain(`✗ ${ev}`);
  });

  test("install on a missing settings.json creates one with only Henry's keys; uninstall empties it", async () => {
    rmSync(settings);
    rmSync(backup);
    const r = await henry("install");
    expect(r.code).toBe(0);
    expect(r.out).toContain("statusLine: installed");
    expect(existsSync(backup)).toBe(false);
    const s = read();
    expect(Object.keys(s).sort()).toEqual(["hooks", "statusLine"]);
    expect(Object.keys(s.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    const u = await henry("uninstall");
    expect(u.code).toBe(0);
    expect(read()).toEqual({});
  });

  test("a malformed settings.json is never overwritten", async () => {
    writeFileSync(settings, "{ this is not json");
    const r = await henry("install");
    expect(r.code).not.toBe(0);
    expect(readFileSync(settings, "utf8")).toBe("{ this is not json");
  });
});
