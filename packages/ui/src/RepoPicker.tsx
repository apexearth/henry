// "+ new": one text box, type to filter, ↑↓ to pick, Enter to open. Rows are every repo as
// a Claude session, then every repo (and ~) as a plain terminal; a typed path offers both.
import { useEffect, useMemo, useRef, useState } from "react";
import type { RepoPickerEntry, SessionKind } from "@henry/shared";
import { createSession, useStore } from "./ws";

interface Row {
  key: string;
  kind: SessionKind;
  path: string;
  label: string;
  /** Lower-cased haystack the query tokens must all appear in. */
  search: string;
}

function base(p: string) {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

function buildRows(repos: RepoPickerEntry[], preferred: string, query: string): Row[] {
  const rows: Row[] = [];
  const q = query.trim();
  // A typed path (absolute or ~) is offered as-is, ahead of the repo list.
  if (/^[~/]/.test(q)) {
    rows.push({ key: `claude:${q}`, kind: "claude", path: q, label: base(q), search: `claude ${q}` });
    rows.push({ key: `shell:${q}`, kind: "shell", path: q, label: base(q), search: `terminal shell $ ${q}` });
  }
  const sorted = [...repos].sort((a, b) => (a.path === preferred ? -1 : b.path === preferred ? 1 : a.name.localeCompare(b.name)));
  // The repo you are already in may live outside reposRoot; offer it anyway, first.
  if (preferred && !repos.some((r) => r.path === preferred)) {
    sorted.unshift({ path: preferred, name: base(preferred), isWorktree: false });
  }
  for (const r of sorted) {
    const label = r.name + (r.isWorktree ? " (worktree)" : "");
    rows.push({ key: `claude:${r.path}`, kind: "claude", path: r.path, label, search: `claude ${r.name} ${r.path}` });
  }
  rows.push({ key: "shell:~", kind: "shell", path: "~", label: "~", search: "terminal shell $ ~ home" });
  for (const r of sorted) {
    const label = r.name + (r.isWorktree ? " (worktree)" : "");
    rows.push({ key: `shell:${r.path}`, kind: "shell", path: r.path, label, search: `terminal shell $ ${r.name} ${r.path}` });
  }
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    const hay = row.search.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

export function RepoPicker({ onClose }: { onClose: () => void }) {
  // Start on the repo of the session you are in; fall back to the configured default.
  const preferred = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.cwd ?? s.config?.defaultRepo ?? "");
  const [repos, setRepos] = useState<RepoPickerEntry[]>([]);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/repos")
      .then((r) => r.json())
      .then((list: RepoPickerEntry[]) => setRepos(list))
      .catch(() => setRepos([]));
  }, []);

  const rows = useMemo(() => buildRows(repos, preferred, query), [repos, preferred, query]);
  const sel = Math.min(index, Math.max(rows.length - 1, 0));

  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel, rows]);

  const open = (row: Row | undefined) => {
    if (!row) return;
    createSession(row.path, undefined, row.kind);
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
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <input className="picker-input" autoFocus value={query} spellCheck={false}
          placeholder="repo name, “terminal”, or a path — ↑↓ then Enter"
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }} onKeyDown={onKey} />
        <div className="list" ref={listRef}>
          {rows.map((r, i) => (
            <div key={r.key} className={"row" + (i === sel ? " sel" : "")} onMouseEnter={() => setIndex(i)} onClick={() => open(r)}>
              <span>
                <span className={"kind " + r.kind}>{r.kind === "claude" ? "✦" : "$"}</span>
                {r.label}
                <span className="kind-word">{r.kind === "claude" ? "claude" : "terminal"}</span>
              </span>
              <span className="path">{r.path}</span>
            </div>
          ))}
          {!rows.length && <div className="row placeholder">{repos.length ? "no match" : "no repos found under reposRoot; type a path"}</div>}
        </div>
        <div className="foot hint">
          <span>✦ Claude Code · $ terminal ({"$SHELL -l"})</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
