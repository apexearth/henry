// `henry install | uninstall | status`: merge Henry's hooks + statusLine into Claude Code's
// settings.json (respecting $CLAUDE_CONFIG_DIR), remove only what Henry added, report.
// Everything else in the file is preserved (parse, modify, write with 2-space JSON); the
// original is copied to settings.json.henry-backup once.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { boundPort, config } from "./config";
import { isWindows, slashes } from "./platform";

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "Notification",
  "PermissionRequest",
] as const;

// Two twins per script: sh + curl where Claude Code runs hooks through `sh -c`, a Node script
// on Windows, where the hook runs under Git Bash or PowerShell and only `node` is a given.
const HOOK_SCRIPT = isWindows ? "henry-hook.mjs" : "henry-hook.sh";
const STATUS_SCRIPT = isWindows ? "henry-statusline.mjs" : "henry-statusline.sh";
const PREVIOUS_KEY = "_henryPreviousStatusLine";

type Dict = Record<string, unknown>;
interface HookCommand extends Dict {
  type?: string;
  command?: string;
}
interface HookEntry extends Dict {
  matcher?: string;
  hooks?: HookCommand[];
}

const isObj = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
}

export function settingsPath(): string {
  return join(claudeConfigDir(), "settings.json");
}

export const hooksDir = resolve(import.meta.dir, "../hooks");
export const hookScript = join(hooksDir, HOOK_SCRIPT);
export const statusScript = join(hooksDir, STATUS_SCRIPT);

/**
 * Quote a path only when it needs it, so the common case stays readable in settings.json.
 * Windows paths are written with forward slashes and double quotes: Git Bash eats unquoted
 * backslashes, and both it and PowerShell accept the result.
 */
