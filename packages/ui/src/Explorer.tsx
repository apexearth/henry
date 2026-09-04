// ⌘F: browse this machine's repos and their files without leaving Henry. Left: a filter over
// every checkout under the repos root (name · branch · dirty), or, once one is picked, over its
// files; right: the selected file, read-only, uncommitted lines tinted. Tab flips the filter to
// text mode: `git grep` over the scoped repo (or every repo), one row per hit, ↑↓ previews the
// hit's line. Where you were (repo, mode, query, selection) is remembered per browser, so ⌘F
// flips back to the same place.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangedFile, GrepHit, GrepResult, RepoState } from "@henry/shared";
import { focusOrigin, restoreFocus } from "./dock";
import { FileView, openPeek } from "./FileView";
import { repoIndex, splitPath } from "./files";
import { joinPath } from "./platform";
import { hueText, nameHue } from "./theme";

type Row =
  | { kind: "repo"; key: string; repo: RepoState; score: number }
  | { kind: "file"; key: string; abs: string; rel: string; repo: RepoState; status?: ChangedFile["status"]; score: number }
  | { kind: "hit"; key: string; abs: string; rel: string; repo: RepoState; line: number; col: number; text: string; first: boolean };

const MAX_ROWS = 400;
const MIN_TEXT_QUERY = 2;
const TEXT_DEBOUNCE_MS = 150;
const STATE_KEY = "henry.explorer";

interface Saved {
  /** Repo path the list is scoped to; absent: the repo list. */
  scope?: string;
  /** Text mode: the filter is a `git grep`, not a file-name match. */
  text?: boolean;
  query: string;
  /** Row key (repo path, absolute file path, or `path:line` for a hit) that was selected. */
  sel?: string;
}

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(STATE_KEY) ?? "{}") as Partial<Saved>;
    return { scope: typeof v.scope === "string" ? v.scope : undefined, text: v.text === true, query: typeof v.query === "string" ? v.query : "", sel: typeof v.sel === "string" ? v.sel : undefined };
  } catch {
    return { query: "" };
  }
}

function save(s: Saved): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(s));
  } catch {
    /* private mode: the explorer just starts fresh */
  }
}

/** Subsequence match; rewards word starts, runs, and hits in the last segment. -Infinity: no match. */
function score(q: string, path: string): number {
  const s = path.toLowerCase();
  let qi = 0;
  let first = -1;
  let last = -2;
  let bonus = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) continue;
    if (first < 0) first = i;
    if (last === i - 1) bonus += 2;
    const prev = s[i - 1];
    if (i === 0 || prev === "/" || prev === "." || prev === "_" || prev === "-") bonus += 3;
    last = i;
    qi++;
  }
  if (qi < q.length) return -Infinity;
  const name = s.slice(s.lastIndexOf("/") + 1);
  if (name.startsWith(q)) bonus += 12;
  else if (name.includes(q)) bonus += 8;
  return bonus - (last - first - q.length) * 0.2 - s.length * 0.005;
}

function matches(tokens: string[], path: string): number {
  let total = 0;
  for (const t of tokens) {
    const sc = score(t, path);
    if (sc === -Infinity) return -Infinity;
    total += sc;
  }
  return total;
}

// Painted on reopen before the fresh fetch lands, so the list never flashes empty.
let reposCache: RepoState[] | null = null;

async function fetchRepoStates(): Promise<RepoState[]> {
  const r = await fetch("/api/repos/state");
  return r.ok ? ((await r.json()) as RepoState[]) : [];
}

async function fetchChanges(repoPath: string): Promise<ChangedFile[]> {
  const r = await fetch(`/api/repo/changes?repo=${encodeURIComponent(repoPath)}`);
  return r.ok ? ((await r.json()) as ChangedFile[]) : [];
}

async function fetchGrep(q: string, repoPath: string | undefined, signal: AbortSignal): Promise<GrepResult> {
  const p = new URLSearchParams({ q });
  if (repoPath) p.set("repo", repoPath);
  const r = await fetch(`/api/repo/grep?${p}`, { signal });
  return r.ok ? ((await r.json()) as GrepResult) : { hits: [], truncated: false };
}

/** The matched span of a hit line: the server's column, checked against the text (smart case). */
function matchSpan(text: string, col: number, q: string): [number, number] | undefined {
  const at = col - 1;
  const sensitive = q !== q.toLowerCase();
  const same = (a: string, b: string) => (sensitive ? a === b : a.toLowerCase() === b.toLowerCase());
  if (at >= 0 && same(text.slice(at, at + q.length), q)) return [at, at + q.length];
  const i = sensitive ? text.indexOf(q) : text.toLowerCase().indexOf(q.toLowerCase());
  return i >= 0 ? [i, i + q.length] : undefined;
}

