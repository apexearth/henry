// Files the UI knows about: a session's uncommitted files (vs HEAD), per-repo indexes for
// ⌘K, and the paths peeked recently. All fetched from the daemon; nothing here is pushed.
import { useEffect, useState } from "react";
import type { DirIndex, SessionFiles } from "@henry/shared";
import { useStore } from "./ws";

export async function fetchSessionFiles(sessionId: string): Promise<SessionFiles> {
  const r = await fetch(`/api/session/files?sessionId=${encodeURIComponent(sessionId)}`);
  return r.ok ? ((await r.json()) as SessionFiles) : { sessionId, repos: [] };
}

/** Uncommitted files in one session's repos. Refetched whenever the daemon re-broadcasts its repo state. */
export function useSessionFiles(sessionId: string | null): SessionFiles | undefined {
  const repos = useStore((s) => (sessionId ? s.repos[sessionId] : undefined));
  const [files, setFiles] = useState<SessionFiles>();
  useEffect(() => {
    if (!sessionId) return;
    let on = true;
    fetchSessionFiles(sessionId).then((f) => on && setFiles(f));
    return () => {
      on = false;
    };
  }, [sessionId, repos]);
  return files && files.sessionId === sessionId ? files : undefined;
}

const INDEX_TTL_MS = 10_000;
const index = new Map<string, { at: number; files: string[] }>();

/** Every path in the repo containing `repoPath`, relative to its root; on `peer` when given. */
export async function repoIndex(repoPath: string, peer?: string): Promise<string[]> {
  const key = `${peer ?? ""}\n${repoPath}`;
  const hit = index.get(key);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.files;
  const r = await fetch(`/api/repo/files?repo=${encodeURIComponent(repoPath)}${peer ? `&peer=${encodeURIComponent(peer)}` : ""}`);
  const files = r.ok ? ((await r.json()) as string[]) : [];
  index.set(key, { at: Date.now(), files });
  return files;
}

/**
 * Every file under a files-pane root. A repo answers from `git ls-files`, which gets .gitignore
 * and untracked files for free; a pinned folder that holds no repo is walked by the daemon
 * instead. `listFiles` returns nothing for a non-repo, which is what picks the second path —
 * one wasted call per root per TTL, in exchange for the caller never having to know which it is.
 */
export interface RootIndex {
  files: string[];
  /** The daemon's walk hit its cap: the tree is not the whole folder. */
  truncated: boolean;
}

export async function rootIndex(path: string, peer?: string): Promise<RootIndex> {
  const files = await repoIndex(path, peer);
  if (files.length) return { files, truncated: false };
  const key = `${peer ?? ""}\n${path}`;
  const hit = dirIndex.get(key);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.index;
  const r = await fetch(`/api/fs/tree?path=${encodeURIComponent(path)}${peer ? `&peer=${encodeURIComponent(peer)}` : ""}`);
  const body = r.ok ? ((await r.json()) as DirIndex) : undefined;
  const index: RootIndex = { files: body?.files ?? [], truncated: body?.truncated ?? false };
  dirIndex.set(key, { at: Date.now(), index });
  return index;
}

const dirIndex = new Map<string, { at: number; index: RootIndex }>();

const RECENT_KEY = "henry.recentFiles";
const RECENT_MAX = 40;

export function recentFiles(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function noteRecent(path: string): void {
  const list = [path, ...recentFiles().filter((p) => p !== path)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private mode: recents just don't persist */
  }
}

export function splitPath(rel: string): { dir: string; name: string } {
  const i = rel.lastIndexOf("/");
  return { dir: rel.slice(0, i + 1), name: rel.slice(i + 1) };
}
