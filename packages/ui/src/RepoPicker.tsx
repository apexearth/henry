// "+ new": one text box, type to filter, ↑↓ to pick, Enter to open. Rows are every repo (and
// plain folder under reposRoot) as a Claude session, then the same and ~ as a plain terminal;
// a typed path offers both.
import { useEffect, useMemo, useRef, useState } from "react";
import type { RepoPickerEntry, SessionKind } from "@henry/shared";
import { baseName } from "./platform";
import { hueText, nameHue } from "./theme";
import { createSession, useStore } from "./ws";

interface Row {
  key: string;
  kind: SessionKind;
  path: string;
  label: string;
  /** The repo name inside the label, coloured like the rail; absent for the home row. */
  name?: string;
  /** Lower-cased haystack the query tokens must all appear in. */
  search: string;
}

const base = baseName;

function labelOf(r: RepoPickerEntry) {
  return r.name + (r.isWorktree ? " (worktree)" : r.folder ? " (folder)" : "");
}

function searchOf(r: RepoPickerEntry) {
  return `${r.name} ${r.path}${r.isWorktree ? " worktree" : r.folder ? " folder" : ""}`;
}

function buildRows(repos: RepoPickerEntry[], preferred: string, query: string): Row[] {
  const rows: Row[] = [];
  const q = query.trim();
  // A typed path (absolute, `C:\`, or ~) is offered as-is, ahead of the repo list.
  if (/^(~|[\\/]|[A-Za-z]:[\\/])/.test(q)) {
    rows.push({ key: `claude:${q}`, kind: "claude", path: q, label: base(q), name: base(q), search: `claude ${q}` });
    rows.push({ key: `shell:${q}`, kind: "shell", path: q, label: base(q), name: base(q), search: `terminal shell $ ${q}` });
  }
  const sorted = [...repos].sort((a, b) => (a.path === preferred ? -1 : b.path === preferred ? 1 : a.name.localeCompare(b.name)));
  // The repo you are already in may live outside reposRoot; offer it anyway, first.
  if (preferred && !repos.some((r) => r.path === preferred)) {
    sorted.unshift({ path: preferred, name: base(preferred), isWorktree: false });
  }
  for (const r of sorted) {
    rows.push({ key: `claude:${r.path}`, kind: "claude", path: r.path, label: labelOf(r), name: r.name, search: `claude ${searchOf(r)}` });
  }
  rows.push({ key: "shell:~", kind: "shell", path: "~", label: "~", search: "terminal shell $ ~ home" });
  for (const r of sorted) {
    rows.push({ key: `shell:${r.path}`, kind: "shell", path: r.path, label: labelOf(r), name: r.name, search: `terminal shell $ ${searchOf(r)}` });
  }
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    const hay = row.search.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

export function RepoPicker({ onClose }: { onClose: () => void }) {
  // Start on the repo of the session you are in; fall back to the configured default.
  const activeSession = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId));
  const defaultRepo = useStore((s) => s.config?.defaultRepo ?? "");
  const localHost = useStore((s) => s.host);
  // Paired machines with a live link can host the new session too; start on the active session's.
  const peers = useStore((s) => s.peers);
  const machines = useMemo(() => peers.filter((p) => p.link === "connected").map((p) => p.name), [peers]);
  const [peer, setPeer] = useState<string | undefined>(activeSession?.peer);
  const onPeer = peer && machines.includes(peer) ? peer : undefined;
  const preferred = activeSession?.peer === onPeer ? activeSession?.cwd ?? (onPeer ? "" : defaultRepo) : onPeer ? "" : defaultRepo;
  const [repos, setRepos] = useState<RepoPickerEntry[]>([]);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let on = true;
    setRepos([]);
    fetch(onPeer ? `/api/repos?peer=${encodeURIComponent(onPeer)}` : "/api/repos")
      .then((r) => r.json())
      .then((list: RepoPickerEntry[]) => on && setRepos(Array.isArray(list) ? list : []))
      .catch(() => on && setRepos([]));
    return () => {
      on = false;
    };
  }, [onPeer]);

  const rows = useMemo(() => buildRows(repos, preferred, query), [repos, preferred, query]);
  const sel = Math.min(index, Math.max(rows.length - 1, 0));

  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel, rows]);

  const open = (row: Row | undefined) => {
    if (!row) return;
    createSession(row.path, undefined, row.kind, onPeer);
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
        {machines.length > 0 && (
          <div className="picker-machines" role="radiogroup" aria-label="machine">
            <span className="hint">on</span>
            {[undefined, ...machines].map((m) => (
              <button key={m ?? ""} className={"chip" + (onPeer === m ? " sel" : "")} onClick={() => { setPeer(m); setIndex(0); }}
                style={m ? { color: hueText(nameHue(m)) } : undefined} title={m ? `start the session on ${m}` : "start the session here"}>
                {m ?? localHost ?? "this machine"}
              </button>
            ))}
          </div>
        )}
        <input className="picker-input" autoFocus value={query} spellCheck={false}
          placeholder="repo name, “terminal”, or a path — ↑↓ then Enter"
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }} onKeyDown={onKey} />
        <div className="list" ref={listRef}>
          {rows.map((r, i) => (
            <div key={r.key} className={"row" + (i === sel ? " sel" : "")} onMouseEnter={() => setIndex(i)} onClick={() => open(r)}>
              <span>
                <span className={"kind " + r.kind}>{r.kind === "claude" ? "✦" : "$"}</span>
                {r.name ? <><span style={{ color: hueText(nameHue(r.name)) }}>{r.name}</span>{r.label.slice(r.name.length)}</> : r.label}
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
