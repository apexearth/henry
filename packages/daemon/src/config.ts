import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, type HenryConfig } from "@henry/shared";
import { expandTilde } from "./platform";

/** ~/.henry (override with HENRY_HOME, used by tests to stay out of the real one). */
export const henryDir = process.env.HENRY_HOME ? resolve(process.env.HENRY_HOME) : join(homedir(), ".henry");
export const configPath = join(henryDir, "config.json");
/** The port the running daemon actually bound, for hook scripts (see writePortFile). */
export const portPath = join(henryDir, "port");

export function expandHome(p: string): string {
  return expandTilde(p, homedir());
}

/** The user's own config.json, or {} when absent or unparsable. */
function readUser(): Partial<HenryConfig> {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error(`[henry] could not parse ${configPath}: ${(e as Error).message}; using defaults`);
    return {};
  }
}

let userHasRoot = false;

/** True until the user has chosen a reposRoot (config.json missing or without one). */
export function isFirstRun(): boolean {
  return !userHasRoot;
}

function writeUser(next: Record<string, unknown>): void {
  if (!existsSync(henryDir)) mkdirSync(henryDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
}

/**
 * Publish the port the daemon just bound to `<henry home>/port`, in plain text.
 * A PTY outlives the daemon by design, so the `HENRY_PORT` baked into a session's
 * environment goes stale the moment the daemon moves (4711 -> 14711 did exactly that, and
 * those sessions posted hooks into a dead port until they were restarted). The hook scripts
 * read this file first and fall back to their env, so a live session finds the live daemon.
 * Best-effort: a home that cannot be written just leaves the hooks on their env fallback.
 */
export function writePortFile(port: number): void {
  bound = port;
  try {
    if (!existsSync(henryDir)) mkdirSync(henryDir, { recursive: true });
    writeFileSync(portPath, `${port}\n`);
  } catch (e) {
    console.error(`[henry] could not write ${portPath}: ${(e as Error).message}`);
  }
}

let bound: number | undefined;

/**
 * The port the daemon actually bound, once it has one. Anything a session carries away —
 * its HENRY_PORT, the url in launch-mcp.json — must use this rather than `config.port`,
 * which `HENRY_PORT=0` and a config edited since startup both turn into a lie.
 */
export function boundPort(): number {
  return bound ?? config.port;
}

/** What the hook scripts would read from `<henry home>/port`; undefined if absent or junk. */
export function readPortFile(): number | undefined {
  try {
    const n = Number(readFileSync(portPath, "utf8").trim());
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Record the chosen repos folder (as typed, "~" allowed) and reload. defaultRepo follows it
 * unless the user already set one. */
export function setReposRoot(root: string): void {
  const user = readUser();
  const next: Partial<HenryConfig> = { ...user, reposRoot: root };
  if (!user.defaultRepo) next.defaultRepo = root;
  writeUser(next as Record<string, unknown>);
  reloadConfig();
}

// What the settings UI may write. `port` is deliberately absent: changing it would strand the
// window that asked, and it only takes effect on restart anyway.
const SETTABLE = {
  root: ["host", "reposRoot", "defaultRepo", "retentionDays"],
  overseer: ["backend", "model", "onStop", "onFlag", "apiKey", "stopMinIntervalSec"],
  mcp: ["enabled", "sessions"],
  federation: ["listen", "port"],
  rules: ["protectedBranches", "alarm", "notable", "crossRepoWrite", "commitOnProtected", "pushToProtected", "maxSubagentsPer10m"],
} as const;

/** Merge a patch from the settings UI into config.json; unknown keys are dropped. Only the
 * keys present in the patch change, so two windows editing different sections do not clobber
 * each other. Returns the reloaded live config. */
export function setConfig(patch: Partial<HenryConfig>): HenryConfig {
  const user = readUser() as Record<string, unknown>;
  const incoming = patch as Record<string, unknown>;
  const next: Record<string, unknown> = { ...user };
  for (const k of SETTABLE.root) if (k in incoming) next[k] = incoming[k];
  for (const group of ["overseer", "mcp", "federation", "rules"] as const) {
    const sub = incoming[group];
    if (!sub || typeof sub !== "object") continue;
    const merged = { ...((user[group] as Record<string, unknown>) ?? {}) };
    for (const k of SETTABLE[group]) if (k in sub) merged[k] = (sub as Record<string, unknown>)[k];
    next[group] = merged;
  }
  writeUser(next);
  return reloadConfig();
}

function load(): HenryConfig {
  if (!existsSync(henryDir)) mkdirSync(henryDir, { recursive: true });
  const user = readUser();
  userHasRoot = typeof user.reposRoot === "string" && user.reposRoot.trim() !== "";
  const merged: HenryConfig = {
    ...DEFAULT_CONFIG,
    ...user,
    overseer: { ...DEFAULT_CONFIG.overseer, ...(user.overseer ?? {}) },
    mcp: { ...DEFAULT_CONFIG.mcp, ...(user.mcp ?? {}) },
    federation: { ...DEFAULT_CONFIG.federation, ...(user.federation ?? {}) },
    rules: { ...DEFAULT_CONFIG.rules, ...(user.rules ?? {}) },
  };
  if (process.env.HENRY_PORT) merged.port = Number(process.env.HENRY_PORT);
  merged.reposRoot = expandHome(merged.reposRoot);
  merged.defaultRepo = expandHome(merged.defaultRepo);
  return merged;
}

/**
 * The live config. Mutated in place by reloadConfig() so every importer sees edits to
 * ~/.henry/config.json without a restart; read fields at use time rather than caching them.
 * (`port` is read once at startup by the server and does not take effect until restart.)
 */
export const config: HenryConfig = load();

const reloadListeners = new Set<(c: HenryConfig) => void>();

/** Re-read config.json into the shared `config` object and notify onConfigReload listeners. */
export function reloadConfig(): HenryConfig {
  const fresh = load();
  for (const k of Object.keys(config)) delete (config as unknown as Record<string, unknown>)[k];
  Object.assign(config, fresh);
  for (const l of reloadListeners) {
    try {
      l(config);
    } catch (e) {
      console.error("[henry] config reload listener failed:", e);
    }
  }
  return config;
}

export function onConfigReload(listener: (c: HenryConfig) => void): () => void {
  reloadListeners.add(listener);
  return () => reloadListeners.delete(listener);
}

// Hot reload: watch the directory (the file may be replaced atomically by editors) and
// debounce. The watcher is unref'd so it never keeps tests or the CLI alive.
try {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const w = watch(henryDir, { persistent: false }, (_ev, name) => {
    if (name && String(name) !== "config.json") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      reloadConfig();
      console.log(`[henry] reloaded ${configPath}`);
    }, 200);
  });
  w.on("error", () => w.close());
  w.unref?.();
} catch {
  // watching is best-effort (e.g. unsupported FS); edits then need a restart
}
