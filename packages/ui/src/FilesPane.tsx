// The files half of the left pane. Roots are the repos the session you are looking at has
// touched, plus whatever you pinned, so reading code still feels like being inside that session.
// One filter, two modes: file names (fuzzy, client-side over the repo index) or file contents
// (`git grep` on the daemon). Either way the *tree* narrows - matches keep their parent folders,
// because where a match sits is half of what you wanted to know. Aa / .* / ab| / glob are the
// search's usual knobs. Read-only throughout: a click opens a peek in the stage, nothing edits.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangedFile, GrepResult, RepoState } from "@henry/shared";
import { openPeek } from "./FileView";
import { rootIndex, useSessionFiles } from "./files";
import { globFilter, matches, tokenize } from "./match";
import { baseName, joinPath } from "./platform";
import { hueText, nameHue } from "./theme";
import { ancestorsOf, buildTree, type TreeNode } from "./tree";
import { getState, setRailMode, useStore } from "./ws";

const MAX_ROWS = 2000;
const MIN_TEXT_QUERY = 2;
const TEXT_DEBOUNCE_MS = 150;
/** Up to this many hits, every matching file shows its lines; past it they start folded. */
const AUTO_OPEN_HITS = 40;

interface Root {
  path: string;
  name: string;
  pinned: boolean;
}

interface Opts {
  caseSensitive: boolean;
  regex: boolean;
  word: boolean;
  glob: string;
  changedOnly: boolean;
}

const DEFAULT_OPTS: Opts = { caseSensitive: false, regex: false, word: false, glob: "", changedOnly: false };
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

type Row =
  | { kind: "root"; key: string; root: Root; open: boolean; depth: number }
  | { kind: "dir"; key: string; root: Root; rel: string; name: string; open: boolean; depth: number }
  | { kind: "file"; key: string; root: Root; rel: string; name: string; depth: number; status?: ChangedFile["status"]; hits?: number; open?: boolean }
  | { kind: "hit"; key: string; root: Root; rel: string; line: number; col: number; text: string; depth: number }
  | { kind: "note"; key: string; text: string; depth: number };

/** ⌘F / ⌘⇧F: show the pane and put the keyboard in its filter, in `text` mode when a term
 *  is given. The request is parked in `pending` as well as announced, because the pane may
 *  not be mounted yet — switching to it *is* what this call does. */
export const FILES_EVENT = "henry:files";
let pending: { at: number; text?: string } | undefined;

