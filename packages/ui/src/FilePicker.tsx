// ⌘K: find a file to peek at. Changed files of the session you are looking at come first,
// then recent peeks, then every file in that session's repos (the one its cwd is in first),
// then other sessions' repos. Type to fuzzy-filter; ↑↓ then Enter opens a peek.
import { useEffect, useMemo, useRef, useState } from "react";
import type { RepoState } from "@henry/shared";
import { focusOrigin, restoreFocus } from "./dock";
import { openPeek, splitLineRef } from "./FileView";
import { fetchSessionFiles, filesByTail, recentFiles, repoIndex, splitPath, useSessionFiles } from "./files";
import { matches } from "./match";
import { baseName, joinPath, under } from "./platform";
import { getState, useStore } from "./ws";

interface Row {
  abs: string;
  rel: string;
  repoName: string;
  /** 0 changed · 1 recent · 2 this session's repos · 3 other repos */
  tier: number;
  status?: string;
  committed?: true;
  mtime?: number;
  score: number;
}

const MAX_ROWS = 200;

const TIER_GLYPH = ["", "↺", "", ""];

/** ⌘K asked for from elsewhere: a clicked path that was not a file as written. `choices` are
 *  the files it could mean, listed alone; `query` seeds the filter when there are none. */
export interface FinderAsk {
  query?: string;
  choices?: string[];
  /** The line the clicked reference named, kept for whichever file is picked. */
  line?: number;
  note?: string;
}
const FINDER_EVENT = "henry:finder";
export function openFinder(ask: FinderAsk): void {
  window.dispatchEvent(new CustomEvent<FinderAsk>(FINDER_EVENT, { detail: ask }));
}
export function onFinder(cb: (ask: FinderAsk) => void): () => void {
  const on = (e: Event) => cb((e as CustomEvent<FinderAsk>).detail);
  window.addEventListener(FINDER_EVENT, on);
  return () => window.removeEventListener(FINDER_EVENT, on);
}

/**
 * Open a path clicked somewhere, trying `candidates` as written first (a wrapped path and its
 * pieces). None a file: the files ending the same way, in the session's repos and then every
 * other repo on that machine. One opens; several are listed to pick from; none lists the
 * nearest names. A click always shows something.
 */
export async function peekAnywhere(candidates: string[], cwd: string | undefined, sessionId: string | null): Promise<void> {
  for (const c of candidates) {
    const { path, line } = splitLineRef(c);
    if (await openPeek(path, cwd, line)) return;
  }
  const { path, line } = splitLineRef(candidates[0] ?? "");
  if (!path) return;
  const st = getState();
  const peer = st.sessions.find((x) => x.id === sessionId)?.peer;
  const mine = sessionId ? (await fetchSessionFiles(sessionId)).repos.map((r) => r.path) : [];
  let hits = await filesByTail(path, mine, peer);
  if (!hits.length) {
    const others = new Set<string>();
    for (const [sid, rs] of Object.entries(st.repos)) if (st.sessions.find((x) => x.id === sid)?.peer === peer) for (const r of rs) others.add(r.path);
    if (!peer) {
      const r = await fetch("/api/repos/state");
      if (r.ok) for (const x of (await r.json()) as RepoState[]) others.add(x.path);
    }
    for (const p of mine) others.delete(p);
    hits = await filesByTail(path, [...others], peer);
  }
  if (hits.length === 1 && (await openPeek(hits[0]!, undefined, line))) return;
  openFinder(hits.length
    ? { choices: hits, line, note: `${path} is not there. ${hits.length} files end the same way:` }
    : { query: baseName(path).replace(/\.[^.]*$/, ""), line, note: `No file named like ${path}. Nearest names:` });
}

