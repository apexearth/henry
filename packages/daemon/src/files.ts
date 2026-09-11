// File peeks: read one file for the UI to show over the terminal. Loopback-only, the user's
// own machine, so any readable regular file is fair game; size is capped so a stray click on
// a log never ships megabytes.
import { openSync, readSync, closeSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DirIndex, FilePeek } from "@henry/shared";
import { expandHome } from "./config";
import * as git from "./git";

const CAP_BYTES = 1024 * 1024;

/** `raw` may be `~/x`, absolute, or relative to `cwd` (the session's). Undefined: no such file. */
export function readPeek(raw: string, cwd?: string): FilePeek | undefined {
  const expanded = expandHome(raw.trim());
  if (!expanded) return undefined;
  const abs = isAbsolute(expanded) ? expanded : cwd ? resolve(expandHome(cwd), expanded) : undefined;
  if (!abs) return undefined;
  let path: string;
  let size: number;
  try {
    path = realpathSync(abs);
    const st = statSync(path);
    if (!st.isFile()) return undefined;
    size = st.size;
  } catch {
    return undefined;
  }
  const buf = Buffer.alloc(Math.min(size, CAP_BYTES));
  const fd = openSync(path, "r");
  let n = 0;
  try {
    n = readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }
  const head = buf.subarray(0, Math.min(n, 8192));
  const binary = head.includes(0);
  const repo = git.resolveRepo(path);
  return {
    path,
    repoPath: repo?.path,
    rel: repo ? git.relIn(repo.path, path) : undefined,
    size,
    truncated: size > n,
    binary,
    content: binary ? "" : buf.subarray(0, n).toString("utf8"),
  };
}

// ---- the files pane's tree, for roots that are not git repos ----
// A repo uses git.listFiles, which gets .gitignore and the untracked/ignored distinction for
// free. A plain folder has none of that, so the walk carries its own skip list: the directories
// that are always build output or dependencies, and never what you opened the pane to read.

const DIR_CAP_FILES = 20_000;
const DIR_TTL_MS = 10_000;
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
  "target", "dist", "build", "out", ".next", ".nuxt", ".turbo", ".cache", ".gradle", ".idea",
  "vendor", "Pods", "DerivedData", ".terraform", ".tox", ".svn", ".hg",
]);

const dirCache = new Map<string, { at: number; index: DirIndex }>();

/** Every file under `raw`, relative and forward-slashed, skipping build and dependency dirs.
 *  Breadth-first so a shallow, wide tree still reads usefully when the cap cuts it off. */
export function readDirIndex(raw: string): DirIndex | undefined {
  const expanded = expandHome(raw.trim());
  if (!expanded || !isAbsolute(expanded)) return undefined;
  let root: string;
  try {
    root = realpathSync(expanded);
    if (!statSync(root).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const hit = dirCache.get(root);
  if (hit && Date.now() - hit.at < DIR_TTL_MS) return hit.index;

  const files: string[] = [];
  let truncated = false;
  const queue: string[] = [""];
  // Symlinked directories are not followed: a link back up the tree would walk forever.
  while (queue.length && !truncated) {
    const rel = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip it, the rest of the tree is still worth showing
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(child);
      } else if (e.isFile()) {
        if (files.length >= DIR_CAP_FILES) {
          truncated = true;
          break;
        }
        files.push(child);
      }
    }
  }
  files.sort();
  const index: DirIndex = { path: root, files, truncated };
  dirCache.set(root, { at: Date.now(), index });
  return index;
}

/** For GET /api/debug/memory. */
export function stats(): Record<string, number> {
  let cached = 0;
  for (const v of dirCache.values()) cached += v.index.files.length;
  return { fsDirCache: dirCache.size, fsDirCachePaths: cached };
}
