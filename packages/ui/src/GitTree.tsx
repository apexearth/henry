// Repo modals: the full-screen shell the Repos panel opens over the app, the commit graph
// ("tree") of a repo, and one commit's details + patch. Modals stack: a commit opened from
// the tree sits above it, and Esc only closes the top one.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { RepoState } from "@henry/shared";
import { DiffView } from "./DiffView";
import { hueText, nameHue } from "./theme";

export interface GraphLine {
  graph: string;
  sha?: string;
  refs?: string;
  subject?: string;
  ts?: number;
  author?: string;
}

export interface CommitDetail {
  sha: string;
  fullSha: string;
  parents: string[];
  refs?: string;
  author: string;
  email: string;
  ts: number;
  subject: string;
  body: string;
  diff: string;
}

export function relTime(ms?: number): string {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function shortPath(p: string): string {
  const home = p.match(/^\/(?:Users|home)\/[^/]+/)?.[0];
  return home ? "~" + p.slice(home.length) : p;
}

// ---- modal shell ----

const modalStack: symbol[] = [];

interface RepoModalProps {
  repo: RepoState;
  /** Shown after the repo name, e.g. the commit sha. */
  subtitle?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

// The side panel is too narrow for a diff or a graph, so these open over the whole app.
// Portaled to body so the panel's overflow/stacking cannot clip them.
export function RepoModal({ repo, subtitle, actions, onClose, children }: RepoModalProps) {
  // Registered once per mount so a re-render of a lower modal cannot move it to the top.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const id = Symbol();
    modalStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modalStack[modalStack.length - 1] === id) closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      modalStack.splice(modalStack.indexOf(id), 1);
    };
  }, []);

  return createPortal(
    <div className="dm-bg" onMouseDown={onClose}>
      <div className="dm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dm-head">
          <span className="rc-name" style={{ color: hueText(nameHue(repo.name)) }}>{repo.name}</span>
          {subtitle}
          <span className="rc-path dm-path" title={repo.path}>{shortPath(repo.path)}</span>
          <span className="rc-spacer" />
          {actions}
          <button className="dm-close" onClick={onClose} title="close (Esc)">×</button>
        </div>
        <div className="dm-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ---- refs ----

/** "HEAD -> main, origin/main, tag: v1" as coloured chips. */
export function Refs({ refs }: { refs?: string }) {
  if (!refs) return null;
  return (
    <>
      {refs.split(", ").map((r) => {
        const head = r.startsWith("HEAD -> ");
        const name = head ? r.slice(8) : r;
        const cls = r.startsWith("tag: ") ? "gt-tag" : name.includes("/") ? "gt-remote" : "gt-branch";
        return (
          <span key={r} className={`gt-ref ${cls} ${head ? "gt-head" : ""}`} title={head ? "checked out" : cls.slice(3)}>
            {name}
          </span>
        );
      })}
    </>
  );
}

// ---- tree ----

interface TreeModalProps {
  sessionId: string;
  repo: RepoState;
  onOpenCommit: (sha: string) => void;
  onClose: () => void;
}

export function TreeModal({ sessionId, repo, onOpenCommit, onClose }: TreeModalProps) {
  const [tree, setTree] = useState<{ head: string; lines: GraphLine[]; truncated: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);

  const load = async () => {
    setErr(null);
    try {
      const q = new URLSearchParams({ sessionId, repoPath: repo.path, limit: String(limit) });
      const res = await fetch(`/api/repo/tree?${q}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTree(await res.json());
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  // Reload when the repo moves while the tree is open.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.head, repo.ahead, repo.behind, limit]);

  const commits = tree?.lines.filter((l) => l.sha).length ?? 0;
  return (
    <RepoModal
      repo={repo}
      subtitle={<span className="rc-dim">tree</span>}
      actions={
        <>
          {tree && <span className="rc-dim">{commits} commit{commits === 1 ? "" : "s"}{tree.truncated ? ` of more, showing ${limit}` : ""}</span>}
          {tree?.truncated && <button className="rc-link" onClick={() => setLimit(400)} title="show up to 400 commits">more</button>}
          <button className="rc-link" onClick={load} title="re-read the graph">refresh</button>
        </>
      }
      onClose={onClose}
    >
      <style>{TREE_CSS}</style>
      {err && <div className="rc-err">tree failed: {err}</div>}
      {!err && tree === null && <div className="rc-dim rc-loading">loading tree…</div>}
      {tree && tree.lines.length === 0 && <div className="rc-dim rc-loading">no commits yet</div>}
      {tree && tree.lines.length > 0 && (
        <table className="gt">
          <tbody>
            {tree.lines.map((l, i) => (
              <tr key={i} className={l.sha ? "gt-commit" : "gt-conn"}>
                <td className="gt-graph">{l.graph}</td>
                {l.sha ? (
                  <>
                    <td className="gt-sha">
                      <button className={`gt-shabtn ${l.sha === tree.head ? "gt-cur" : ""}`} onClick={() => onOpenCommit(l.sha!)} title="open this commit">
                        {l.sha}
                      </button>
                    </td>
                    <td className="gt-subject">
                      <Refs refs={l.refs} />
                      <span className="gt-msg" title={l.subject}>{l.subject}</span>
                    </td>
                    <td className="gt-author" title={l.author}>{l.author}</td>
                    <td className="gt-when" title={l.ts ? new Date(l.ts).toLocaleString() : ""}>{relTime(l.ts)}</td>
                  </>
                ) : (
                  <td colSpan={4} />
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </RepoModal>
  );
}

// ---- commit ----

interface CommitModalProps {
  sessionId: string;
  repo: RepoState;
  sha: string;
  /** A parent sha was clicked: swap this view to that commit. */
  onOpenCommit: (sha: string) => void;
  onClose: () => void;
}

export function CommitModal({ sessionId, repo, sha, onOpenCommit, onClose }: CommitModalProps) {
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    setCommit(null);
    setErr(null);
    const q = new URLSearchParams({ sessionId, repoPath: repo.path, sha });
    fetch(`/api/repo/commit?${q}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "no such commit" : `HTTP ${res.status}`);
        return (await res.json()) as CommitDetail;
      })
      .then((c) => on && setCommit(c))
      .catch((e) => on && setErr((e as Error).message));
    return () => {
      on = false;
    };
  }, [sessionId, repo.path, sha]);

  return (
    <RepoModal
      repo={repo}
      subtitle={<span className="gt-shabtn gt-static">{commit?.sha ?? sha}</span>}
      actions={
        commit && (
          <button className="rc-link" onClick={() => navigator.clipboard?.writeText(commit.fullSha)} title="copy the full sha">
            copy sha
          </button>
        )
      }
      onClose={onClose}
    >
      <style>{TREE_CSS}</style>
      {err && <div className="rc-err">commit failed: {err}</div>}
      {!err && commit === null && <div className="rc-dim rc-loading">loading commit…</div>}
      {commit && (
        <>
          <div className="gc-head">
            <div className="gc-subject">
              {commit.subject}
              <Refs refs={commit.refs} />
            </div>
            <div className="gc-meta">
              <span title={commit.email}>{commit.author}</span>
              <span className="rc-sep">·</span>
              <span title={new Date(commit.ts).toLocaleString()}>{new Date(commit.ts).toLocaleString()} ({relTime(commit.ts)})</span>
              <span className="rc-sep">·</span>
              <span className="gc-full" title="full sha">{commit.fullSha}</span>
              {commit.parents.length > 0 && (
                <>
                  <span className="rc-sep">·</span>
                  <span>
                    parent{commit.parents.length === 1 ? "" : "s"}{" "}
                    {commit.parents.map((p) => (
                      <button key={p} className="gt-shabtn" onClick={() => onOpenCommit(p)} title="open the parent commit">{p}</button>
                    ))}
                  </span>
                </>
              )}
            </div>
            {commit.body && <pre className="gc-body">{commit.body}</pre>}
          </div>
          <DiffView repoPath={repo.path} baseline={commit.parents[0] ?? ""} diff={commit.diff} />
        </>
      )}
    </RepoModal>
  );
}

