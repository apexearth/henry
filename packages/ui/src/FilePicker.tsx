// ⌘K: find a file to peek at. Changed files of the session you are looking at come first,
// then recent peeks, then every file in that session's repos (the one its cwd is in first),
// then other sessions' repos. Type to fuzzy-filter; ↑↓ then Enter opens a peek.
import { useEffect, useMemo, useRef, useState } from "react";
import { focusOrigin, restoreFocus } from "./dock";
import { openPeek } from "./FileView";
import { recentFiles, repoIndex, splitPath, useSessionFiles } from "./files";
import { joinPath, under } from "./platform";
import { useStore } from "./ws";

interface Row {
  abs: string;
  rel: string;
  repoName: string;
  /** 0 changed · 1 recent · 2 this session's repos · 3 other repos */
  tier: number;
  status?: string;
  mtime?: number;
  score: number;
}

const MAX_ROWS = 200;

/** Subsequence match; rewards word starts, runs, and hits in the file name. -Infinity: no match. */
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

const TIER_GLYPH = ["", "↺", "", ""];

export function FilePicker({ onClose }: { onClose: () => void }) {
  const active = useStore((s) => s.activeSessionId);
  const cwd = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.cwd ?? "");
  // Peeks open on the active session's machine, so only repos of sessions there are in scope.
  const peer = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.peer);
  const sameMachine = useStore((s) => s.sessions.filter((x) => x.peer === peer).map((x) => x.id).join("\n"));
  const allRepos = useStore((s) => s.repos);
  const sf = useSessionFiles(active);
  const [query, setQuery] = useState("");
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
    for (const r of sf?.repos ?? []) {
      for (const f of r.files) if (f.status !== "D") push({ abs: joinPath(r.path, f.path), rel: f.path, repoName: r.name, tier: 0, status: f.status, mtime: f.mtime });
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
  }, [query, sf, scope, indexes]);

  const sel = Math.min(index, Math.max(rows.length - 1, 0));
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel, rows]);

  const indexed = scope.reduce((n, r) => n + (indexes[r.path]?.length ?? 0), 0);

  const open = (row: Row | undefined) => {
    if (!row) return;
    void openPeek(row.abs);
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
        <input className="picker-input" autoFocus value={query} spellCheck={false}
          placeholder={active ? "file name — changed files first, ↑↓ then Enter" : "pick a session first"}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }} onKeyDown={onKey} />
        <div className="list" ref={listRef}>
          {rows.map((r, i) => {
            const { dir, name } = splitPath(r.rel);
            return (
              <div key={r.abs} className={"row" + (i === sel ? " sel" : "")} onMouseEnter={() => setIndex(i)} onClick={() => open(r)} title={r.abs}>
                <span className="file-cell">
                  <span className={"fstat" + (r.status ? " s-" + r.status : "")}>{r.status ?? TIER_GLYPH[r.tier]}</span>
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
          <span>{query ? `${rows.length}${rows.length === MAX_ROWS ? "+" : ""} of ${indexed} files` : `type to search ${indexed} files in ${scope.length} repo${scope.length === 1 ? "" : "s"}`}</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
