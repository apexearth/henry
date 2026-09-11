// A root row of the Files tree. When the root is a repo the session has touched, the row is
// also the repo's card, condensed to one line: name, branch, ↑↓ against the upstream, commits
// since the session's baseline, open PRs, then icon buttons for the diff (with the dirty
// count), the commit graph and the remote. The path and the last commit live in tooltips.
// The commit log and the PR list unfold under the row, in the tree's own indentation.
import { useEffect, useState } from "react";
import type { PullRequest, RepoPrs, RepoState } from "@henry/shared";
import { DiffView } from "./DiffView";
import { CommitModal, RepoModal, TreeModal, relTime } from "./GitTree";
import { baseName } from "./platform";
import { PrIcon } from "./PrsMenu";
import { hueText, nameHue } from "./theme";
import { diffKey, requestDiff, useStore } from "./ws";

interface LogEntry {
  sha: string;
  ts: number;
  subject: string;
}

export interface FilesRootProps {
  path: string;
  name: string;
  pinned: boolean;
  /** The session's card for this root; absent for a pinned folder or before the watcher reports. */
  repo?: RepoState;
  sessionId: string | null;
  open: boolean;
  sel: boolean;
  style: React.CSSProperties;
  onHover: () => void;
  onToggle: () => void;
  onUnpin: () => void;
}

