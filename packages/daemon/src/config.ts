import { existsSync, mkdirSync, readFileSync } from "node:fs";
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

export const config: HenryConfig = load();