function q(p: string): string {
  if (isWindows) {
    const s = slashes(p);
    return /[\s'"$`]/.test(s) ? `"${s}"` : s;
  }
  return /[\s'"$`\\]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
}

const runner = isWindows ? "node " : "";
export const hookCommand = (event: string) => `${runner}${q(hookScript)} ${event}`;
export const statusCommand = () => `${runner}${q(statusScript)}`;

function readSettings(path: string): Dict {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text); // a malformed file throws: never overwrite what we cannot read
  if (!isObj(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

function writeSettings(path: string, settings: Dict): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

// Either twin counts as Henry's, so a settings file that moved between machines is still recognised.
const isHenryHook = (h: unknown) => isObj(h) && typeof h.command === "string" && h.command.includes("henry-hook.");
const isHenryStatus = (s: unknown) => isObj(s) && typeof s.command === "string" && s.command.includes("henry-statusline.");

function entriesFor(settings: Dict, event: string): HookEntry[] {
  const hooks = isObj(settings.hooks) ? settings.hooks : undefined;
  const arr = hooks?.[event];
  return Array.isArray(arr) ? (arr as HookEntry[]) : [];
}

function eventInstalled(settings: Dict, event: string): boolean {
  return entriesFor(settings, event).some((e) => Array.isArray(e?.hooks) && e.hooks.some(isHenryHook));
}

/**
 * Settings Henry passes to every `claude` it launches via `--settings <file>`, so
 * Henry-hosted sessions report hooks and usage without `henry install` touching the
 * user's own settings.json. `henry install` is still what covers sessions started
 * elsewhere (a terminal, Zed).
 */
export function launchSettings(): Dict {
  const hooks: Dict = {};
  for (const event of HOOK_EVENTS) hooks[event] = [{ matcher: "", hooks: [{ type: "command", command: hookCommand(event) }] }];
  return { hooks, statusLine: { type: "command", command: statusCommand() } };
}

export function writeLaunchSettings(dir: string): string {
  const path = join(dir, "launch-settings.json");
  writeFileSync(path, JSON.stringify(launchSettings(), null, 2) + "\n");
  return path;
}

/**
 * Henry's MCP server, for `--mcp-config`. It is a separate file and a separate flag because
 * Claude Code does not read `mcpServers` out of a `--settings` file: verified 2026-09-04 by
 * pointing each flag at its own port, where the settings one drew no connection at all and
 * `--mcp-config` drew the full handshake. `?as=session` picks the narrow tool list (mcp.ts).
 * Never paired with `--strict-mcp-config`: this adds Henry's server to the user's own, and
 * must not replace them.
 *
 * `session=${HENRY_SESSION}` is how a call names its own session, which `henry_attention`
 * needs to point the user at the right tab: Claude Code expands `${VAR}` in an mcp config per
 * process, and the `:-` default keeps a `claude` started without the variable (the shim in a
 * plain shell) from failing to load the server at all. mcp.ts treats an unexpanded or unknown
 * value as "no session".
 *
 * The port is the one the daemon bound, and it is baked in: Claude Code reads this file once
 * at session start and a running process cannot re-resolve the url the way a hook script
 * re-reads `<henry home>/port` on every call. So the daemon comes to the session instead —
 * it keeps a listener open on every port its live sessions still name (server.ts,
 * syncAliasListeners), and db.setSessionPort records which port that was.
 */
export function launchMcpConfig(): Dict {
  return { mcpServers: { henry: { type: "http", url: `http://127.0.0.1:${boundPort()}/mcp?as=session&session=\${HENRY_SESSION:-}` } } };
}

/** Whether hosted sessions should carry Henry's tools at all (config switch). */
export function mcpEnabledForSessions(): boolean {
  return config.mcp.enabled && config.mcp.sessions;
}

/**
 * Write the file when sessions should carry Henry's tools, remove it when they should not, so
 * turning `mcp.sessions` off takes the server out of the next session rather than leaving a
 * stale file the PATH shim would still find. Returns the path, or undefined when off.
 */
export function syncLaunchMcp(dir: string): string | undefined {
  const path = join(dir, "launch-mcp.json");
  if (!mcpEnabledForSessions()) {
    rmSync(path, { force: true });
    return undefined;
  }
  writeFileSync(path, JSON.stringify(launchMcpConfig(), null, 2) + "\n");
  return path;
}

/** Subcommands that reject root options such as --settings; the shim passes them through untouched. */
const PASSTHROUGH = ["mcp", "plugin", "install", "update", "upgrade", "doctor", "auth", "login", "logout", "config", "agents", "setup-token", "migrate-installer", "remote-control", "rc", "help"];

/**
 * `<dir>/bin/claude`: a PATH shim for the shells Henry hosts. A `claude` typed into one
 * gets Henry's launch settings (hooks + statusline) exactly like a Henry-launched Claude
 * session, so the rail can tell the terminal now runs Claude without `henry install`.
 * Subcommands (`claude mcp ...`) reject root options, so those pass through untouched.
 * On Windows a `claude.cmd` twin covers PowerShell and cmd.exe (the sh one serves Git Bash).
 * Returns the bin directory to prepend to PATH.
 */
export function writeLaunchBin(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  if (isWindows) {
    writeFileSync(
      join(bin, "claude.cmd"),
      `@echo off\r
rem Henry's PATH shim (written by the daemon; safe to delete). Runs the real claude with\r
rem Henry's launch settings so hooks reach the daemon that hosts this terminal.\r
setlocal\r
set "self=%~dp0"\r
set "real=%HENRY_CLAUDE%"\r
if "%real%"=="" goto find\r
if /i "%real%"=="%self%claude.cmd" goto find\r
if exist "%real%" goto run\r
:find\r
for %%i in (claude.exe claude.cmd claude.bat) do (\r
  for %%j in ("%%~$PATH:i") do if not "%%~j"=="" if /i not "%%~dpj"=="%self%" (\r
    set "real=%%~j"\r
    goto run\r
  )\r
)\r
echo henry: claude not found on PATH 1>&2\r
exit /b 127\r
:run\r
for %%s in (${PASSTHROUGH.join(" ")}) do if /i "%~1"=="%%s" (\r
  "%real%" %*\r
  exit /b %errorlevel%\r
)\r
if exist "%self%..\\launch-mcp.json" (\r
  "%real%" --settings "%self%..\\launch-settings.json" --mcp-config "%self%..\\launch-mcp.json" %*\r
  exit /b %errorlevel%\r
)\r
"%real%" --settings "%self%..\\launch-settings.json" %*\r
exit /b %errorlevel%\r
`,
    );
  }
  const shim = join(bin, "claude");
  writeFileSync(
    shim,
    `#!/bin/sh
# Henry's PATH shim (written by the daemon; safe to delete). Runs the real claude with
# Henry's launch settings so hooks reach the daemon that hosts this terminal.
self="$(cd "$(dirname "$0")" && pwd)"
real="\${HENRY_CLAUDE:-}"
if [ -z "$real" ] || [ ! -x "$real" ] || [ "$real" = "$self/claude" ]; then
  real="$(PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vx "$self" | paste -sd: -)" command -v claude)"
fi
case "\${1:-}" in
  ${PASSTHROUGH.join("|")})
    exec "$real" "$@" ;;
  *)
    # launch-mcp.json is absent when Henry's tools are switched off, so the flag goes with it.
    if [ -f "$self/../launch-mcp.json" ]; then
      exec "$real" --settings "$self/../launch-settings.json" --mcp-config "$self/../launch-mcp.json" "$@"
    fi
    exec "$real" --settings "$self/../launch-settings.json" "$@" ;;
esac
`,
  );
  try {
    chmodSync(shim, 0o755);
  } catch {
    // Windows has no execute bit
  }
  return bin;
}

export async function install(): Promise<void> {
  const path = settingsPath();
  const settings = readSettings(path);

  const backup = path + ".henry-backup";
  if (existsSync(path) && !existsSync(backup)) {
    copyFileSync(path, backup);
    console.log(`backed up ${path} -> ${backup}`);
  }

  for (const script of [hookScript, statusScript]) {
    if (!existsSync(script)) throw new Error(`missing hook script ${script}`);
    try {
      chmodSync(script, 0o755);
    } catch {
      // read-only checkout; the script is already executable in git
    }
  }

  if (!isObj(settings.hooks)) settings.hooks = {};
  const hooks = settings.hooks as Dict;
  const added: string[] = [];
  for (const event of HOOK_EVENTS) {
    if (eventInstalled(settings, event)) continue;
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    (hooks[event] as HookEntry[]).push({ matcher: "", hooks: [{ type: "command", command: hookCommand(event) }] });
    added.push(event);
  }

  const current = settings.statusLine;
  let statusNote: string;
  if (current === undefined || isHenryStatus(current)) {
    settings.statusLine = { type: "command", command: statusCommand() };
    statusNote = current === undefined ? "statusLine: installed" : "statusLine: already Henry's";
  } else if (process.env.HENRY_FORCE_STATUSLINE === "1") {
    settings[PREVIOUS_KEY] = current;
    settings.statusLine = { type: "command", command: statusCommand() };
    statusNote = `statusLine: replaced (previous value kept under "${PREVIOUS_KEY}"; uninstall restores it)`;
  } else {
    statusNote =
      `statusLine: SKIPPED, you already have one (${JSON.stringify(current)}).\n` +
      `  Henry's 5h/7d usage bars need the statusLine command. Re-run with HENRY_FORCE_STATUSLINE=1 henry install\n` +
      `  to replace it; the previous value is saved under "${PREVIOUS_KEY}" and \`henry uninstall\` restores it.`;
  }

  writeSettings(path, settings);
  console.log(`wrote ${path}`);
  console.log(added.length ? `hooks: added ${added.join(", ")}` : "hooks: all present already");
  console.log(statusNote);
}

export async function uninstall(): Promise<void> {
  const path = settingsPath();
  if (!existsSync(path)) {
    console.log(`${path} does not exist; nothing to do`);
    return;
  }
  const settings = readSettings(path);
  const removed: string[] = [];

  if (isObj(settings.hooks)) {
    const hooks = settings.hooks as Dict;
    for (const event of Object.keys(hooks)) {
      const arr = hooks[event];
      if (!Array.isArray(arr)) continue;
      let touched = false;
      const kept = (arr as HookEntry[]).flatMap((entry) => {
        if (!isObj(entry) || !Array.isArray(entry.hooks)) return [entry];
        const rest = entry.hooks.filter((h) => !isHenryHook(h));
        if (rest.length === entry.hooks.length) return [entry];
        touched = true;
        return rest.length ? [{ ...entry, hooks: rest }] : [];
      });
      if (!touched) continue;
      removed.push(event);
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    if (!Object.keys(hooks).length) delete settings.hooks;
  }

  let statusNote = "statusLine: not Henry's, left alone";
  if (isHenryStatus(settings.statusLine)) {
    if (settings[PREVIOUS_KEY] !== undefined) {
      settings.statusLine = settings[PREVIOUS_KEY];
      delete settings[PREVIOUS_KEY];
      statusNote = "statusLine: restored your previous value";
    } else {
      delete settings.statusLine;
      statusNote = "statusLine: removed";
    }
  } else if (settings.statusLine === undefined) {
    statusNote = "statusLine: none";
  }

  writeSettings(path, settings);
  console.log(`wrote ${path}`);
  console.log(removed.length ? `hooks: removed from ${removed.join(", ")}` : "hooks: none of Henry's found");
  console.log(statusNote);
}

export async function status(): Promise<void> {
  const path = settingsPath();
  let settings: Dict = {};
  let readErr: string | undefined;
  try {
    settings = readSettings(path);
  } catch (e) {
    readErr = (e as Error).message;
  }
  console.log(`settings: ${path}${existsSync(path) ? "" : " (missing)"}${readErr ? ` (unreadable: ${readErr})` : ""}`);
  console.log(`hook script: ${hookScript}${existsSync(hookScript) ? "" : " (MISSING)"}`);
  for (const event of HOOK_EVENTS) {
    console.log(`  ${eventInstalled(settings, event) ? "✓" : "✗"} ${event}`);
  }
  const sl = settings.statusLine;
  console.log(
    `statusLine: ${sl === undefined ? "none" : isHenryStatus(sl) ? "Henry's" : "someone else's (" + JSON.stringify(sl) + ")"}` +
      (settings[PREVIOUS_KEY] !== undefined ? ` (previous value saved under ${PREVIOUS_KEY})` : ""),
  );

  const url = `http://127.0.0.1:${config.port}`;
  let alive = false;
  let detail = "";
  try {
    const res = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1000) });
    alive = res.ok;
    if (res.ok) {
      const state = (await res.json()) as { sessions?: unknown[]; usage?: { updatedAt?: number } };
      const n = state.sessions?.length ?? 0;
      const upd = state.usage?.updatedAt;
      detail = ` (${n} session${n === 1 ? "" : "s"}; usage ${upd ? "updated " + new Date(upd).toLocaleTimeString() : "never received"})`;
    }
  } catch {
    alive = false;
  }
  console.log(`daemon: ${url} ${alive ? "responding" + detail : "not responding"}`);
}
