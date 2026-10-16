// The Files tool. Roots are the repos the session you are looking at works in, plus whatever
// you pinned, so reading code still feels like being inside that session; each repo's root row
// doubles as its card (branch, ↑↓, dirty count, diff / tree / remote — FilesRoot.tsx). A repo
// the session has not touched for hours folds under "earlier".
// One filter, two modes: file names (fuzzy, client-side over the repo index) or file contents
// (`git grep` on the daemon). Either way the *tree* narrows - matches keep their parent folders,
// because where a match sits is half of what you wanted to know. Aa / .* / ab| / glob are the
// search's usual knobs. A click opens a peek in the stage; the right-click menu makes files and
// folders, renames, moves to the trash, copies paths and shows things in the file manager.
// The listing follows the disk: the daemon watches what this pane shows and says when it moved.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangedFile, DirListing, FilePeek, GrepResult, RepoState } from "@henry/shared";
import { restoreFocus, showTool } from "./dock";
import { openPeek } from "./FileView";
import { FilesRoot } from "./FilesRoot";
import { forgetIndex, listDir, reloadSessionFiles, rootIndex, useSessionFiles, type RootIndex } from "./files";
import { globFilter, matches, tokenize } from "./match";
import { FILE_MANAGER, baseName, joinPath, onLoopback, revealFolder } from "./platform";
import { ancestorsOf, buildTree, type TreeNode } from "./tree";
import { getState, onFilesChanged, useStore } from "./ws";

const MAX_ROWS = 2000;
const MIN_TEXT_QUERY = 2;
const TEXT_DEBOUNCE_MS = 150;
/** Up to this many hits, every matching file shows its lines; past it they start folded. */
const AUTO_OPEN_HITS = 40;
/** The daemon watches a folder while a window keeps asking for it; this is the asking. */
const RENEW_MS = 60_000;

interface Root {
  path: string;
  name: string;
  pinned: boolean;
  /** Not touched by the session lately: listed only when "earlier" is open. */
  earlier?: boolean;
  /** The session's cwd is in it. */
  here?: boolean;
}

interface Opts {
  caseSensitive: boolean;
  regex: boolean;
  word: boolean;
  glob: string;
  changedOnly: boolean;
  hideIgnored: boolean;
}

const DEFAULT_OPTS: Opts = { caseSensitive: false, regex: false, word: false, glob: "", changedOnly: false, hideIgnored: false };
const OPTS_KEY = "henry.filesOpts";
const OPEN_KEY = "henry.filesOpen";

function loadOpts(): Opts {
  try {
    const v = JSON.parse(localStorage.getItem(OPTS_KEY) ?? "{}") as Partial<Opts>;
    return {
      caseSensitive: v.caseSensitive === true,
      regex: v.regex === true,
      word: v.word === true,
      glob: typeof v.glob === "string" ? v.glob : "",
      changedOnly: v.changedOnly === true,
      hideIgnored: v.hideIgnored === true,
    };
  } catch {
    return { ...DEFAULT_OPTS };
  }
}

function loadOpen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: the pane just starts fresh next time */
  }
}

/** A node's key in the expanded set. NUL because it is the one byte a path cannot hold.
 *  A root is keyed with an empty rel; a file's *hit list* is its own fold, keyed "hits:". */
const nodeKey = (rootPath: string, rel: string) => `${rootPath}\u0000${rel}`;
const hitsKey = (rootPath: string, rel: string) => nodeKey(rootPath, `hits:${rel}`);

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((p, i) => p === b[i]);

/** Same listing: a re-read that found nothing new should not re-render the tree. */
function sameIndex(a: RootIndex | undefined, b: RootIndex): boolean {
  return !!a && a.truncated === b.truncated && sameList(a.files, b.files) && sameList(a.ignored, b.ignored) && sameList(a.empty, b.empty);
}

async function fetchChanges(repoPath: string, peer?: string): Promise<ChangedFile[]> {
  const r = await fetch(`/api/repo/changes?repo=${encodeURIComponent(repoPath)}${peer ? `&peer=${encodeURIComponent(peer)}` : ""}`);
  return r.ok ? ((await r.json()) as ChangedFile[]) : [];
}

async function fetchGrep(q: string, roots: string[], o: Opts, peer: string | undefined, signal: AbortSignal): Promise<GrepResult> {
  const p = new URLSearchParams({ q });
  for (const r of roots) p.append("repo", r);
  if (o.caseSensitive) p.set("case", "1");
  if (o.regex) p.set("regex", "1");
  if (o.word) p.set("word", "1");
  if (o.glob.trim()) p.set("glob", o.glob.trim());
  if (peer) p.set("peer", peer);
  const r = await fetch(`/api/repo/grep?${p}`, { signal });
  return r.ok ? ((await r.json()) as GrepResult) : { hits: [], truncated: false };
}

/** The matched span of a hit line: the server's column, checked against the text. */
function matchSpan(text: string, col: number, q: string, o: Opts): [number, number] | undefined {
  if (o.regex) return undefined; // the pattern is not the matched text; don't guess at a span
  const at = col - 1;
  const sensitive = o.caseSensitive || q !== q.toLowerCase();
  const same = (a: string, b: string) => (sensitive ? a === b : a.toLowerCase() === b.toLowerCase());
  if (at >= 0 && same(text.slice(at, at + q.length), q)) return [at, at + q.length];
  const i = sensitive ? text.indexOf(q) : text.toLowerCase().indexOf(q.toLowerCase());
  return i >= 0 ? [i, i + q.length] : undefined;
}