export interface ExplorerProps {
  onClose: () => void;
  /** Open in text mode with this query, overriding what was remembered (⌘⇧F from a peek's find). */
  text?: string;
}

export function Explorer({ onClose, text: textArg }: ExplorerProps) {
  const [saved] = useState(load);
  const [scope, setScope] = useState<string | undefined>(saved.scope);
  const [text, setText] = useState(textArg !== undefined ? true : saved.text === true);
  const [query, setQuery] = useState(textArg ?? saved.query);
  const [selKey, setSelKey] = useState<string | undefined>(textArg !== undefined ? undefined : saved.sel);
  const [repos, setRepos] = useState<RepoState[]>(reposCache ?? []);
  const [loaded, setLoaded] = useState(reposCache !== null);
  const [indexes, setIndexes] = useState<Record<string, string[]>>({});
  const [changes, setChanges] = useState<Record<string, ChangedFile[]>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => save({ scope, text, query, sel: selKey }), [scope, text, query, selKey]);

  useEffect(() => {
    const origin = focusOrigin();
    return () => restoreFocus(origin);
  }, []);

  useEffect(() => {
    let on = true;
    fetchRepoStates().then((rs) => {
      reposCache = rs;
      if (on) {
        setRepos(rs);
        setLoaded(true);
      }
    });
    return () => {
      on = false;
    };
  }, []);

  const scopeRepo = useMemo(() => repos.find((r) => r.path === scope), [repos, scope]);
  const tokens = useMemo(() => (text ? [] : query.toLowerCase().split(/\s+/).filter(Boolean)), [query, text]);
  const grepQuery = text ? query.trim() : "";

  // Indexes: the scoped repo's always; every repo's once you type a name without a scope.
  const wanted = useMemo(() => (scope ? (scopeRepo ? [scopeRepo] : []) : tokens.length ? repos : []), [scope, scopeRepo, tokens.length, repos]);
  useEffect(() => {
    let on = true;
    for (const r of wanted) {
      if (indexes[r.path]) continue;
      repoIndex(r.path).then((files) => on && setIndexes((prev) => (prev[r.path] ? prev : { ...prev, [r.path]: files })));
    }
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  useEffect(() => {
    if (!scopeRepo || changes[scopeRepo.path]) return;
    let on = true;
    fetchChanges(scopeRepo.path).then((c) => on && setChanges((prev) => ({ ...prev, [scopeRepo.path]: c })));
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeRepo]);

  // Text mode: grep a beat after the last keystroke; a newer query aborts the one in flight.
  // `grep` holds the result and the query it answers, so a stale result is never painted.
  const [grep, setGrep] = useState<{ q: string; scope?: string; res: GrepResult } | null>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (grepQuery.length < MIN_TEXT_QUERY) {
      setGrep(null);
      setSearching(false);
      return;
    }
    const ctl = new AbortController();
    setSearching(true);
    const t = setTimeout(() => {
      fetchGrep(grepQuery, scope, ctl.signal)
        .then((res) => {
          if (ctl.signal.aborted) return;
          setGrep({ q: grepQuery, scope, res });
          setSearching(false);
        })
        .catch(() => {});
    }, TEXT_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [grepQuery, scope]);
  const grepLive = grep && grep.q === grepQuery && grep.scope === scope ? grep.res : null;

  const rows = useMemo((): Row[] => {
    if (text) {
      const hits: Row[] = [];
      if (!grepLive) return hits;
      const byPath = new Map(repos.map((r) => [r.path, r]));
      let prev = "";
      for (const h of grepLive.hits) {
        const repo = byPath.get(h.repo);
        if (!repo) continue;
        const abs = joinPath(repo.path, h.rel);
        hits.push({ kind: "hit", key: `${abs}:${h.line}`, abs, rel: h.rel, repo, line: h.line, col: h.col, text: h.text, first: abs !== prev });
        prev = abs;
        if (hits.length >= MAX_ROWS) break;
      }
      return hits;
    }
    const out: Exclude<Row, { kind: "hit" }>[] = [];
    if (scopeRepo) {
      const status = new Map((changes[scopeRepo.path] ?? []).map((c) => [c.path, c.status] as const));
      for (const rel of indexes[scopeRepo.path] ?? []) {
        const sc = tokens.length ? matches(tokens, rel) : 0;
        if (sc === -Infinity) continue;
        out.push({ kind: "file", key: joinPath(scopeRepo.path, rel), abs: joinPath(scopeRepo.path, rel), rel, repo: scopeRepo, status: status.get(rel), score: sc });
      }
      out.sort((a, b) => b.score - a.score || (a as { rel: string }).rel.localeCompare((b as { rel: string }).rel));
      return out.slice(0, MAX_ROWS);
    }
    for (const repo of repos) {
      const sc = tokens.length ? matches(tokens, repo.name) : 0;
      if (sc === -Infinity) continue;
      out.push({ kind: "repo", key: repo.path, repo, score: sc + 1000 });
    }
    if (tokens.length) {
      for (const repo of repos) {
        for (const rel of indexes[repo.path] ?? []) {
          const sc = matches(tokens, `${repo.name}/${rel}`);
          if (sc === -Infinity) continue;
          out.push({ kind: "file", key: joinPath(repo.path, rel), abs: joinPath(repo.path, rel), rel, repo, score: sc });
        }
      }
    }
    out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    return out.slice(0, MAX_ROWS);
  }, [text, grepLive, scopeRepo, repos, indexes, changes, tokens]);

  const sel = Math.max(0, rows.findIndex((r) => r.key === selKey));
  const selected = rows[sel];
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel, rows]);

  // The preview follows the selection a beat behind, so arrowing through files doesn't fetch each one.
  const [preview, setPreview] = useState<{ path: string; line?: number } | undefined>();
  useEffect(() => {
    const next = selected?.kind === "file" ? { path: selected.abs } : selected?.kind === "hit" ? { path: selected.abs, line: selected.line } : undefined;
    const t = setTimeout(() => setPreview(next), 120);
    return () => clearTimeout(t);
  }, [selected]);

  const move = (d: number) => {
    const next = rows[Math.min(Math.max(sel + d, 0), rows.length - 1)];
    if (next) setSelKey(next.key);
  };
  const enterScope = (repo: RepoState) => {
    setScope(repo.path);
    if (!text) setQuery("");
    setSelKey(undefined);
  };
  const leaveScope = () => {
    setSelKey(scope);
    setScope(undefined);
    if (!text) setQuery("");
    inputRef.current?.focus();
  };
  const toggleText = () => {
    setText((v) => !v);
    setSelKey(undefined);
    inputRef.current?.focus();
  };
  const pick = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "repo") enterScope(row.repo);
    else {
      void openPeek(row.abs, undefined, row.kind === "hit" ? row.line : undefined);
      onClose();
    }
  };
  const scrollPreview = (pages: number) => {
    const body = rightRef.current?.querySelector<HTMLElement>(".peek-body");
    if (body) body.scrollBy({ top: pages * body.clientHeight * 0.9 });
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "Tab") {
      e.preventDefault();
      toggleText();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      scrollPreview(e.key === "PageDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(selected);
    } else if (e.key === "Backspace" && !query && scope) {
      e.preventDefault();
      leaveScope();
    }
  };

  const indexed = scopeRepo ? indexes[scopeRepo.path]?.length : undefined;
  const files = grepLive ? new Set(grepLive.hits.map((h) => h.repo + "\0" + h.rel)).size : 0;
  const foot = text
    ? grepQuery.length < MIN_TEXT_QUERY ? `type ${MIN_TEXT_QUERY}+ characters to search ${scopeRepo ? scopeRepo.name : "every repo"}` : searching && !grepLive ? "searching…" : !grepLive ? "" : `${grepLive.hits.length}${grepLive.truncated ? "+" : ""} hit${grepLive.hits.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}${searching ? " · searching…" : ""}`
    : scopeRepo
      ? indexed === undefined ? "listing files…" : tokens.length ? `${rows.length}${rows.length === MAX_ROWS ? "+" : ""} of ${indexed} files` : `${indexed} files${indexed > MAX_ROWS ? `, first ${MAX_ROWS} shown, type to narrow` : ""}`
      : !loaded ? "reading repos…" : tokens.length ? `${rows.length}${rows.length === MAX_ROWS ? "+" : ""} match${rows.length === 1 ? "" : "es"}` : `${repos.length} repos, type a repo or file name`;
  const empty = !loaded ? "loading…"
    : text ? (grepQuery.length < MIN_TEXT_QUERY ? "" : searching ? "searching…" : grepLive ? "no match" : "")
      : scopeRepo && indexed === undefined ? "listing files…" : tokens.length ? "no match" : "no repos under the repos root";

  return (
    <div className="modal-bg explorer-bg" onMouseDown={onClose}>
      <div className="modal explorer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="explorer-left">
          <div className="explorer-input">
            {scopeRepo && (
              <button className="chip sel" style={{ color: hueText(nameHue(scopeRepo.name)) }} onClick={leaveScope} title={`${scopeRepo.path}\nback to all repos (Backspace on an empty filter)`}>
                {scopeRepo.name} ×
              </button>
            )}
            <button className="chip chip-mode" onClick={toggleText} title={text ? "file search: matching file contents. Tab or click for file names" : "file name: matching paths. Tab or click to search file contents"}>
              <span className="mode-stack">
                <span className="mode-head">file</span>
                <span className="mode-on">{text ? "search" : "name"}</span>
                <span className="mode-off">{text ? "name" : "search"}</span>
              </span>
              <kbd>⇥</kbd>
            </button>
            <input ref={inputRef} className="picker-input" autoFocus value={query} spellCheck={false}
              placeholder={text ? `text in ${scopeRepo ? scopeRepo.name : "every repo"} — ↑↓ preview, ↩ opens` : scopeRepo ? "file name — ↑↓ preview, ↩ opens" : "repo or file name"}
              onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
          </div>
          <div className="list" ref={listRef}>
            {rows.map((r, i) => r.kind === "repo" ? (
              <div key={r.key} className={"row explorer-repo" + (i === sel ? " sel" : "")} onMouseEnter={() => setSelKey(r.key)} onClick={() => pick(r)} title={r.repo.path}>
                <span className="file-cell">
                  <span style={{ color: hueText(nameHue(r.repo.name)) }}>{r.repo.name}</span>
                  {r.repo.isWorktree && <span className="kind-word">worktree</span>}
                </span>
                <span className="explorer-git">
                  {r.repo.dirty > 0 && <span className="dirty" title={`${r.repo.dirty} uncommitted path${r.repo.dirty === 1 ? "" : "s"}`}>●{r.repo.dirty}</span>}
                  {r.repo.ahead > 0 && <span title={`${r.repo.ahead} ahead of ${r.repo.upstream}`}>↑{r.repo.ahead}</span>}
                  {r.repo.behind > 0 && <span title={`${r.repo.behind} behind ${r.repo.upstream}`}>↓{r.repo.behind}</span>}
                  <span className="branch">{r.repo.branch}</span>
                </span>
              </div>
            ) : r.kind === "hit" ? (
              <div key={r.key} className={"row explorer-hit" + (i === sel ? " sel" : "") + (r.first ? " first" : "")} onMouseEnter={() => setSelKey(r.key)} onClick={() => setSelKey(r.key)} onDoubleClick={() => pick(r)} title={`${r.abs}:${r.line}`}>
                {r.first && (
                  <span className="file-cell explorer-hit-file">
                    <span>{splitPath(r.rel).name}</span>
                    <span className="kind-word">{splitPath(r.rel).dir}</span>
                    {!scopeRepo && <span className="path" style={{ color: hueText(nameHue(r.repo.name)) }}>{r.repo.name}</span>}
                  </span>
                )}
                <span className="explorer-hit-line">
                  <span className="explorer-hit-no">{r.line}</span>
                  <HitText text={r.text} span={matchSpan(r.text, r.col, grepQuery)} />
                </span>
              </div>
            ) : (
              <div key={r.key} className={"row" + (i === sel ? " sel" : "")} onMouseEnter={() => setSelKey(r.key)} onClick={() => setSelKey(r.key)} onDoubleClick={() => pick(r)} title={r.abs}>
                <span className="file-cell">
                  <span className={"fstat" + (r.status ? " s-" + r.status : "")}>{r.status ?? ""}</span>
                  <span>{splitPath(r.rel).name}</span>
                  <span className="kind-word">{splitPath(r.rel).dir}</span>
                </span>
                {!scopeRepo && <span className="path" style={{ color: hueText(nameHue(r.repo.name)) }}>{r.repo.name}</span>}
              </div>
            ))}
            {!rows.length && empty && <div className="row placeholder">{empty}</div>}
          </div>
          <div className="foot hint">
            <span>{foot}</span>
            <span>Esc to close</span>
          </div>
        </div>
        <div className="explorer-right" ref={rightRef}>
          {preview ? <FileView key={preview.path} path={preview.path} line={preview.line} active={false} local /> : (
            <div className="explorer-empty">
              {text ? "type to search file contents" : scopeRepo ? "select a file to read it here" : "pick a repo, or type a file name"}
              <div className="hint">↩ on a file opens it as a peek in the stage · PgUp/PgDn scroll the preview</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HitText({ text, span }: { text: string; span?: [number, number] }) {
  const t = text.trimStart();
  if (!span) return <span className="explorer-hit-text">{t}</span>;
  const cut = text.length - t.length;
  const [a, b] = [Math.max(0, span[0] - cut), Math.max(0, span[1] - cut)];
  return (
    <span className="explorer-hit-text">
      {t.slice(0, a)}<mark>{t.slice(a, b)}</mark>{t.slice(b)}
    </span>
  );
}
