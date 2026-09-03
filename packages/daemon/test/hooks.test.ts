// Milestone 2 integration test: boots a throwaway daemon (scratch HENRY_HOME, random port),
// POSTs realistic hook + statusline payloads, checks /api/state, /api/events and the WS feed,
// and drives the transcript tailer (test/transcript-tail.ts, own process) on a fixture JSONL. Run: bun test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, HenryEvent, ServerMessage, StateSnapshot } from "@henry/shared";
import { stopSessiond } from "./sessiond-helper";

const PORT = 47200 + Math.floor(Math.random() * 300);
const home = mkdtempSync(join(tmpdir(), "henry-hooks-"));
const claudeDir = join(home, "claude-config");
const daemonDir = join(import.meta.dir, "..");
const base = `http://127.0.0.1:${PORT}`;

let daemon: ReturnType<typeof Bun.spawn>;
let ws: WebSocket;
const inbox: ServerMessage[] = [];

const sendMsg = (m: ClientMessage) => ws.send(JSON.stringify(m));

async function waitFor<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, ms = 10000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v !== undefined) return v;
    await Bun.sleep(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

const next = <T extends ServerMessage["type"]>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, ms = 10000) =>
  waitFor(type, () => {
    const i = inbox.findIndex((m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
    return i >= 0 ? (inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>) : undefined;
  }, ms);

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const state = () => fetch(`${base}/api/state`).then((r) => r.json()) as Promise<StateSnapshot>;
const events = (session?: string) => fetch(`${base}/api/events${session ? `?session=${session}` : ""}`).then((r) => r.json()) as Promise<HenryEvent[]>;

const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
const cwd = join(home, "repo");
const transcriptPath = join(claudeDir, "projects", cwd.replace(/[/.]/g, "-"), `${CLAUDE_ID}.jsonl`);

const hookPayload = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({
  session_id: CLAUDE_ID,
  transcript_path: transcriptPath,
  cwd,
  permission_mode: "default",
  hook_event_name,
  ...extra,
});

beforeAll(async () => {
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(claudeDir, "projects"), { recursive: true });
  daemon = Bun.spawn(["bun", "src/index.ts", "start"], {
    cwd: daemonDir,
    env: { ...process.env, HENRY_HOME: home, HENRY_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeDir },
    stdout: "pipe",
    stderr: "inherit",
  });
  // Drain stdout so the daemon never blocks on a full pipe.
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
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(e);
  });
  await next("state");
});

afterAll(async () => {
  try {
    ws?.close();
  } catch {}
  daemon?.kill();
  await daemon?.exited;
  await stopSessiond(home);
  rmSync(home, { recursive: true, force: true });
});