/** Where a new file goes: a root and a folder in it ("" for the root itself). */
interface Spot {
  root: Root;
  dir: string;
}

const parentOf = (rel: string) => rel.slice(0, Math.max(0, rel.lastIndexOf("/")));

/** The folder a row stands for: the root, the folder, or the folder a file sits in. */
function spotOf(row: Row): Spot | undefined {
  if (row.kind === "root") return { root: row.root, dir: "" };
  if (row.kind === "dir") return { root: row.root, dir: row.rel };
  if (row.kind === "file") return { root: row.root, dir: parentOf(row.rel) };
  return undefined;
}

/** A typed file name, cleaned: slashes make folders, nothing climbs out of the spot. */
function cleanName(raw: string): string | undefined {
  const parts = raw.trim().replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || parts.some((p) => p === "." || p === "..")) return undefined;
  return parts.join("/");
}

async function post<T>(url: string, body: unknown): Promise<T | { error: string }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  return r.ok ? out : { error: out.error ?? r.statusText };
}

const createFile = (path: string) => post<FilePeek>("/api/file", { path, content: "", create: true });

/** The inline name row: a new file or folder under `spot`, or a rename of `rel` in place. */
type Edit =
  | { mode: "file" | "folder"; spot: Spot; name: string; error?: string; busy?: boolean }
  | { mode: "rename"; root: Root; rel: string; dir: boolean; name: string; error?: string; busy?: boolean };

type Row =
  | { kind: "root"; key: string; root: Root; open: boolean; depth: number }
  | { kind: "new"; key: string; depth: number }
  | { kind: "dir"; key: string; root: Root; rel: string; name: string; open: boolean; depth: number; dirty: boolean; ignored: boolean }
  | { kind: "file"; key: string; root: Root; rel: string; name: string; depth: number; status?: ChangedFile["status"]; hits?: number; open?: boolean; ignored: boolean }
  | { kind: "hit"; key: string; root: Root; rel: string; line: number; col: number; text: string; depth: number }
  | { kind: "earlier"; key: string; count: number; open: boolean; depth: number }
  | { kind: "note"; key: string; text: string; depth: number };

/** ⌘F / ⌘⇧F: bring the tool forward and put the keyboard in its filter, in `text` mode when
 *  a term is given. The request is parked in `pending` as well as announced, because the pane
 *  may not be mounted yet — its tab may have been behind another tool, or gone. */
export const FILES_EVENT = "henry:files";
let pending: { at: number; text?: string } | undefined;

export function openFiles(text?: string): void {
  pending = { at: Date.now(), text };
  showTool("files");
  window.dispatchEvent(new CustomEvent(FILES_EVENT, { detail: { text } }));
}

