// Files the UI knows about: a session's changed files (vs its baseline), per-repo indexes for
// ⌘K, and the paths peeked recently. All fetched from the daemon; nothing here is pushed.
import { useEffect, useState } from "react";
import type { DirIndex, DirListing, RepoFiles, SessionFiles } from "@henry/shared";
import { onFilesChanged, useStore } from "./ws";

export async function fetchSessionFiles(sessionId: string): Promise<SessionFiles> {
  const r = await fetch(`/api/session/files?sessionId=${encodeURIComponent(sessionId)}`);
  return r.ok ? ((await r.json()) as SessionFiles) : { sessionId, repos: [] };
}

const reloads = new Set<() => void>();

/** Ask every `useSessionFiles` again: something the answer depends on changed here (a hide). */
export function reloadSessionFiles(): void {
  reloads.forEach((cb) => cb());
}

/**
 * Changed files of one session. Refetched whenever the daemon re-broadcasts its repo state, and
 * when a folder of one of its repos changes on disk: a file that goes from modified to clean
 * while another goes the other way leaves the dirty count, and so the broadcast, where it was.
 */
export function useSessionFiles(sessionId: string | null): SessionFiles | undefined {
  const repos = useStore((s) => (sessionId ? s.repos[sessionId] : undefined));
  const [files, setFiles] = useState<SessionFiles>();
  const [bump, setBump] = useState(0);
  useEffect(() => {
    const again = () => setBump((n) => n + 1);
    reloads.add(again);
    const off = onFilesChanged((root) => {
      if (files?.repos.some((r) => r.path === root)) again();
    });
    return () => {
      reloads.delete(again);
      off();
    };
  }, [files]);
  useEffect(() => {
    if (!sessionId) return;
    let on = true;
    fetchSessionFiles(sessionId).then((f) => on && setFiles(f));
    return () => {
      on = false;
    };
  }, [sessionId, repos, bump]);
  return files && files.sessionId === sessionId ? files : undefined;
}

const INDEX_TTL_MS = 10_000;
const index = new Map<string, { at: number; files: string[] }>();

// The daemon names the folder that changed by its realpath; drop every cached listing of it.
onFilesChanged((root) => {
  for (const m of [index, dirIndex] as Map<string, unknown>[]) {
    for (const key of m.keys()) if (key.slice(key.indexOf("\n") + 1) === root) m.delete(key);
  }
});

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
 * and untracked files for free, and adds what .gitignore hides; a pinned folder that holds no
 * repo is walked by the daemon instead. Either request keeps the daemon watching that folder
 * while the pane keeps asking, and its `files:changed` drops the copy cached here.
 */
export interface RootIndex {
  files: string[];
  /** Git-ignored files, and wholly ignored folders as "dir/". Empty for a plain folder. */
  ignored: string[];
  /** Folders with nothing in them, which no file path would show. */
  empty: string[];
  /** The daemon's walk hit its cap: the tree is not the whole folder. */
  truncated: boolean;
  /** The root as the daemon names it (realpath), which is what `files:changed` carries. */
  root?: string;
}

export async function rootIndex(path: string, peer?: string): Promise<RootIndex> {
  const key = `${peer ?? ""}\n${path}`;
  const hit = dirIndex.get(key);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.index;
  const q = `${peer ? `&peer=${encodeURIComponent(peer)}` : ""}`;
  const r = await fetch(`/api/repo/files?repo=${encodeURIComponent(path)}&ignored=1${q}`);
  // A peer on an older Henry answers with the bare list.
  const body = r.ok ? ((await r.json()) as RepoFiles | string[]) : [];
  let index: RootIndex = Array.isArray(body)
    ? { files: body, ignored: [], empty: [], truncated: false }
    : { files: body.files, ignored: body.ignored, empty: body.empty ?? [], truncated: false, root: body.root };
  if (!index.files.length && !index.ignored.length) {
    const d = await fetch(`/api/fs/tree?path=${encodeURIComponent(path)}${q}`);
    const tree = d.ok ? ((await d.json()) as DirIndex) : undefined;
    index = { files: tree?.files ?? [], ignored: [], empty: [], truncated: tree?.truncated ?? false, root: tree?.path };
  }
  dirIndex.set(key, { at: Date.now(), index });
  return index;
}

const dirIndex = new Map<string, { at: number; index: RootIndex }>();

/** Drop a root's cached listings (⌘K's and the tree's): something under it changed. */
export function forgetIndex(path: string, peer?: string): void {
  const key = `${peer ?? ""}\n${path}`;
  index.delete(key);
  dirIndex.delete(key);
}

/** One folder's entries, for opening a folder .gitignore hides. */
export async function listDir(path: string, peer?: string): Promise<DirListing> {
  const r = await fetch(`/api/fs/list?path=${encodeURIComponent(path)}${peer ? `&peer=${encodeURIComponent(peer)}` : ""}`);
  return r.ok ? ((await r.json()) as DirListing) : { dirs: [], files: [] };
}

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