export function FilePicker({ onClose, query: seed, choices, line, note }: FinderAsk & { onClose: () => void }) {
  const active = useStore((s) => s.activeSessionId);
  const cwd = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.cwd ?? "");
  // Peeks open on the active session's machine, so only repos of sessions there are in scope.
  const peer = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.peer);
  const sameMachine = useStore((s) => s.sessions.filter((x) => x.peer === peer).map((x) => x.id).join("\n"));
  const allRepos = useStore((s) => s.repos);
  const sf = useSessionFiles(active);
  const [query, setQuery] = useState(seed ?? "");
  const [index, setIndex] = useState(0);
  const [indexes, setIndexes] = useState<Record<string, string[]>>({});
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const origin = focusOrigin();
    return () => restoreFocus(origin);
  }, []);

  // Repos in scope, in preference order. Membership decides the tier; order breaks ties.
  const scope = useMemo(() => {
    const out: { path: string; name: string; mine: boolean }[] = [];
    const add = (path: string, name: string, mine: boolean) => {
      if (!out.some((r) => r.path === path)) out.push({ path, name, mine });
    };
    for (const r of sf?.repos ?? []) add(r.path, r.name, true);
    for (const r of allRepos[active ?? ""] ?? []) add(r.path, r.name, true);
    const here = new Set(sameMachine.split("\n"));
    for (const [sid, rs] of Object.entries(allRepos)) if (sid !== active && here.has(sid)) for (const r of rs) add(r.path, r.name, false);
    out.sort((a, b) => Number(under(cwd, b.path)) - Number(under(cwd, a.path)));
    return out;
  }, [sf, allRepos, active, cwd, sameMachine]);

  useEffect(() => {
    let on = true;
    for (const r of scope) repoIndex(r.path, peer).then((files) => on && setIndexes((prev) => (prev[r.path] === files ? prev : { ...prev, [r.path]: files })));
    return () => {
      on = false;
    };
  }, [scope, peer]);

  const rows = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    const out: Row[] = [];
    const push = (row: Omit<Row, "score">) => {
      if (seen.has(row.abs)) return;
      const sc = tokens.length ? matches(tokens, row.rel) : 0;
      if (sc === -Infinity) return;
      seen.add(row.abs);
      out.push({ ...row, score: sc });
    };
    if (choices) {
      for (const abs of choices) {
        const repo = scope.find((r) => abs !== r.path && under(abs, r.path));
        push({ abs, rel: repo ? abs.slice(repo.path.length + 1).replace(/\\/g, "/") : abs, repoName: repo?.name ?? "", tier: repo?.mine ? 2 : 3 });
      }
      out.sort((a, b) => a.tier - b.tier || b.score - a.score || a.rel.localeCompare(b.rel));
      return out;
    }
    for (const r of sf?.repos ?? []) {
      for (const f of r.files) if (f.status !== "D") push({ abs: joinPath(r.path, f.path), rel: f.path, repoName: r.name, tier: 0, status: f.status, committed: f.committed, mtime: f.mtime });
    }
    for (const abs of recentFiles()) {
      const repo = scope.find((r) => abs !== r.path && under(abs, r.path));
      push({ abs, rel: repo ? abs.slice(repo.path.length + 1).replace(/\\/g, "/") : abs, repoName: repo?.name ?? "", tier: 1 });
    }
    // Without a query the index would be an arbitrary wall of files; the hint says it is there.
    if (tokens.length) {
      for (const r of scope) for (const rel of indexes[r.path] ?? []) push({ abs: joinPath(r.path, rel), rel, repoName: r.name, tier: r.mine ? 2 : 3 });
    }
    out.sort((a, b) => a.tier - b.tier || b.score - a.score || (b.mtime ?? 0) - (a.mtime ?? 0) || a.rel.localeCompare(b.rel));
    return out.slice(0, MAX_ROWS);
  }, [query, sf, scope, indexes, choices]);

  const sel = Math.min(index, Math.max(rows.length - 1, 0));
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel, rows]);

  const indexed = scope.reduce((n, r) => n + (indexes[r.path]?.length ?? 0), 0);

  const open = (row: Row | undefined) => {
    if (!row) return;
    void openPeek(row.abs, undefined, choices || seed ? line : undefined);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(Math.min(sel + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(Math.max(sel - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(rows[sel]);
    }
  };

  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal picker-files" onMouseDown={(e) => e.stopPropagation()}>
        {note && <div className="picker-note">{note}</div>}
        <input className="picker-input" autoFocus value={query} spellCheck={false} onFocus={(e) => e.target.select()}
          placeholder={choices ? "narrow these down — ↑↓ then Enter" : active ? "file name — changed files first, ↑↓ then Enter" : "pick a session first"}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }} onKeyDown={onKey} />
        <div className="list" ref={listRef}>
          {rows.map((r, i) => {
            const { dir, name } = splitPath(r.rel);
            return (
              <div key={r.abs} className={"row" + (i === sel ? " sel" : "")} onMouseEnter={() => setIndex(i)} onClick={() => open(r)} title={r.abs}>
                <span className="file-cell">
                  <span className={"fstat" + (r.status ? " s-" + r.status : "") + (r.committed ? " committed" : "")}>{r.status ?? TIER_GLYPH[r.tier]}</span>
                  <span>{name}</span>
                  <span className="kind-word">{dir}</span>
                </span>
                {scope.length > 1 && <span className="path">{r.repoName}</span>}
              </div>
            );
          })}
          {!rows.length && (
            <div className="row placeholder">
              {!active ? "no session selected" : !query ? (sf ? "no changed or recent files" : "loading…") : "no match"}
            </div>
          )}
        </div>
        <div className="foot hint">
          <span>{choices ? `${rows.length} of ${choices.length} files` : query ? `${rows.length}${rows.length === MAX_ROWS ? "+" : ""} of ${indexed} files` : `type to search ${indexed} files in ${scope.length} repo${scope.length === 1 ? "" : "s"}`}</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
