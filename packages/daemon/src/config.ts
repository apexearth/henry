import { existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, type HenryConfig } from "@henry/shared";

/** ~/.henry (override with HENRY_HOME, used by tests to stay out of the real one). */
export const henryDir = process.env.HENRY_HOME ? resolve(process.env.HENRY_HOME) : join(homedir(), ".henry");
export const configPath = join(henryDir, "config.json");

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function load(): HenryConfig {
  if (!existsSync(henryDir)) mkdirSync(henryDir, { recursive: true });
  let user: Partial<HenryConfig> = {};
  if (existsSync(configPath)) {
    try {
      user = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (e) {
      console.error(`[henry] could not parse ${configPath}: ${(e as Error).message}; using defaults`);
    }
  }
  const merged: HenryConfig = {
    ...DEFAULT_CONFIG,
    ...user,
    overseer: { ...DEFAULT_CONFIG.overseer, ...(user.overseer ?? {}) },
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
