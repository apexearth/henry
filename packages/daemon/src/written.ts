// Which files a session wrote, newest first, read off its Write/Edit hook events. A Bash
// `sed -i` or `>` names no file, so it is not here: this is what the session is on record as
// writing, not every byte that moved on disk.
import { isAbsolute, resolve } from "node:path";
import type { SessionWrites } from "@henry/shared";
import { expandHome } from "./config";
import * as db from "./db";
import * as git from "./git";

/** Tools whose payload names the file they write. */
export const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "str_replace_editor"]);
/** Write calls read back; a long turn of edits to a few files is many calls per file. */
const EVENT_LIMIT = 400;
const MAX_FILES = 40;

/** Absolute paths a write event names. */
export function pathsOf(e: { cwd?: string; payload: unknown }, base?: string): string[] {
  const input = (e.payload as { tool_input?: Record<string, unknown> } | null)?.tool_input;
  if (!input) return [];
  const out: string[] = [];
  for (const key of ["file_path", "notebook_path"]) {
    const v = input[key];
    if (typeof v !== "string" || !v) continue;
    const p = expandHome(v);
    out.push(isAbsolute(p) ? resolve(p) : resolve(e.cwd ?? base ?? ".", p));
  }
  return out;
}

export function sessionWrites(sessionId: string): SessionWrites {
  const latest = new Map<string, number>();
  for (const e of db.listToolResults(sessionId, [...WRITE_TOOLS], EVENT_LIMIT)) {
    for (const p of pathsOf(e)) if (!latest.has(p)) latest.set(p, e.ts);
    if (latest.size >= MAX_FILES) break;
  }
  const files: SessionWrites["files"] = [...latest].map(([path, at]) => {
    const repo = git.resolveRepo(path)?.path;
    const rel = repo ? git.relIn(repo, path) : undefined;
    return rel ? { path, at, repo, rel } : { path, at };
  });
  return { sessionId, promptAt: db.lastPromptAt(sessionId), files };
}