/** A commit graph in eleven pixels: a trunk with a branch leaving it. Same stroke as PrIcon. */
function TreeIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="4" cy="3.5" r="2" />
      <circle cx="4" cy="12.5" r="2" />
      <circle cx="12" cy="4.5" r="2" />
      <path d="M4 5.5v5M4 10.5C4 7.5 12 9.5 12 6.5" strokeLinecap="round" />
    </svg>
  );
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function FilesRoot({ path, name, pinned, repo, sessionId, open, sel, style, onHover, onToggle, onUnpin }: FilesRootProps) {
  const [showDiff, setShowDiff] = useState(false);
  const [showTree, setShowTree] = useState(false);
  const [commit, setCommit] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [showPrs, setShowPrs] = useState(false);
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [prNote, setPrNote] = useState<string | null>(null);
  const [prErr, setPrErr] = useState<string | null>(null);
  const diff = useStore((s) => (sessionId ? s.diffs[diffKey(sessionId, path)] : undefined));

  const loadLog = async () => {
    if (!sessionId) return;
    setLogErr(null);
    try {
      const q = new URLSearchParams({ sessionId, repoPath: path });
      const res = await fetch(`/api/repo/log?${q}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLog(((await res.json()) as { commits: LogEntry[] }).commits);
    } catch (e) {
      setLogErr((e as Error).message);
    }
  };

  // `refresh` skips the daemon's PR cache, for when you just opened or merged one.
  const loadPrs = async (refresh = false) => {
    if (!sessionId) return;
    setPrErr(null);
    try {
      const q = new URLSearchParams({ sessionId, repoPath: path });
      if (refresh) q.set("refresh", "1");
      const res = await fetch(`/api/repo/prs?${q}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as RepoPrs;
      setPrs(body.prs);
      setPrNote(body.note ?? null);
    } catch (e) {
      setPrErr((e as Error).message);
    }
  };

  // Open lists follow the daemon: a new commit or PR count re-reads them.
  useEffect(() => {
    if (showLog) void loadLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLog, repo?.commitsSinceBaseline, repo?.head]);
  useEffect(() => {
    if (showPrs) void loadPrs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPrs, repo?.openPrs]);

  const openDiff = () => {
    if (sessionId) requestDiff(sessionId, path);
    setShowDiff(true);
  };

  const since = repo?.commitsSinceBaseline ?? 0;
  const tip = repo
    ? `${path}${repo.isWorktree && repo.worktreeOf ? `\nworktree of ${baseName(repo.worktreeOf)}` : ""}\nlast commit ${relTime(repo.lastCommitAt)}${repo.baseline ? `\nbaseline ${repo.baseline.slice(0, 7)}` : ""}`
    : path;
  return (
    <>
      <div className={"files-row files-root" + (sel ? " sel" : "")} style={style} title={tip} onMouseEnter={onHover} onClick={onToggle}>
        <span className="fold" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="title" style={{ color: hueText(nameHue(name)) }}>{name}</span>
        {repo && (
          <>
            {repo.isWorktree && <span className="fr-wt" title={repo.worktreeOf ? `worktree of ${baseName(repo.worktreeOf)}` : "worktree"}>wt</span>}
            <span className={"fr-branch" + (repo.branch === "(detached)" ? " fr-detached" : "")}
              title={repo.upstream ? `${repo.branch}, tracking ${repo.upstream}` : `${repo.branch}, no upstream`}>
              {repo.branch || "?"}
            </span>
            {repo.upstream ? (
              <>
                {repo.ahead > 0 && <span className="fr-ahead" title={`${repo.ahead} commit${repo.ahead === 1 ? "" : "s"} not pushed`}>↑{repo.ahead}</span>}
                {repo.behind > 0 && <span className="fr-behind" title={`${repo.behind} commit${repo.behind === 1 ? "" : "s"} behind ${repo.upstream}`}>↓{repo.behind}</span>}
              </>
            ) : (
              <span className="fr-noup" title="no upstream: nothing has been pushed">↑∅</span>
            )}
            {since > 0 && (
              <button className={"fr-btn fr-since" + (showLog ? " on" : "")} onMouseDown={stop} onClick={(e) => { stop(e); setShowLog((v) => !v); }}
                title={`${since} commit${since === 1 ? "" : "s"} since this session's baseline${showLog ? "" : " — click to list them"}`}>
                +{since}
              </button>
            )}
            <span className="fr-spacer" />
            {!!repo.openPrs && (
              <button className={"fr-btn fr-prs" + (showPrs ? " on" : "")} onMouseDown={stop} onClick={(e) => { stop(e); setShowPrs((v) => !v); }}
                title={`${repo.openPrs} open pull request${repo.openPrs === 1 ? "" : "s"} on the remote${showPrs ? "" : " — click to list them"}`}>
                <PrIcon />{repo.openPrs}
              </button>
            )}
            <button className={"fr-btn fr-diff" + (repo.dirty ? " dirty" : "")} onMouseDown={stop} onClick={(e) => { stop(e); openDiff(); }}
              title={`${repo.dirty ? `${repo.dirty} uncommitted path${repo.dirty === 1 ? "" : "s"}` : "clean"} — diff against the session's baseline`}>
              ±{repo.dirty}
            </button>
            <button className="fr-btn" onMouseDown={stop} onClick={(e) => { stop(e); setShowTree(true); }} title="commit graph of every branch">
              <TreeIcon />
            </button>
            {repo.remoteUrl && (
              <a className="fr-btn" href={repo.remoteUrl} target="_blank" rel="noopener noreferrer" onMouseDown={stop} onClick={stop}
                title={`open ${repo.remoteUrl}`}>↗</a>
            )}
          </>
        )}
        {pinned && <button className="files-unpin" title="unpin this folder" onClick={(e) => { stop(e); onUnpin(); }}>&times;</button>}
      </div>
      {repo && showLog && (
        <div className="fr-list">
          {logErr && <div className="fr-note files-err">log failed: {logErr}</div>}
          {!logErr && log === null && <div className="fr-note">loading…</div>}
          {log?.length === 0 && <div className="fr-note">no commits since baseline</div>}
          {log?.map((c) => (
            <div key={c.sha} className="fr-line">
              <button className="fr-sha" onClick={() => setCommit(c.sha)} title="open this commit">{c.sha}</button>
              <span className="fr-subject" title={c.subject}>{c.subject}</span>
              <span className="fr-when">{relTime(c.ts)}</span>
            </div>
          ))}
        </div>
      )}
      {repo && showPrs && (
        <div className="fr-list">
          {prErr && <div className="fr-note files-err">PRs failed: {prErr}</div>}
          {!prErr && prs === null && <div className="fr-note">loading…</div>}
          {prs?.length === 0 && <div className="fr-note">{prNote ?? "none open"}</div>}
          {prs?.map((p) => (
            <div key={p.number} className="fr-line">
              <a className="fr-sha" href={p.url} target="_blank" rel="noopener noreferrer" title={`open #${p.number} on GitHub`}>#{p.number}</a>
              {/* Clipped from the right, so "draft" leads or it would vanish. */}
              <span className="fr-subject" title={`${p.title}${p.branch ? ` (${p.branch})` : ""}`}>
                {p.draft && <span className="fr-draft">draft</span>}
                {p.title}
              </span>
              <span className="fr-when">{p.author} · {relTime(p.updatedAt)}</span>
            </div>
          ))}
          <div className="fr-note">
            {prs !== null && prs.length > 0 && prNote ? `${prNote} · ` : ""}
            <button className="fr-link" onClick={() => void loadPrs(true)} title="ask GitHub again now">refresh</button>
          </div>
        </div>
      )}
      {repo && showDiff && (
        <RepoModal repo={repo} subtitle={<span className="rc-dim">diff</span>}
          actions={<button className="rc-link" onClick={openDiff} title="re-request the diff from the daemon">refresh</button>}
          onClose={() => setShowDiff(false)}>
          {diff ? <DiffView repoPath={path} baseline={diff.baseline} diff={diff.diff} /> : <div className="rc-dim rc-loading">loading diff…</div>}
        </RepoModal>
      )}
      {repo && sessionId && showTree && <TreeModal sessionId={sessionId} repo={repo} onOpenCommit={setCommit} onClose={() => setShowTree(false)} />}
      {repo && sessionId && commit && <CommitModal sessionId={sessionId} repo={repo} sha={commit} onOpenCommit={setCommit} onClose={() => setCommit(null)} />}
    </>
  );
}
