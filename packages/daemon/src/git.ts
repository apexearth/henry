// Milestone 3: repo discovery incl. worktrees, per-session baselines (db.upsertBaseline),
// status/ahead/behind, diff vs baseline, watch+poll, broadcast {type:"repos:update"}.
import { readdirSync, statSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { RepoPickerEntry, RepoState } from "@henry/shared";

/** Dirs directly under `root` that contain a .git (dir or worktree file). Milestone 3 adds worktree detail. */
export async function listRepos(root: string): Promise<RepoPickerEntry[]> {
  if (!existsSync(root)) return [];
  const out: RepoPickerEntry[] = [];
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(root, name);
    try {
      if (!statSync(path).isDirectory()) continue;
      const git = join(path, ".git");
      if (!existsSync(git)) continue;
      out.push({ path, name: basename(path), isWorktree: statSync(git).isFile() });
    } catch {
      // unreadable entry; skip
    }
  }
  return out;
}

/** Repos this session has touched, with live state. */
export function getSessionRepos(_sessionId: string): RepoState[] {
  return [];
}

/** All sessions' repo state, keyed by session id (used for the state snapshot). */
export function getAllSessionRepos(): Record<string, RepoState[]> {
  return {};
}

export async function diffSinceBaseline(_sessionId: string, _repoPath: string): Promise<{ diff: string; baseline: string }> {
  return { diff: "", baseline: "" };
}

/**
 * Called by hooks.ts whenever a session's hook event carries a cwd or file path.
 * Milestone 3: resolve `absPath` to its repo (walk up to .git), record the
 * session→repo association and baseline (db.upsertBaseline on first touch),
 * then refresh and broadcast {type:"repos:update"} for that session.
 */
export function noteSessionPath(_sessionId: string, _absPath: string): void {}
