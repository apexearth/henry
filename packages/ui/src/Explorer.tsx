// ⌘F: browse this machine's repos and their files without leaving Henry. Left: a filter over
// every checkout under the repos root (name · branch · dirty), or, once one is picked, over its
// files; right: the selected file, read-only, uncommitted lines tinted. Where you were (repo,
// query, selection) is remembered per browser, so ⌘F flips back to the same place.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangedFile, RepoState } from "@henry/shared";
import { FileView, openPeek } from "./FileView";
import { repoIndex, splitPath } from "./files";
import { joinPath } from "./platform";
import { hueText, nameHue } from "./theme";

type Row =
  | { kind: "repo"; key: string; repo: RepoState; score: number }
  | { kind: "file"; key: string; abs: string; rel: string; repo: RepoState; status?: ChangedFile["status"]; score: number };

const MAX_ROWS = 400;
const STATE_KEY = "henry.explorer";

interface Saved {
  /** Repo path the list is scoped to; absent: the repo list. */
  scope?: string;
  query: string;
  /** Row key (repo path, or absolute file path) that was selected. */
  sel?: string;
}

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(STATE_KEY) ?? "{}") as Partial<Saved>;
    return { scope: typeof v.scope === "string" ? v.scope : undefined, query: typeof v.query === "string" ? v.query : "", sel: typeof v.sel === "string" ? v.sel : undefined };
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

export function Explorer({ onClose }: { onClose: () => void }) {
  const [saved] = useState(load);
  const [scope, setScope] = useState<string | undefined>(saved.scope);
  const [query, setQuery] = useState(saved.query);
  const [selKey, setSelKey] = useState<string | undefined>(saved.sel);
  const [repos, setRepos] = useState<RepoState[]>(reposCache ?? []);
  const [loaded, setLoaded] = useState(reposCache !== null);
  const [indexes, setIndexes] = useState<Record<string, string[]>>({});
  const [changes, setChanges] = useState<Record<string, ChangedFile[]>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => save({ scope, query, sel: selKey }), [scope, query, selKey]);

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
  const tokens = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);

  // Indexes: the scoped repo's always; every repo's once you type without a scope.
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

  const rows = useMemo(() => {
    const out: Row[] = [];
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
  }, [scopeRepo, repos, indexes, changes, tokens]);

  const sel = Math.max(0, rows.findIndex((r) => r.key === selKey));
  const selected = rows[sel];
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel, rows]);

  // The preview follows the selection a beat behind, so arrowing through files doesn't fetch each one.
  const [preview, setPreview] = useState<string | undefined>();
  useEffect(() => {
    const path = selected?.kind === "file" ? selected.abs : undefined;
    const t = setTimeout(() => setPreview(path), 120);
    return () => clearTimeout(t);
  }, [selected]);

  const move = (d: number) => {
    const next = rows[Math.min(Math.max(sel + d, 0), rows.length - 1)];
    if (next) setSelKey(next.key);
  };
  const enterScope = (repo: RepoState) => {
    setScope(repo.path);
    setQuery("");
    setSelKey(undefined);
  };
  const leaveScope = () => {
    setSelKey(scope);
    setScope(undefined);
    setQuery("");
    inputRef.current?.focus();
  };
  const pick = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "repo") enterScope(row.repo);
    else {
      void openPeek(row.abs);
      onClose();
    }
  };
  const scrollPreview = (pages: number) => {
    const body = rightRef.current?.querySelector<HTMLElement>(".peek-body");
    if (body) body.scrollBy({ top: pages * body.clientHeight * 0.9 });
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
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
  const foot = scopeRepo
    ? indexed === undefined ? "listing files…" : tokens.length ? `${rows.length}${rows.length === MAX_ROWS ? "+" : ""} of ${indexed} files` : `${indexed} files${indexed > MAX_ROWS ? `, first ${MAX_ROWS} shown, type to narrow` : ""}`
    : !loaded ? "reading repos…" : tokens.length ? `${rows.length}${rows.length === MAX_ROWS ? "+" : ""} match${rows.length === 1 ? "" : "es"}` : `${repos.length} repos, type a repo or file name`;

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
            <input ref={inputRef} className="picker-input" autoFocus value={query} spellCheck={false}
              placeholder={scopeRepo ? "file name — ↑↓ preview, ↩ opens" : "repo or file name"}
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
            {!rows.length && <div className="row placeholder">{!loaded ? "loading…" : scopeRepo && indexed === undefined ? "listing files…" : tokens.length ? "no match" : "no repos under the repos root"}</div>}
          </div>
          <div className="foot hint">
            <span>{foot}</span>
            <span>Esc to close</span>
          </div>
        </div>
        <div className="explorer-right" ref={rightRef}>
          {preview ? <FileView key={preview} path={preview} active={false} local /> : (
            <div className="explorer-empty">
              {scopeRepo ? "select a file to read it here" : "pick a repo, or type a file name"}
              <div className="hint">↩ on a file opens it as a peek in the stage · PgUp/PgDn scroll the preview</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
