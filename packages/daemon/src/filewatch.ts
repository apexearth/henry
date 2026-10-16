// Working-tree watchers for the folders a files pane is showing. The git watcher sees `.git`
// only, so a file made in the working tree reached the tree when a hook or the poll happened to
// re-read the repo and its 10 s listing had also run out. This watches the tree itself, but only
// while a window keeps asking for that folder's listing: a lease, renewed by each listing, so
// the cost follows what is on screen rather than every repo a session ever touched.
import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";

const LEASE_MS = 3 * 60_000;
const MAX_ROOTS = 12;
const QUIET_MS = 250;
/** A tree that never stops changing (a build writing into it) still reports this often. */
const MAX_WAIT_MS = 2_000;

interface Watched {
  watcher: FSWatcher;
  until: number;
  /** Folders (relative, "/"-terminated) whose churn changes no listing: .gitignore'd ones. */
  quiet: string[];
  timer?: ReturnType<typeof setTimeout>;
  first?: number;
}

const roots = new Map<string, Watched>();
let onChange: (root: string) => void = () => {};
let sweep: ReturnType<typeof setInterval> | undefined;

export function setOnChange(fn: (root: string) => void): void {
  onChange = fn;
}

/** Keep `root` watched for a while longer; `quiet` replaces its ignored-folder list when given. */
export function interest(root: string, quiet?: string[]): void {
  const now = Date.now();
  const w = roots.get(root);
  if (w) {
    w.until = now + LEASE_MS;
    if (quiet) w.quiet = quiet;
    return;
  }
  if (roots.size >= MAX_ROOTS) {
    const oldest = [...roots.entries()].sort((a, b) => a[1].until - b[1].until)[0];
    if (oldest) drop(oldest[0]);
  }
  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true, persistent: false }, (_ev, name) => changed(root, name ? String(name) : ""));
  } catch {
    return; // not a folder, or no recursive watch here: the listing's TTL still applies
  }
  watcher.on("error", () => drop(root));
  roots.set(root, { watcher, until: now + LEASE_MS, quiet: quiet ?? [] });
  if (!sweep) {
    sweep = setInterval(() => {
      const t = Date.now();
      for (const [r, w] of roots) if (w.until < t) drop(r);
    }, 60_000);
    sweep.unref();
  }
}

/** True while `root` is watched: its listing stays valid until the watcher says otherwise. */
export function watched(root: string): boolean {
  return roots.has(root);
}

function changed(root: string, name: string): void {
  const w = roots.get(root);
  if (!w) return;
  const rel = name.split(sep).join("/");
  if (rel === ".git" || rel.startsWith(".git/") || rel.includes("/.git/")) return;
  if (w.quiet.some((q) => rel.startsWith(q) || rel === q.slice(0, -1))) return;
  const now = Date.now();
  w.first ??= now;
  if (w.timer) clearTimeout(w.timer);
  w.timer = setTimeout(() => fire(root), now - w.first >= MAX_WAIT_MS ? 0 : QUIET_MS);
}

function fire(root: string): void {
  const w = roots.get(root);
  if (!w) return;
  w.timer = undefined;
  w.first = undefined;
  onChange(root);
}

function drop(root: string): void {
  const w = roots.get(root);
  if (!w) return;
  if (w.timer) clearTimeout(w.timer);
  try {
    w.watcher.close();
  } catch {
    /* already gone */
  }
  roots.delete(root);
}

export function stats(): Record<string, number> {
  return { treeWatchers: roots.size };
}

export function stop(): void {
  for (const r of [...roots.keys()]) drop(r);
  if (sweep) clearInterval(sweep);
  sweep = undefined;
}
