// `henry install | uninstall | status`: merge Henry's hooks + statusLine into Claude Code's
// settings.json (respecting $CLAUDE_CONFIG_DIR), remove only what Henry added, report.
// Everything else in the file is preserved (parse, modify, write with 2-space JSON); the
// original is copied to settings.json.henry-backup once.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { config } from "./config";

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
] as const;

const HOOK_SCRIPT = "henry-hook.sh";
const STATUS_SCRIPT = "henry-statusline.sh";
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

/** Shell-quote a path only when it needs it, so the common case stays readable in settings.json. */
function q(p: string): string {
  return /[\s'"$`\\]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
}

export const hookCommand = (event: string) => `${q(hookScript)} ${event}`;
export const statusCommand = () => q(statusScript);

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

const isHenryHook = (h: unknown) => isObj(h) && typeof h.command === "string" && h.command.includes(HOOK_SCRIPT);
const isHenryStatus = (s: unknown) => isObj(s) && typeof s.command === "string" && s.command.includes(STATUS_SCRIPT);

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
 * `<dir>/bin/claude`: a PATH shim for the shells Henry hosts. A `claude` typed into one
 * gets Henry's launch settings (hooks + statusline) exactly like a Henry-launched Claude
 * session, so the rail can tell the terminal now runs Claude without `henry install`.
 * Subcommands (`claude mcp ...`) reject root options, so those pass through untouched.
 * Returns the bin directory to prepend to PATH.
 */
export function writeLaunchBin(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
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
  mcp|plugin|install|update|upgrade|doctor|auth|login|logout|config|agents|setup-token|migrate-installer|remote-control|rc|help)
    exec "$real" "$@" ;;
  *) exec "$real" --settings "$self/../launch-settings.json" "$@" ;;
esac
`,
  );
  chmodSync(shim, 0o755);
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