describe("hook ingest", () => {
  let sessionId: string;

  test("PTY session binds to Claude's session_id from the first hook", async () => {
    sendMsg({ type: "session:create", cwd, title: "hooks-test", command: "/bin/sh", args: [], requestId: "r1" });
    sessionId = (await next("session:update", (m) => m.requestId === "r1")).session.id;

    const res = await post("/hook", { henrySession: sessionId, henryHookEvent: "SessionStart", payload: hookPayload("SessionStart", { source: "startup" }) });
    expect(res.status).toBe(200);
    const bound = await next("session:update", (m) => m.session.id === sessionId && m.session.claudeSessionId === CLAUDE_ID);
    expect(bound.session.claudeSessionId).toBe(CLAUDE_ID);
    const ev = await next("event", (m) => m.event.sessionId === sessionId);
    expect(ev.event.summary).toBe("Session start (startup)");
    expect(ev.event.hookEvent).toBe("SessionStart");
  });

  test("a shell session turns into a Claude session while claude posts hooks from it", async () => {
    sendMsg({ type: "session:create", cwd, kind: "shell", command: "/bin/sh", args: [], requestId: "r-shell" });
    const created = (await next("session:update", (m) => m.requestId === "r-shell")).session;
    expect(created.kind).toBe("shell");
    expect(created.claudeActive).toBeUndefined();
    expect(created.claudeSessionId).toBeUndefined();

    // The shell's PATH starts with Henry's shim dir, so a typed `claude` carries the launch settings.
    sendMsg({ type: "attach", sessionId: created.id });
    await next("pty:scrollback", (m) => m.sessionId === created.id);
    sendMsg({ type: "pty:input", sessionId: created.id, data: "echo PATH=$PATH; command -v claude; echo HC=$HENRY_CLAUDE\r" });
    let out = "";
    await waitFor("shell PATH echo", () => {
      for (const m of inbox.splice(0)) if (m.type === "pty:data" && m.sessionId === created.id) out += m.data;
      return out.includes("HC=") || undefined;
    });
    expect(out).toContain(`PATH=${join(home, "bin")}:`);
    expect(out).toContain(join(home, "bin", "claude"));
    const shim = readFileSync(join(home, "bin", "claude"), "utf8");
    expect(shim).toContain("--settings");
    expect(statSync(join(home, "bin", "claude")).mode & 0o111).toBeTruthy();

    const inner = "cccccccc-dddd-4eee-8fff-000000000001";
    await post("/hook", { henrySession: created.id, henryHookEvent: "SessionStart", payload: { ...hookPayload("SessionStart", { source: "startup" }), session_id: inner } });
    const active = await next("session:update", (m) => m.session.id === created.id && m.session.claudeActive === true);
    expect(active.session.claudeSessionId).toBe(inner);
    expect(active.session.kind).toBe("shell");
    expect(active.session.status).toBe("running");

    await post("/hook", { henrySession: created.id, henryHookEvent: "SessionEnd", payload: { ...hookPayload("SessionEnd", { reason: "exit" }), session_id: inner } });
    const idle = await next("session:update", (m) => m.session.id === created.id && m.session.claudeActive === false);
    expect(idle.session.status).toBe("running");
    expect(idle.session.claudeSessionId).toBe(inner);

    // The same conversation resumed in the same shell marks it active again.
    await post("/hook", { henrySession: created.id, henryHookEvent: "SessionStart", payload: { ...hookPayload("SessionStart", { source: "resume" }), session_id: inner } });
    await next("session:update", (m) => m.session.id === created.id && m.session.claudeActive === true);

    sendMsg({ type: "session:kill", sessionId: created.id });
    await next("session:update", (m) => m.session.id === created.id && m.session.status === "exited");
  });

  test("the terminal title becomes the session title; closing an exited session dismisses it for good", async () => {
    sendMsg({ type: "session:create", cwd, kind: "shell", command: "/bin/sh", args: [], requestId: "r-title" });
    const created = (await next("session:update", (m) => m.requestId === "r-title")).session;
    expect(created.title).toBe("repo");
    sendMsg({ type: "attach", sessionId: created.id });
    await next("pty:scrollback", (m) => m.sessionId === created.id);
    // OSC 0 with BEL, then OSC 2 with ST split across two writes; a leading status glyph is dropped.
    sendMsg({ type: "pty:input", sessionId: created.id, data: "printf '\\033]0;\\342\\234\\263 Rail fixes\\007'\r" });
    await next("session:update", (m) => m.session.id === created.id && m.session.title === "Rail fixes");
    sendMsg({ type: "pty:input", sessionId: created.id, data: "printf '\\033]2;Second'; sleep 0.3; printf ' half\\033\\\\'\r" });
    await next("session:update", (m) => m.session.id === created.id && m.session.title === "Second half");
    expect((await state()).sessions.find((s) => s.id === created.id)?.title).toBe("Second half");

    sendMsg({ type: "session:kill", sessionId: created.id });
    const exited = (await next("session:update", (m) => m.session.id === created.id && m.session.status === "exited")).session;
    expect(exited.endedAt).toBeGreaterThan(exited.createdAt - 1);
    sendMsg({ type: "session:kill", sessionId: created.id });
    const st = await next("state", (m) => !m.sessions.some((s) => s.id === created.id));
    expect(st.sessions.some((s) => s.id === created.id)).toBe(false);
  });

  test("PreToolUse Bash / PostToolUse Edit / UserPromptSubmit / Stop produce summarised events", async () => {
    const posts = [
      ["PreToolUse", hookPayload("PreToolUse", { tool_name: "Bash", tool_input: { command: "git push origin main", description: "push" } })],
      [
        "PostToolUse",
        hookPayload("PostToolUse", {
          tool_name: "Edit",
          tool_input: { file_path: join(cwd, "packages/x/y.ts"), old_string: "a", new_string: "b" },
          tool_response: { filePath: join(cwd, "packages/x/y.ts"), success: true },
        }),
      ],
      ["UserPromptSubmit", hookPayload("UserPromptSubmit", { prompt: "please fix the flaky test in packages/daemon and make sure it passes on CI every single time thanks" })],
      ["Stop", hookPayload("Stop", { stop_hook_active: false })],
    ] as const;
    for (const [ev, payload] of posts) {
      const res = await post("/hook", { henrySession: sessionId, henryHookEvent: ev, payload });
      expect(res.status).toBe(200);
    }
    const got: HenryEvent[] = [];
    for (let i = 0; i < 4; i++) got.push((await next("event", (m) => m.event.sessionId === sessionId)).event);
    const byHook = Object.fromEntries(got.map((e) => [e.hookEvent, e]));
    expect(byHook.PreToolUse.summary).toBe("Bash: git push origin main");
    expect(byHook.PreToolUse.toolName).toBe("Bash");
    expect(byHook.PreToolUse.cwd).toBe(cwd);
    expect(byHook.PostToolUse.summary).toBe("✓ Edit: packages/x/y.ts");
    expect(byHook.UserPromptSubmit.summary).toMatch(/^Prompt: please fix the flaky test/);
    expect(byHook.UserPromptSubmit.summary.length).toBeLessThanOrEqual(90);
    expect(byHook.Stop.summary).toBe("Stop");
    for (const e of got) {
      expect(e.kind).toBe("hook");
      expect(e.claudeSessionId).toBe(CLAUDE_ID);
      expect(["info", "notable", "alarm"]).toContain(e.severity);
    }

    // Persisted and queryable.
    const stored = await events(sessionId);
    expect(stored.length).toBeGreaterThanOrEqual(5);
    expect(stored.map((e) => e.hookEvent)).toContain("Stop");
    const bash = stored.find((e) => e.hookEvent === "PreToolUse")!;
    expect((bash.payload as { tool_input: { command: string } }).tool_input.command).toBe("git push origin main");
  });

  test("activity follows the hook stream: working, needs input, waiting", async () => {
    const activityOf = async () => (await state()).sessions.find((x) => x.id === sessionId)?.activity;

    await post("/hook", { henrySession: sessionId, henryHookEvent: "PreToolUse", payload: hookPayload("PreToolUse", { tool_name: "Read", tool_input: { file_path: join(cwd, "a.ts") } }) });
    expect(await waitFor("working", async () => (await activityOf()) === "working" || undefined)).toBe(true);

    await post("/hook", { henrySession: sessionId, henryHookEvent: "Notification", payload: hookPayload("Notification", { message: "Claude needs your permission to use Bash" }) });
    expect(await waitFor("needsInput", async () => (await activityOf()) === "needsInput" || undefined)).toBe(true);

    await post("/hook", { henrySession: sessionId, henryHookEvent: "Stop", payload: hookPayload("Stop", { stop_hook_active: false }) });
    const s = await waitFor("waiting", async () => {
      const found = (await state()).sessions.find((x) => x.id === sessionId);
      return found?.activity === "waiting" ? found : undefined;
    });
    expect(s.activitySince).toBeGreaterThan(0);
  });

  test("flags follow non-info classifications", async () => {
    // Whether the rules engine flags "git push" depends on milestone 4; assert consistency either way.
    const st = await state();
    const flagged = (await events(sessionId)).filter((e) => e.severity !== "info");
    for (const e of flagged) expect(st.flags.some((f) => f.eventId === e.id && f.severity === e.severity)).toBe(true);
    for (const f of st.flags.filter((f) => f.sessionId === sessionId)) expect(f.read).toBe(false);
  });

  test("a hook from a session Henry did not spawn creates an external session", async () => {
    const otherId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const otherCwd = join(home, "elsewhere");
    mkdirSync(otherCwd, { recursive: true });
    const payload = { ...hookPayload("PreToolUse", { tool_name: "Read", tool_input: { file_path: join(otherCwd, "README.md") } }), session_id: otherId, cwd: otherCwd, transcript_path: undefined };
    await post("/hook", { henrySession: "", henryHookEvent: "PreToolUse", payload });
    const upd = await next("session:update", (m) => m.session.claudeSessionId === otherId);
    expect(upd.session.command).toBe("external");
    expect(upd.session.title).toBe("elsewhere");
    expect(upd.session.status).toBe("running");
    const ev = await next("event", (m) => m.event.sessionId === upd.session.id);
    expect(ev.event.summary).toBe("Read: README.md");

    // Second hook from the same external session reuses the row.
    await post("/hook", { henrySession: "", henryHookEvent: "Stop", payload: { ...payload, hook_event_name: "Stop", tool_name: undefined, tool_input: undefined } });
    const ev2 = await next("event", (m) => m.event.summary === "Stop" && m.event.sessionId === upd.session.id);
    expect(ev2.event.sessionId).toBe(upd.session.id);
    const st = await state();
    expect(st.sessions.filter((s) => s.claudeSessionId === otherId).length).toBe(1);

    // SessionEnd marks it exited.
    await post("/hook", { henrySession: "", henryHookEvent: "SessionEnd", payload: { ...payload, hook_event_name: "SessionEnd", reason: "exit" } });
    const ended = await next("session:update", (m) => m.session.id === upd.session.id && m.session.status === "exited");
    expect(ended.session.status).toBe("exited");
  });

  test("garbage bodies never fail the request", async () => {
    expect((await post("/hook", "nonsense")).status).toBe(200);
    expect((await post("/hook", { henrySession: "nope", payload: null })).status).toBe(200);
    expect((await fetch(base + "/hook", { method: "POST", body: "{not json" })).status).toBe(200);
    expect((await post("/statusline", [1, 2, 3])).status).toBe(200);
  });

  test("statusline payload becomes the 5h/7d snapshot, per-session cost, and a display line", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      hook_event_name: "Status",
      session_id: CLAUDE_ID,
      transcript_path: transcriptPath,
      cwd,
      model: { id: "claude-opus-5", display_name: "Opus" },
      workspace: { current_dir: cwd, project_dir: cwd },
      version: "2.1.259",
      output_style: { name: "default" },
      cost: { total_cost_usd: 1.2345, total_duration_ms: 90000, total_api_duration_ms: 20000, total_lines_added: 10, total_lines_removed: 2 },
      context_window: { total_input_tokens: 45000, total_output_tokens: 1200, context_window_size: 200000, used_percentage: 23, remaining_percentage: 77 },
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: now + 2 * 3600 + 10 * 60 },
        seven_day: { used_percentage: 17, resets_at: now + 3 * 86400 },
      },
      exceeds_200k_tokens: false,
    };
    const res = await post("/statusline", { henrySession: sessionId, payload });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/^henry · 5h 42% ↻2h10m · 7d 17% ↻3d · ctx 23% · \$1\.23$/);

    const upd = await next("usage:update", (m) => m.usage.fiveHour !== undefined);
    expect(upd.usage.fiveHour?.utilization).toBeCloseTo(0.42, 5);
    expect(upd.usage.sevenDay?.utilization).toBeCloseTo(0.17, 5);
    expect(upd.usage.fiveHour?.resetsAt).toBe((now + 2 * 3600 + 10 * 60) * 1000);
    expect(upd.usage.updatedAt).toBeGreaterThan(0);
    expect(upd.usage.perSession[sessionId]?.costUsd).toBeCloseTo(1.2345, 4);
    expect(upd.usage.perSession[sessionId]?.model).toBe("claude-opus-5");
    // No transcript yet: context comes from used_percentage × context_window_size.
    expect(upd.usage.perSession[sessionId]?.contextTokens).toBe(46000);
    expect(upd.usage.perSession[sessionId]?.contextWindow).toBe(200000);

    const st = await state();
    expect(st.usage.fiveHour?.utilization).toBeCloseTo(0.42, 5);
    expect(st.usage.perSession[sessionId]?.costUsd).toBeCloseTo(1.2345, 4);

    // Fraction-style utilization (older shape) and ISO resets_at are accepted too.
    const res2 = await post("/statusline", {
      henrySession: sessionId,
      payload: { ...payload, rate_limits: { five_hour: { utilization: 0.91, resets_at: new Date((now + 600) * 1000).toISOString() }, seven_day: { utilization: 55 } } },
    });
    expect(await res2.text()).toMatch(/^henry · 5h 91% ↻10m · 7d 55% · ctx 23% · \$1\.23$/);
    const st2 = await state();
    expect(st2.usage.fiveHour?.utilization).toBeCloseTo(0.91, 5);
    expect(st2.usage.sevenDay?.utilization).toBeCloseTo(0.55, 5);
  });

  test("transcript lines appended to the tailed JSONL update per-session tokens", async () => {
    // The tailer was started by the SessionStart hook (transcript_path). Append assistant lines.
    mkdirSync(join(transcriptPath, ".."), { recursive: true });
    const line = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), session_id: CLAUDE_ID, isSidechain: false, message: { id, model: "claude-opus-5", role: "assistant", usage }, ...extra }) + "\n";
    writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
    appendFileSync(transcriptPath, line("msg_1", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }));
    // Same message id twice (content blocks): counted once.
    appendFileSync(transcriptPath, line("msg_1", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, { apiBlockIndex: 1 }));
    appendFileSync(transcriptPath, "{ this line is broken\n");
    appendFileSync(transcriptPath, line("msg_2", { input_tokens: 10, output_tokens: 5 }));
    // Subagent turns carry their own context and must not overwrite the main chain's.
    appendFileSync(transcriptPath, line("msg_3", { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 90000 }, { isSidechain: true }));

    const upd = await next("usage:update", (m) => m.usage.perSession[sessionId]?.inputTokens === 111, 8000);
    const u = upd.usage.perSession[sessionId];
    expect(u.inputTokens).toBe(111);
    expect(u.outputTokens).toBe(56);
    expect(u.cacheRead).toBe(91000);
    expect(u.cacheWrite).toBe(200);
    // Context = the latest main-chain message's input + cache read + cache write; window from the statusline.
    expect(u.contextTokens).toBe(10);
    expect(u.contextWindow).toBe(200000);
    // Statusline cost is authoritative while present.
    expect(u.costUsd).toBeCloseTo(1.2345, 4);

    // /rename writes a custom-title line; the session takes that name.
    appendFileSync(transcriptPath, JSON.stringify({ type: "custom-title", customTitle: "Renamed via transcript", sessionId: CLAUDE_ID }) + "\n");
    await next("session:update", (m) => m.session.id === sessionId && m.session.title === "Renamed via transcript", 8000);
  });
});

describe("transcript tailer", () => {
  // Runs in a child process with its own HENRY_HOME: bun test shares module instances across
  // files, so importing ../src/db here would pin it to one scratch dir for every other test file.
  test("tails a file that appears later, dedupes by message id, handles partial lines and sidechains", async () => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "transcript-tail.ts")], {
      cwd: daemonDir,
      env: { ...process.env, HENRY_HOME: mkdtempSync(join(tmpdir(), "henry-tail-")), HENRY_PORT: String(PORT + 1000) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    if (code !== 0) console.error(out, err);
    expect(code).toBe(0);
    expect(out).toContain("TAIL PASS");
  }, 30000);
});