export function openFiles(text?: string): void {
  pending = { at: Date.now(), text };
  setRailMode("files");
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
  const [indexes, setIndexes] = useState<Record<string, string[]>>({});
  const [changes, setChanges] = useState<Record<string, ChangedFile[]>>({});
  const [sel, setSel] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [newRoot, setNewRoot] = useState("");
  const [pinError, setPinError] = useState<string | undefined>();
  const [wide, setWide] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  // Roots: the session's repos first (that is the "inside this session" part), then pins.
  //
  // The repo list comes from /api/session/files rather than the store's `repos`, because the
  // store's is built from hook events: a plain terminal fires none, so a shell sitting in a
  // repo would show an empty tree. That endpoint falls back to the repo the session's cwd is
  // in, and hands back each file's status in the same answer, so the tree's change marks and
  // its roots cost one request between them.
  const roots = useMemo((): Root[] => {
    const out: Root[] = [];
    const seen = new Set<string>();
    for (const r of sf?.repos ?? []) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      out.push({ path: r.path, name: r.name, pinned: false });
    }
    // Belt and braces while that first answer is in flight: the store knows them too.
    for (const r of (sessionRepos ?? []) as RepoState[]) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      out.push({ path: r.path, name: r.name, pinned: false });
    }
    for (const p of config?.files?.roots ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ path: p, name: baseName(p), pinned: true });
    }
    return out;
  }, [sf, sessionRepos, config]);

  /** Uncommitted status per file: from the session's own answer where there is one (changes vs
   *  its baseline, the Henry question), else a plain vs-HEAD read for a pinned folder. */
  const statusFor = useCallback((rootPath: string): Map<string, ChangedFile["status"]> => {
    const fromSession = sf?.repos.find((r) => r.path === rootPath);
    const list = fromSession ? fromSession.files : changes[rootPath] ?? [];
    return new Map(list.map((c) => [c.path, c.status] as const));
  }, [sf, changes]);

  const rootsKey = roots.map((r) => r.path).join("\n");

  // One root open by default, so the pane is never a wall of closed folders.
  useEffect(() => {
    if (!roots.length) return;
    setOpen((prev) => (roots.some((r) => prev.has(nodeKey(r.path, ""))) ? prev : new Set([...prev, nodeKey(roots[0].path, "")])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey]);

  useEffect(() => {
    let on = true;
    const known = new Set((sf?.repos ?? []).map((r) => r.path));
    for (const r of roots) {
      if (indexes[r.path]) continue;
      rootIndex(r.path, peer).then((idx) => on && setIndexes((prev) => (prev[r.path] ? prev : { ...prev, [r.path]: idx.files })));
      // Only for roots the session's own answer does not already cover.
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
    for (const root of shownRoots) {
      const rootOpen = open.has(nodeKey(root.path, ""));
      out.push({ kind: "root", key: nodeKey(root.path, ""), root, open: rootOpen, depth: 0 });
      if (!rootOpen) continue;

      const status = statusFor(root.path);
      const hitFiles = hitsByRoot.get(root.path);

      // Which files this root contributes, before the tree is built.
      let paths: string[];
      if (text) {
        paths = [...(hitFiles?.keys() ?? [])];
      } else {
        paths = indexes[root.path] ?? [];
        if (glob) paths = paths.filter(glob);
        if (opts.changedOnly) paths = paths.filter((p) => status.has(p));
        if (tokens.length) paths = paths.filter((p) => matches(tokens, p) !== -Infinity);
      }

      if (!paths.length) {
        const why = text
          ? live ? "no matches here" : ""
          : indexes[root.path] === undefined ? "reading..."
            : opts.changedOnly ? "nothing changed"
              : tokens.length || glob ? "no matches here" : "empty";
        if (why) out.push({ kind: "note", key: nodeKey(root.path, "\u0000empty"), text: why, depth: 1 });
        continue;
      }

      // A filter opens the tree onto what it found; an unfiltered tree stays where you left it.
      const filtering = text || tokens.length > 0 || !!glob || opts.changedOnly;
      const forced = filtering ? ancestorsOf(paths) : undefined;
      const isOpen = (rel: string) => (forced?.has(rel) ?? false) || open.has(nodeKey(root.path, rel));

      const walk = (nodes: TreeNode[], depth: number) => {
        for (const n of nodes) {
          if (out.length >= MAX_ROWS) return;
          if (n.dir) {
            const o = isOpen(n.rel);
            out.push({ kind: "dir", key: nodeKey(root.path, n.rel), root, rel: n.rel, name: n.name, open: o, depth });
            if (o) walk(n.children, depth + 1);
            continue;
          }
          const hits = hitFiles?.get(n.rel);
          // With few hits they all show and the set records what you closed; with many they
          // start closed and it records what you opened. Either way one click flips this file.
          const fileOpen = hits ? open.has(hitsKey(root.path, n.rel)) !== autoOpenHits : undefined;
          out.push({ kind: "file", key: nodeKey(root.path, n.rel), root, rel: n.rel, name: n.name, depth, status: status.get(n.rel), hits: hits?.length, open: fileOpen });
          if (hits && fileOpen) {
            for (const h of hits) {
              if (out.length >= MAX_ROWS) return;
              out.push({ kind: "hit", key: `${nodeKey(root.path, n.rel)}:${h.line}`, root, rel: n.rel, line: h.line, col: h.col, text: h.text, depth: depth + 1 });
            }
          }
        }
      };
      walk(buildTree(paths), 1);
    }
    if (out.length >= MAX_ROWS) out.push({ kind: "note", key: "\u0000more", text: "too many to list - narrow the filter", depth: 1 });
    return out;
  }, [shownRoots, open, indexes, statusFor, tokens, glob, opts.changedOnly, text, hitsByRoot, live, autoOpenHits]);

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

  const activate = useCallback((row: Row | undefined) => {
    if (!row || row.kind === "note") return;
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
      return setRailMode("sessions");
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
  const foot = text
    ? live?.error ? live.error
      : grepQuery.length < MIN_TEXT_QUERY ? `type ${MIN_TEXT_QUERY}+ characters`
        : searching && !live ? "searching..."
          : !live ? ""
            : `${totalHits}${live.truncated ? "+" : ""} hit${totalHits === 1 ? "" : "s"} in ${hitFileCount} file${hitFileCount === 1 ? "" : "s"}${searching ? " - searching..." : ""}`
    : roots.length ? `${roots.length} root${roots.length === 1 ? "" : "s"}${tokens.length || glob || opts.changedOnly ? " - filtered" : ""}`
      : activeId ? "no repos in this session yet" : "no session";

  return (
    <div className="files-pane">
      <div className="files-filter">
        <button className="chip chip-mode" onClick={() => { setText((v) => !v); setSel(undefined); inputRef.current?.focus(); }}
          title={text ? "searching file contents. Tab or click for file names" : "matching file names. Tab or click to search contents"}>
          <span className="mode-stack">
            <span className="mode-head">file</span>
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
        <input className="fglob" value={opts.glob} spellCheck={false} placeholder="*.ts, !*.test.ts"
          title="which files to search; a leading ! excludes" onChange={(e) => setOpts((o) => ({ ...o, glob: e.target.value }))} />
      </div>
      <div className="files-list" ref={listRef}>
        {rows.map((r, i) => {
          const on = i === selIdx;
          const pad = { paddingLeft: 4 + r.depth * 10 };
          if (r.kind === "note") return <div key={r.key} className="files-note" style={pad}>{r.text}</div>;
          if (r.kind === "root" || r.kind === "dir") {
            const isRoot = r.kind === "root";
            return (
              <div key={r.key} className={`files-row ${isRoot ? "files-root" : "files-dir"}${on ? " sel" : ""}`} style={pad}
                title={isRoot ? r.root.path : r.rel}
                onMouseEnter={() => setSel(r.key)} onClick={() => toggle(r.key)}>
                <span className="fold" aria-hidden>{r.open ? "▾" : "▸"}</span>
                <span className="title" style={isRoot ? { color: hueText(nameHue(r.root.name)) } : undefined}>{isRoot ? r.root.name : r.name}</span>
                {isRoot && r.root.pinned && (
                  <button className="files-unpin" title="unpin this folder" onClick={(e) => { e.stopPropagation(); unpin(r.root.path); }}>&times;</button>
                )}
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
            <div key={r.key} className={"files-row files-file" + (on ? " sel" : "")} style={pad}
              title={joinPath(r.root.path, r.rel)}
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