export function FilesPane() {
  const activeId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const sessionRepos = useStore((s) => (activeId ? s.repos[activeId] : undefined));
  const config = useStore((s) => s.config);
  const sf = useSessionFiles(activeId);
  const peer = useMemo(() => sessions.find((s) => s.id === activeId)?.peer, [sessions, activeId]);

  const [text, setText] = useState(!!pending?.text);
  const [query, setQuery] = useState(pending?.text ?? "");
  const [opts, setOpts] = useState<Opts>(loadOpts);
  const [open, setOpen] = useState<Set<string>>(() => new Set(loadOpen()));
  const [indexes, setIndexes] = useState<Record<string, RootIndex>>({});
  /** Git-ignored folders read so far, per root then folder: they are listed only when opened. */
  const [lazy, setLazy] = useState<Record<string, Record<string, DirListing>>>({});
  const [changes, setChanges] = useState<Record<string, ChangedFile[]>>({});
  const [sel, setSel] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [newRoot, setNewRoot] = useState("");
  const [pinError, setPinError] = useState<string | undefined>();
  const [wide, setWide] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row; confirm?: boolean; error?: string } | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadingDirs = useRef(new Set<string>());

  useEffect(() => save(OPTS_KEY, opts), [opts]);
  useEffect(() => save(OPEN_KEY, [...open]), [open]);

  // Take the parked request on mount (the shortcut is what switched the pane in), and answer
  // later ones while it stays mounted.
  useEffect(() => {
    const take = (want: { text?: string } | undefined) => {
      if (!want) return;
      if (want.text) {
        setText(true);
        setQuery(want.text);
      }
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    take(pending);
    pending = undefined;
    const onOpen = (e: Event) => take((e as CustomEvent<{ text?: string }>).detail);
    window.addEventListener(FILES_EVENT, onOpen);
    return () => window.removeEventListener(FILES_EVENT, onOpen);
  }, []);

  // Roots: the session's repos first (that is the "inside this session" part), then pins, then
  // what the session touched long ago, when asked for.
  //
  // The repo list comes from /api/session/files rather than the store's `repos`, because the
  // store's is built from hook events: a plain terminal fires none, so a shell sitting in a
  // repo would show an empty tree. That endpoint falls back to the repo the session's cwd is
  // in, says which repos are history, and hands back each file's status in the same answer, so
  // the tree's change marks and its roots cost one request between them.
  const { roots, earlierCount } = useMemo(() => {
    const out: Root[] = [];
    const later: Root[] = [];
    const seen = new Set<string>();
    for (const r of sf?.repos ?? []) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      (r.earlier ? later : out).push({ path: r.path, name: r.name, pinned: false, earlier: r.earlier, here: r.here });
    }
    // While that first answer is in flight, the store knows them too.
    if (!sf) {
      for (const r of (sessionRepos ?? []) as RepoState[]) {
        if (seen.has(r.path)) continue;
        seen.add(r.path);
        out.push({ path: r.path, name: r.name, pinned: false });
      }
    }
    for (const p of config?.files?.roots ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ path: p, name: baseName(p), pinned: true });
    }
    return { roots: showEarlier ? [...out, ...later] : out, earlierCount: later.length };
  }, [sf, sessionRepos, config, showEarlier]);

  /** The git watcher's card for each root that is a repo of this session, by path. */
  const cards = useMemo(() => new Map(((sessionRepos ?? []) as RepoState[]).map((r) => [r.path, r] as const)), [sessionRepos]);

  /** Uncommitted status per file, i.e. `git status`: the session's answer also lists what it
   *  changed vs its baseline and has since committed, but in a repo several sessions share that
   *  is everyone's commits since this one began, a different wall of marks in every session for
   *  the same folder. The tree drops those; the pinned-folder read is vs HEAD to begin with. */
  const statusFor = useCallback((rootPath: string): Map<string, ChangedFile["status"]> => {
    const fromSession = sf?.repos.find((r) => r.path === rootPath);
    const list = fromSession ? fromSession.files : changes[rootPath] ?? [];
    return new Map(list.filter((c) => !c.committed).map((c) => [c.path, c.status] as const));
  }, [sf, changes]);

  const rootsKey = roots.map((r) => r.path).join("\n");
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const peerRef = useRef(peer);
  peerRef.current = peer;
  const indexesRef = useRef(indexes);
  indexesRef.current = indexes;

  // One root open by default, so the pane is never a wall of closed folders.
  useEffect(() => {
    if (!roots.length) return;
    setOpen((prev) => (roots.some((r) => prev.has(nodeKey(r.path, ""))) ? prev : new Set([...prev, nodeKey(roots[0].path, "")])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey]);

  /** Read one root's listing (and a pinned folder's marks) again; `force` skips the 10 s cache. */
  const load = useCallback((r: Root, force: boolean) => {
    const asked = peerRef.current;
    if (force) forgetIndex(r.path, asked);
    rootIndex(r.path, asked).then((idx) => {
      if (peerRef.current !== asked) return;
      setIndexes((prev) => (sameIndex(prev[r.path], idx) ? prev : { ...prev, [r.path]: idx }));
    });
    if (force) setLazy((prev) => (prev[r.path] ? { ...prev, [r.path]: {} } : prev));
  }, []);

  // Every root on the same signal as the change marks (`sf` follows the daemon's repo
  // broadcasts), cached for 10 s, so a broadcast costs one cheap call per root.
  useEffect(() => {
    for (const r of roots) load(r, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, peer, sf]);

  // The daemon says when a folder it watches for this pane moved on disk. Coming back to the
  // window reads everything again, and so does a slow beat, which is also what keeps the
  // daemon watching: it stops when no window has asked for a folder in a few minutes.
  useEffect(() => {
    const all = () => {
      for (const r of rootsRef.current) load(r, true);
    };
    const offChanged = onFilesChanged((root) => {
      for (const r of rootsRef.current) {
        if (r.path !== root && indexesRef.current[r.path]?.root !== root) continue;
        load(r, true);
        if (r.pinned) fetchChanges(r.path, peerRef.current).then((c) => setChanges((prev) => ({ ...prev, [r.path]: c })));
      }
    });
    const onFocus = () => all();
    window.addEventListener("focus", onFocus);
    const beat = setInterval(() => document.visibilityState === "visible" && all(), RENEW_MS);
    return () => {
      offChanged();
      window.removeEventListener("focus", onFocus);
      clearInterval(beat);
    };
  }, [load]);

  // Status for pinned folders, which the session's answer does not cover. Not on `sf`: a pinned
  // folder is by definition not one of the session's repos, so its broadcasts say nothing about it,
  // and this is an uncached `git status` on the daemon.
  useEffect(() => {
    let on = true;
    const known = new Set((sf?.repos ?? []).map((r) => r.path));
    for (const r of roots) {
      if (!known.has(r.path)) fetchChanges(r.path, peer).then((c) => on && setChanges((prev) => ({ ...prev, [r.path]: c })));
    }
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, peer]);

  const tokens = useMemo(() => (text ? [] : tokenize(query)), [query, text]);
  const glob = useMemo(() => globFilter(opts.glob), [opts.glob]);
  const grepQuery = text ? query.trim() : "";

  // Content mode: grep a beat after the last keystroke; a newer query aborts the one in flight,
  // and the answer carries the question it answers, so a stale one is never painted.
  const [grep, setGrep] = useState<{ q: string; sig: string; res: GrepResult } | null>(null);
  const [searching, setSearching] = useState(false);
  const scope = useMemo(() => (wide ? [] : roots.map((r) => r.path)), [rootsKey, wide]); // eslint-disable-line react-hooks/exhaustive-deps
  const sig = JSON.stringify([scope, opts.caseSensitive, opts.regex, opts.word, opts.glob]);
  useEffect(() => {
    if (grepQuery.length < MIN_TEXT_QUERY) {
      setGrep(null);
      setSearching(false);
      return;
    }
    const ctl = new AbortController();
    setSearching(true);
    const t = setTimeout(() => {
      fetchGrep(grepQuery, scope, opts, peer, ctl.signal)
        .then((res) => {
          if (ctl.signal.aborted) return;
          setGrep({ q: grepQuery, sig, res });
          setSearching(false);
        })
        .catch(() => {});
    }, TEXT_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [grepQuery, sig, peer]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = grep && grep.q === grepQuery && grep.sig === sig ? grep.res : null;

  // Hits grouped by root then file, kept in git grep order (path, then line).
  const hitsByRoot = useMemo(() => {
    const out = new Map<string, Map<string, { line: number; col: number; text: string }[]>>();
    for (const h of live?.hits ?? []) {
      let byFile = out.get(h.repo);
      if (!byFile) out.set(h.repo, (byFile = new Map()));
      let list = byFile.get(h.rel);
      if (!list) byFile.set(h.rel, (list = []));
      list.push({ line: h.line, col: h.col, text: h.text });
    }
    return out;
  }, [live]);

  // A widened search reaches repos the tree does not list; they get their own heading.
  const shownRoots = useMemo((): Root[] => {
    if (!text || !live) return roots;
    const known = new Set(roots.map((r) => r.path));
    const extra: Root[] = [];
    for (const p of hitsByRoot.keys()) {
      if (known.has(p)) continue;
      known.add(p);
      extra.push({ path: p, name: baseName(p), pinned: false });
    }
    return [...roots, ...extra];
  }, [roots, text, live, hitsByRoot]);

  const totalHits = live?.hits.length ?? 0;
  const autoOpenHits = text && totalHits > 0 && totalHits <= AUTO_OPEN_HITS;

  const rows = useMemo((): Row[] => {
    const out: Row[] = [];
    const newRow = (depth: number) => out.push({ kind: "new", key: "\u0000new", depth });
    for (const root of shownRoots) {
      if (root.earlier && !out.some((r) => r.kind === "earlier")) out.push({ kind: "earlier", key: "\u0000earlier", count: earlierCount, open: true, depth: 0 });
      const rootOpen = open.has(nodeKey(root.path, ""));
      out.push({ kind: "root", key: nodeKey(root.path, ""), root, open: rootOpen, depth: 0 });
      if (!rootOpen) continue;
      const making = edit && edit.mode !== "rename" && edit.spot.root.path === root.path ? edit.spot : undefined;
      if (making && !making.dir) newRow(1);

      const status = statusFor(root.path);
      const hitFiles = hitsByRoot.get(root.path);
      const idx = indexes[root.path];

      // What .gitignore hides: files by name, wholly ignored folders as folders that read their
      // contents when opened (`lazy`). Shown dimmed, unless the pane is told to leave them out.
      const ignoredFiles: string[] = [];
      const ignoredDirs = new Set<string>();
      if (!opts.hideIgnored) {
        for (const p of idx?.ignored ?? []) {
          if (p.endsWith("/")) ignoredDirs.add(p.slice(0, -1));
          else ignoredFiles.push(p);
        }
      }
      const lazyFiles: string[] = [];
      const lazyDirs: string[] = [];
      for (const [dir, l] of Object.entries(lazy[root.path] ?? {})) {
        if (!ignoredDirs.has(dir) && ![...ignoredDirs].some((d) => dir.startsWith(d + "/"))) continue;
        for (const f of l.files) lazyFiles.push(`${dir}/${f}`);
        for (const d of l.dirs) lazyDirs.push(`${dir}/${d}`);
      }
      const ignoredSet = new Set(ignoredFiles);
      const isIgnored = (rel: string) => {
        if (ignoredSet.has(rel) || ignoredDirs.has(rel)) return true;
        for (let at = rel.lastIndexOf("/"); at > 0; at = rel.lastIndexOf("/", at - 1)) if (ignoredDirs.has(rel.slice(0, at))) return true;
        return false;
      };

      // Which files this root contributes, before the tree is built.
      const filtering = text || tokens.length > 0 || !!glob || opts.changedOnly;
      let paths: string[];
      let dirs: string[] = [];
      if (text) {
        paths = [...(hitFiles?.keys() ?? [])];
      } else {
        paths = idx ? [...idx.files, ...ignoredFiles, ...lazyFiles] : [];
        if (glob) paths = paths.filter(glob);
        if (opts.changedOnly) paths = paths.filter((p) => status.has(p));
        if (tokens.length) paths = paths.filter((p) => matches(tokens, p) !== -Infinity);
        // A folder with nothing listed in it shows only while nothing is filtering the tree.
        if (!filtering) dirs = [...(idx?.empty ?? []), ...ignoredDirs, ...lazyDirs];
      }

      if (!paths.length && !dirs.length) {
        const why = text
          ? live ? "no matches here" : ""
          : idx === undefined ? "reading..."
            : opts.changedOnly ? "nothing changed"
              : tokens.length || glob ? "no matches here" : "empty";
        if (why) out.push({ kind: "note", key: nodeKey(root.path, "\u0000empty"), text: why, depth: 1 });
        continue;
      }

      // A filter opens the tree onto what it found; an unfiltered tree stays where you left it.
      const forced = filtering ? ancestorsOf(paths) : undefined;
      const isOpen = (rel: string) => (forced?.has(rel) ?? false) || open.has(nodeKey(root.path, rel));
      // A folder carries the change marks of what is inside it, so a closed tree still shows
      // where the work is. Only over the files this filter shows: a folder cannot look dirty
      // on the strength of a file you filtered away.
      const dirtyDirs = ancestorsOf(paths.filter((p) => status.has(p)));
      const renaming = edit?.mode === "rename" && edit.root.path === root.path ? edit.rel : undefined;

      const walk = (nodes: TreeNode[], depth: number) => {
        for (const n of nodes) {
          if (out.length >= MAX_ROWS) return;
          if (n.rel === renaming) {
            newRow(depth);
            if (!n.dir) continue;
          }
          if (n.dir) {
            const o = isOpen(n.rel);
            if (n.rel !== renaming) {
              out.push({ kind: "dir", key: nodeKey(root.path, n.rel), root, rel: n.rel, name: n.name, open: o, depth, dirty: dirtyDirs.has(n.rel), ignored: isIgnored(n.rel) });
            }
            if (o && making?.dir === n.rel) newRow(depth + 1);
            if (o) walk(n.children, depth + 1);
            continue;
          }
          const hits = hitFiles?.get(n.rel);
          // With few hits they all show and the set records what you closed; with many they
          // start closed and it records what you opened. Either way one click flips this file.
          const fileOpen = hits ? open.has(hitsKey(root.path, n.rel)) !== autoOpenHits : undefined;
          out.push({ kind: "file", key: nodeKey(root.path, n.rel), root, rel: n.rel, name: n.name, depth, status: status.get(n.rel), hits: hits?.length, open: fileOpen, ignored: isIgnored(n.rel) });
          if (hits && fileOpen) {
            for (const h of hits) {
              if (out.length >= MAX_ROWS) return;
              out.push({ kind: "hit", key: `${nodeKey(root.path, n.rel)}:${h.line}`, root, rel: n.rel, line: h.line, col: h.col, text: h.text, depth: depth + 1 });
            }
          }
        }
      };
      walk(buildTree(paths, dirs), 1);
    }
    if (earlierCount && !showEarlier) out.push({ kind: "earlier", key: "\u0000earlier", count: earlierCount, open: false, depth: 0 });
    if (out.length >= MAX_ROWS) out.push({ kind: "note", key: "\u0000more", text: "too many to list - narrow the filter", depth: 1 });
    return out;
  }, [shownRoots, open, indexes, lazy, statusFor, tokens, glob, opts.changedOnly, opts.hideIgnored, text, hitsByRoot, live, autoOpenHits, edit, earlierCount, showEarlier]);

  // An ignored folder that is open but not yet read: read it. Its contents join the tree.
  useEffect(() => {
    for (const r of rows) {
      if (r.kind !== "dir" || !r.ignored || !r.open || lazy[r.root.path]?.[r.rel]) continue;
      const key = nodeKey(r.root.path, r.rel);
      if (loadingDirs.current.has(key)) continue;
      loadingDirs.current.add(key);
      listDir(joinPath(r.root.path, r.rel), peer)
        .then((l) => setLazy((prev) => ({ ...prev, [r.root.path]: { ...prev[r.root.path], [r.rel]: l } })))
        .finally(() => loadingDirs.current.delete(key));
    }
  }, [rows, lazy, peer]);

  const selIdx = Math.max(0, rows.findIndex((r) => r.key === sel));
  const current = rows[selIdx];
  useEffect(() => {
    listRef.current?.children[selIdx]?.scrollIntoView({ block: "nearest" });
  }, [selIdx, rows.length]);

  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** Every folder closed; the roots stay as they were. */
  const collapseAll = () => setOpen((prev) => new Set([...prev].filter((k) => k.endsWith("\u0000"))));

  // "new file" / "new folder" from the menu: the spot's folders open and a name row appears.
  const startNew = (mode: "file" | "folder", spot: Spot) => {
    setMenu(null);
    setOpen((prev) => {
      const next = new Set(prev).add(nodeKey(spot.root.path, ""));
      const parts = spot.dir.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) next.add(nodeKey(spot.root.path, parts.slice(0, i).join("/")));
      return next;
    });
    setEdit({ mode, spot, name: "" });
  };

  const startRename = (row: Row) => {
    setMenu(null);
    if (row.kind !== "file" && row.kind !== "dir") return;
    setEdit({ mode: "rename", root: row.root, rel: row.rel, dir: row.kind === "dir", name: row.rel.slice(row.rel.lastIndexOf("/") + 1) });
  };

  /** Something under `root` was made, moved or removed from here: read it again now. */
  const changedHere = (root: Root) => load(root, true);

  const finishEdit = async () => {
    if (!edit || edit.busy) return;
    const name = cleanName(edit.name);
    if (!name) return setEdit({ ...edit, error: edit.mode === "folder" ? "a folder name" : "a file name, like spec.md or docs/spec.md" });
    setEdit({ ...edit, busy: true, error: undefined });
    if (edit.mode === "rename") {
      const parent = parentOf(edit.rel);
      const to = parent ? `${parent}/${name}` : name;
      if (to === edit.rel) return setEdit(null);
      const r = await post<{ path: string }>("/api/fs/move", { from: joinPath(edit.root.path, edit.rel), to: joinPath(edit.root.path, to) });
      if ("error" in r) return setEdit({ ...edit, busy: false, error: r.error });
      // A renamed folder keeps the folds that were open inside it.
      if (edit.dir) {
        setOpen((prev) => {
          const next = new Set<string>();
          const from = nodeKey(edit.root.path, edit.rel);
          for (const k of prev) next.add(k === from || k.startsWith(from + "/") ? nodeKey(edit.root.path, to) + k.slice(from.length) : k);
          return next;
        });
      }
      setSel(nodeKey(edit.root.path, to));
      changedHere(edit.root);
      return setEdit(null);
    }
    const rel = edit.spot.dir ? `${edit.spot.dir}/${name}` : name;
    const abs = joinPath(edit.spot.root.path, rel);
    if (edit.mode === "folder") {
      const r = await post<{ path: string }>("/api/fs/mkdir", { path: abs });
      if ("error" in r) return setEdit({ ...edit, busy: false, error: r.error });
      setSel(nodeKey(edit.spot.root.path, rel));
      changedHere(edit.spot.root);
      return setEdit(null);
    }
    const r = await createFile(abs);
    if ("error" in r) return setEdit({ ...edit, busy: false, error: r.error });
    changedHere(edit.spot.root);
    setEdit(null);
    void openPeek(r.path, undefined, undefined, true);
  };

  const trash = async (row: Row) => {
    if (row.kind !== "file" && row.kind !== "dir") return;
    setMenu((m) => m && { ...m, error: undefined, confirm: true });
    const r = await post<{ path: string }>("/api/fs/trash", { path: joinPath(row.root.path, row.rel) });
    if ("error" in r) return setMenu((m) => m && { ...m, error: r.error });
    setMenu(null);
    changedHere(row.root);
  };

  const hideRoot = async (root: Root) => {
    setMenu(null);
    if (!activeId) return;
    await post("/api/session/repo/hide", { sessionId: activeId, repoPath: root.path });
    reloadSessionFiles();
  };

  const activate = useCallback((row: Row | undefined) => {
    if (!row || row.kind === "note" || row.kind === "new") return;
    if (row.kind === "earlier") return setShowEarlier((v) => !v);
    if (row.kind === "root" || row.kind === "dir") return toggle(row.key);
    if (row.kind === "hit") return void openPeek(joinPath(row.root.path, row.rel), undefined, row.line);
    // A file with hits folds them open first, and opens the file itself on the next press.
    if (row.hits && !row.open) return toggle(hitsKey(row.root.path, row.rel));
    void openPeek(joinPath(row.root.path, row.rel));
  }, [toggle]);

  const move = (d: number) => {
    const next = rows[Math.min(Math.max(selIdx + d, 0), rows.length - 1)];
    if (next) setSel(next.key);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      return restoreFocus(null);
    }
    if (e.key === "Tab") {
      e.preventDefault();
      setText((v) => !v);
      setSel(undefined);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(current);
    } else if (e.key === "F2" && !peer && current && (current.kind === "file" || current.kind === "dir")) {
      e.preventDefault();
      startRename(current);
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && current && (current.kind === "dir" || current.kind === "root")) {
      const wantOpen = e.key === "ArrowRight";
      if (current.open !== wantOpen) {
        e.preventDefault();
        toggle(current.key);
      }
    }
  };

  const writeRoots = async (next: string[]): Promise<boolean> => {
    const r = await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { roots: next } }),
    });
    return r.ok;
  };

  const pin = async (raw: string) => {
    const path = raw.trim();
    if (!path) return;
    if (!(await writeRoots([...(getState().config?.files?.roots ?? []), path]))) return setPinError("could not add that folder");
    setAdding(false);
    setNewRoot("");
    setPinError(undefined);
  };

  const unpin = (path: string) => void writeRoots((getState().config?.files?.roots ?? []).filter((p) => p !== path));

  const hitFileCount = live ? new Set(live.hits.map((h) => `${h.repo}\u0000${h.rel}`)).size : 0;
  const filtered = tokens.length || glob || opts.changedOnly;
  const foot = text
    ? live?.error ? live.error
      : grepQuery.length < MIN_TEXT_QUERY ? `type ${MIN_TEXT_QUERY}+ characters`
        : searching && !live ? "searching..."
          : !live ? ""
            : `${totalHits}${live.truncated ? "+" : ""} hit${totalHits === 1 ? "" : "s"} in ${hitFileCount} file${hitFileCount === 1 ? "" : "s"}${searching ? " - searching..." : ""}`
    : roots.length ? `${roots.length} root${roots.length === 1 ? "" : "s"}${filtered ? " - filtered" : ""}`
      : activeId ? "no repos in this session yet" : "no session";

  const editRow = (r: Row & { kind: "new" }) => (
    <div key={r.key} className="files-row files-new" style={{ paddingLeft: 4 + r.depth * 10 }}>
      <input autoFocus className="picker-input" value={edit?.name ?? ""} spellCheck={false} disabled={edit?.busy}
        placeholder={edit?.mode === "folder" ? "new folder name" : edit?.mode === "rename" ? "new name" : "new file name"}
        title={edit?.error}
        onFocus={(e) => {
          // A rename selects the name without its extension, as file managers do.
          if (edit?.mode !== "rename") return;
          const dot = e.target.value.lastIndexOf(".");
          e.target.setSelectionRange(0, edit.dir || dot <= 0 ? e.target.value.length : dot);
        }}
        onChange={(e) => setEdit((m) => m && { ...m, name: e.target.value, error: undefined })}
        onBlur={() => setEdit((m) => (m && !m.busy && (m.mode === "rename" || !m.name.trim()) ? null : m))}
        onKeyDown={(e) => {
          if (e.key === "Enter") void finishEdit();
          else if (e.key === "Escape") {
            e.preventDefault();
            setEdit(null);
          }
        }} />
      {edit?.error && <span className="files-err">{edit.error}</span>}
    </div>
  );

  const menuTarget = menu?.row;
  const menuSpot = menuTarget && spotOf(menuTarget);
  const menuPath = menuTarget && (menuTarget.kind === "file" || menuTarget.kind === "dir")
    ? joinPath(menuTarget.root.path, menuTarget.rel)
    : menuTarget?.kind === "root" ? menuTarget.root.path : undefined;
  const menuName = menuTarget?.kind === "root" ? menuTarget.root.name : menuTarget?.kind === "file" || menuTarget?.kind === "dir" ? baseName(menuTarget.rel) : "";
  const spotName = menuSpot ? (menuSpot.dir ? baseName(menuSpot.dir) : menuSpot.root.name) : "";
  const copy = (s: string) => {
    void navigator.clipboard?.writeText(s);
    setMenu(null);
  };

  return (
    <div className="files-pane">
      <div className="files-filter">
        <button className="chip chip-mode" onClick={() => { setText((v) => !v); setSel(undefined); inputRef.current?.focus(); }}
          title={text ? "searching file contents. Tab or click for file names" : "matching file names. Tab or click to search contents"}>
          <span className="mode-stack">
            <span className="mode-on">{text ? "text" : "name"}</span>
            <span className="mode-off">{text ? "name" : "text"}</span>
          </span>
          <kbd>&#8677;</kbd>
        </button>
        <input ref={inputRef} className="picker-input" value={query} spellCheck={false}
          placeholder={text ? "text in these repos" : "file name"}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
      </div>
      <div className="files-opts">
        <button className={"fopt" + (opts.caseSensitive ? " on" : "")} onClick={() => setOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))}
          title="match case exactly (off: case-insensitive while the query is lowercase)">Aa</button>
        <button className={"fopt" + (opts.regex ? " on" : "")} onClick={() => setOpts((o) => ({ ...o, regex: !o.regex }))}
          title="treat the query as a regular expression">.*</button>
        <button className={"fopt" + (opts.word ? " on" : "")} onClick={() => setOpts((o) => ({ ...o, word: !o.word }))}
          title="whole words only">ab|</button>
        <button className={"fopt" + (opts.changedOnly ? " on" : "")} onClick={() => setOpts((o) => ({ ...o, changedOnly: !o.changedOnly }))}
          title="only files with uncommitted changes">&#9679;</button>
        <button className={"fopt" + (opts.hideIgnored ? " on" : "")} onClick={() => setOpts((o) => ({ ...o, hideIgnored: !o.hideIgnored }))}
          title={opts.hideIgnored ? "git-ignored files are hidden - click to show them, dimmed" : "hide git-ignored files (shown dimmed)"}>&#8856;</button>
        <input className="fglob" value={opts.glob} spellCheck={false} placeholder="*.ts, !*.test.ts"
          title="which files to search; a leading ! excludes" onChange={(e) => setOpts((o) => ({ ...o, glob: e.target.value }))} />
        <button className="fopt" onClick={collapseAll} title="close every folder">&#8863;</button>
      </div>
      <div className="files-list" ref={listRef}
        onContextMenu={(e) => {
          // The row under the pointer, by walking up from the target to a row element. A peer's
          // tree has no menu: peers read.
          if (peer) return;
          const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
          const row = el ? rows[Number(el.dataset.row)] : undefined;
          if (!row || !spotOf(row)) return;
          e.preventDefault();
          setSel(row.key);
          setMenu({ x: e.clientX, y: e.clientY, row });
        }}>
        {rows.map((r, i) => {
          const on = i === selIdx;
          const pad = { paddingLeft: 4 + r.depth * 10 };
          if (r.kind === "note") return <div key={r.key} className="files-note" style={pad}>{r.text}</div>;
          if (r.kind === "new") return editRow(r);
          if (r.kind === "earlier") {
            return (
              <div key={r.key} className={"files-row files-earlier" + (on ? " sel" : "")} style={pad}
                title="repos this session has not worked in for a while, or that you hid from it"
                onMouseEnter={() => setSel(r.key)} onClick={() => activate(r)}>
                <span className="fold" aria-hidden>{r.open ? "▾" : "▸"}</span>
                <span className="title">{r.count} earlier repo{r.count === 1 ? "" : "s"}</span>
              </div>
            );
          }
          if (r.kind === "root") {
            return (
              <FilesRoot key={r.key} path={r.root.path} name={r.root.name} pinned={r.root.pinned} earlier={r.root.earlier} repo={cards.get(r.root.path)}
                sessionId={activeId} local={!peer && onLoopback} open={r.open} sel={on} style={pad} index={i}
                onHover={() => setSel(r.key)} onToggle={() => toggle(r.key)} onUnpin={() => unpin(r.root.path)} />
            );
          }
          if (r.kind === "dir") {
            return (
              <div key={r.key} className={"files-row files-dir" + (r.dirty ? " dirty" : "") + (r.ignored ? " ignored" : "") + (on ? " sel" : "")} style={pad} data-row={i}
                title={r.ignored ? `${r.rel} - ignored by git` : r.dirty ? `${r.rel} - has uncommitted changes` : r.rel}
                onMouseEnter={() => setSel(r.key)} onClick={() => toggle(r.key)}>
                <span className="fold" aria-hidden>{r.open ? "▾" : "▸"}</span>
                <span className="title">{r.name}</span>
              </div>
            );
          }
          if (r.kind === "hit") {
            return (
              <div key={r.key} className={"files-row files-hit" + (on ? " sel" : "")} style={pad}
                title={`${joinPath(r.root.path, r.rel)}:${r.line}`}
                onMouseEnter={() => setSel(r.key)} onClick={() => activate(r)}>
                <span className="files-hit-no">{r.line}</span>
                <HitText text={r.text} span={matchSpan(r.text, r.col, grepQuery, opts)} />
              </div>
            );
          }
          return (
            <div key={r.key} className={"files-row files-file" + (r.ignored ? " ignored" : "") + (on ? " sel" : "")} style={pad} data-row={i}
              title={joinPath(r.root.path, r.rel) + (r.ignored ? "\nignored by git" : "")}
              onMouseEnter={() => setSel(r.key)} onClick={() => activate(r)}>
              <span className={"fstat" + (r.status ? " s-" + r.status : "")}>{r.status ?? ""}</span>
              <span className="title">{r.name}</span>
              {r.hits !== undefined && <span className="files-count">{r.hits}</span>}
            </div>
          );
        })}
      </div>
      <div className="files-foot">
        <span className={live?.error ? "files-err" : undefined}>{foot}</span>
        {text ? (
          <button className="rail-toggle" onClick={() => setWide((v) => !v)}
            title={wide ? "back to this session's repos" : "search every checkout under the repos root, not just this session's"}>
            {wide ? "narrow" : "widen"}
          </button>
        ) : !adding ? (
          <button className="rail-toggle" onClick={() => setAdding(true)} title="pin a folder so it shows here in every session">+ folder</button>
        ) : null}
      </div>
      {menu && menuTarget && menuSpot && (
        <>
          <div className="pop-bg" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="pop files-menu" style={{ left: menu.x, top: menu.y }}>
            {menu.confirm ? (
              <>
                <div className="files-menu-ask">
                  Move <b>{menuName}</b>{menuTarget.kind === "dir" ? " and everything in it" : ""} to the {FILE_MANAGER === "Finder" ? "Trash" : "Recycle Bin"}?
                </div>
                {menu.error && <div className="files-menu-ask files-err">{menu.error}</div>}
                <button className="danger" onClick={() => void trash(menuTarget)}>move to {FILE_MANAGER === "Finder" ? "Trash" : "Recycle Bin"}</button>
                <button onClick={() => setMenu(null)}>cancel</button>
              </>
            ) : (
              <>
                <button onClick={() => startNew("file", menuSpot)}>new file in <b>{spotName}</b></button>
                <button onClick={() => startNew("folder", menuSpot)}>new folder in <b>{spotName}</b></button>
                {(menuTarget.kind === "file" || menuTarget.kind === "dir") && (
                  <>
                    <div className="menu-sep" />
                    <button onClick={() => startRename(menuTarget)}>rename <span className="files-menu-key">F2</span></button>
                    <button onClick={() => setMenu({ ...menu, confirm: true })}>delete</button>
                  </>
                )}
                <div className="menu-sep" />
                {menuPath && <button onClick={() => copy(menuPath)}>copy path</button>}
                {(menuTarget.kind === "file" || menuTarget.kind === "dir") && <button onClick={() => copy(menuTarget.rel)}>copy relative path</button>}
                {onLoopback && menuPath && (
                  <button onClick={() => { revealFolder(menuPath); setMenu(null); }}>
                    {menuTarget.kind === "file" ? "show" : "open"} <b>{menuName}</b> in {FILE_MANAGER}
                  </button>
                )}
                {menuTarget.kind === "root" && !menuTarget.root.pinned && !menuTarget.root.here && !menuTarget.root.earlier && activeId && (
                  <>
                    <div className="menu-sep" />
                    <button onClick={() => void hideRoot(menuTarget.root)} title="list it under 'earlier' until the session works in it again">hide from this session</button>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
      {adding && (
        <div className="files-add">
          <input autoFocus className="picker-input" value={newRoot} spellCheck={false} placeholder="~/notes or /path/to/folder"
            onChange={(e) => setNewRoot(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void pin(newRoot);
              else if (e.key === "Escape") {
                setAdding(false);
                setPinError(undefined);
              }
            }} />
          {pinError && <div className="files-err">{pinError}</div>}
        </div>
      )}
    </div>
  );
}

function HitText({ text, span }: { text: string; span?: [number, number] }) {
  const t = text.trimStart();
  if (!span) return <span className="files-hit-text">{t}</span>;
  const cut = text.length - t.length;
  const [a, b] = [Math.max(0, span[0] - cut), Math.max(0, span[1] - cut)];
  return (
    <span className="files-hit-text">
      {t.slice(0, a)}<mark>{t.slice(a, b)}</mark>{t.slice(b)}
    </span>
  );
}