const TREE_CSS = `
.gt { border-collapse: collapse; font-family: var(--mono); font-size: 12px; width: 100%; }
.gt td { padding: 0 6px; white-space: nowrap; vertical-align: top; line-height: 1.5; }
.gt-graph { color: var(--fg-dim); white-space: pre !important; padding-left: 0 !important; user-select: none; }
.gt-commit .gt-graph { color: var(--accent); }
.gt-conn td { line-height: 1.2; }
.gt-sha { width: 1px; }
.gt-shabtn { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font: inherit; }
.gt-shabtn:hover { text-decoration: underline; }
.gt-shabtn.gt-cur { font-weight: bold; }
.gt-static { cursor: default; }
.gt-static:hover { text-decoration: none; }
.gt-subject { overflow: hidden; text-overflow: ellipsis; max-width: 0; width: 100%; }
.gt-msg { overflow: hidden; text-overflow: ellipsis; }
.gt-author { color: var(--fg-dim); max-width: 12em; overflow: hidden; text-overflow: ellipsis; }
.gt-when { color: var(--fg-dim); text-align: right; }
.gt-ref { font-size: 10px; border-radius: 3px; padding: 0 4px; border: 1px solid var(--border); margin-right: 5px; color: var(--fg-dim); vertical-align: 1px; }
.gt-branch { color: var(--ok); border-color: var(--ok); }
.gt-remote { color: var(--warn); border-color: var(--warn); }
.gt-tag { color: var(--accent); border-color: var(--accent); }
.gt-head { font-weight: bold; background: rgba(63,185,80,.14); }
.gc-head { padding: 10px 0 4px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px; }
.gc-subject { font-size: 14px; font-weight: bold; }
.gc-subject .gt-ref { margin-left: 5px; margin-right: 0; font-weight: normal; }
.gc-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 11px; color: var(--fg-dim); }
.gc-meta .gt-shabtn { margin-right: 6px; }
.gc-full { user-select: all; }
.gc-body { white-space: pre-wrap; margin: 4px 0 0; font-size: 12px; color: var(--fg); }
`;
