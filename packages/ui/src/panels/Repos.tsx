// Milestone 3: per-repo cards (branch, ahead/behind, upstream, commits since baseline,
// dirty count, worktree path); Diff button -> DiffView; "all sessions" toggle groups by session.
import { useEffect, useState } from "react";
import type { RepoState, Session } from "@henry/shared";
import { DiffView } from "../DiffView";
import { diffKey, requestDiff, useStore } from "../ws";

export interface ReposPanelProps {
  sessionId: string | null;
  repos: RepoState[];
  diffs: Record<string, { diff: string; baseline: string }>;
  onRequestDiff: (repoPath: string) => void;
}

interface LogEntry {
  sha: string;
  ts: number;
  subject: string;
}

function relTime(ms?: number): string {
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

function shortPath(p: string): string {
  const home = p.match(/^\/(?:Users|home)\/[^/]+/)?.[0];
  return home ? "~" + p.slice(home.length) : p;
}

/** Ticks once a minute so relative times stay honest without a store update. */
function useMinuteTick(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  return n;
}

function Upstream({ repo }: { repo: RepoState }) {
  if (!repo.upstream) return <span className="rc-up rc-noup" title="branch has no upstream; nothing has been pushed">no upstream</span>;
  const synced = repo.ahead === 0 && repo.behind === 0;
  return (
    <span className="rc-up" title={`upstream ${repo.upstream}`}>
      <span className={repo.ahead ? "rc-ahead" : "rc-zero"}>↑{repo.ahead}</span>
      <span className={repo.behind ? "rc-behind" : "rc-zero"}>↓{repo.behind}</span>
      {repo.ahead > 0 && <span className="rc-tag rc-notpushed">not pushed</span>}
      {synced && <span className="rc-tag rc-synced">in sync</span>}
    </span>
  );
}

interface CardProps {
  sessionId: string;
  repo: RepoState;
  diff?: { diff: string; baseline: string };
  onRequestDiff: () => void;
}

function RepoCard({ sessionId, repo, diff, onRequestDiff }: CardProps) {
  const [showDiff, setShowDiff] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  useMinuteTick();

  const loadLog = async () => {
    setLogErr(null);
    try {
      const q = new URLSearchParams({ sessionId, repoPath: repo.path });
      const res = await fetch(`/api/repo/log?${q}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { commits: LogEntry[] };
      setLog(body.commits);
    } catch (e) {
      setLogErr((e as Error).message);
    }
  };

  const toggleLog = () => {
    const next = !showLog;
    setShowLog(next);
    if (next) void loadLog();
  };

  // Re-fetch the log when the commit count changes while it is open.
  useEffect(() => {
    if (showLog) void loadLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.commitsSinceBaseline, repo.head]);

  const toggleDiff = () => {
    const next = !showDiff;
    setShowDiff(next);
    if (next) {
      onRequestDiff();
      setRequested(true);
    }
  };

  const since = repo.commitsSinceBaseline;
  return (
    <div className="rc">
      <div className="rc-head">
        <span className="rc-name" title={repo.path}>{repo.name}</span>
        {repo.isWorktree && (
          <span className="rc-wt" title={repo.worktreeOf ?? "worktree"}>
            worktree{repo.worktreeOf ? ` of ${repo.worktreeOf.split("/").pop()}` : ""}
          </span>
        )}
        <span className="rc-spacer" />
        <button className={`rc-diffbtn ${showDiff ? "on" : ""}`} onClick={toggleDiff}>{showDiff ? "hide diff" : "diff"}</button>
      </div>
      <div className="rc-path" title={repo.path}>{shortPath(repo.path)}</div>
      <div className="rc-row">
        <span className={`rc-branch ${repo.branch === "(detached)" ? "rc-detached" : ""}`} title="current branch">
          {repo.branch || "?"}
        </span>
        <Upstream repo={repo} />
      </div>
      <div className="rc-row rc-dim">
        <span className={repo.dirty ? "rc-dirty" : ""} title="modified + untracked paths">
          {repo.dirty ? `${repo.dirty} dirty` : "clean"}
        </span>
        <span className="rc-sep">·</span>
        <button className={`rc-link ${showLog ? "on" : ""}`} onClick={toggleLog} title={repo.baseline ? `baseline ${repo.baseline.slice(0, 7)}` : "no baseline yet"}>
          {since} commit{since === 1 ? "" : "s"} since baseline {showLog ? "▾" : "▸"}
        </button>
        <span className="rc-sep">·</span>
        <span title={repo.lastCommitAt ? new Date(repo.lastCommitAt).toLocaleString() : ""}>last commit {relTime(repo.lastCommitAt)}</span>
      </div>
      {showLog && (
        <div className="rc-log">
          {logErr && <div className="rc-err">log failed: {logErr}</div>}
          {!logErr && log === null && <div className="rc-dim">loading…</div>}
          {log && log.length === 0 && <div className="rc-dim">no commits since baseline{repo.baseline ? ` ${repo.baseline.slice(0, 7)}` : ""}</div>}
          {log && log.map((c) => (
            <div key={c.sha} className="rc-logline">
              <span className="rc-sha">{c.sha}</span>
              <span className="rc-subject" title={c.subject}>{c.subject}</span>
              <span className="rc-when">{relTime(c.ts)}</span>
            </div>
          ))}
        </div>
      )}
      {showDiff && (
        diff ? (
          <>
            <div className="rc-diffbar">
              <button className="rc-link" onClick={onRequestDiff} title="re-request the diff from the daemon">refresh diff</button>
            </div>
            <DiffView repoPath={repo.path} baseline={diff.baseline} diff={diff.diff} />
          </>
        ) : (
          <div className="rc-dim rc-loading">{requested ? "loading diff…" : ""}</div>
        )
      )}
    </div>
  );
}

function sessionLabel(s: Session | undefined, id: string): string {
  if (!s) return id.slice(0, 8);
  return `${s.title}${s.status === "exited" ? " (exited)" : ""}`;
}

export function ReposPanel({ sessionId, repos, diffs, onRequestDiff }: ReposPanelProps) {
  const [all, setAll] = useState(false);
  const allRepos = useStore((s) => s.repos);
  const sessions = useStore((s) => s.sessions);

  const groups: { id: string; label: string; repos: RepoState[] }[] = all
    ? Object.entries(allRepos)
        .filter(([, list]) => list.length)
        .map(([id, list]) => ({ id, label: sessionLabel(sessions.find((s) => s.id === id), id), repos: list }))
        .sort((a, b) => (a.id === sessionId ? -1 : b.id === sessionId ? 1 : a.label.localeCompare(b.label)))
    : sessionId
      ? [{ id: sessionId, label: "", repos }]
      : [];

  const total = groups.reduce((n, g) => n + g.repos.length, 0);
  return (
    <div className="repos">
      <style>{REPOS_CSS}</style>
      <div className="repos-bar">
        <span className="rc-dim">
          {all ? `${total} repo${total === 1 ? "" : "s"} across ${groups.length} session${groups.length === 1 ? "" : "s"}` : sessionId ? `${repos.length} repo${repos.length === 1 ? "" : "s"} touched` : "no session"}
        </span>
        <label className="repos-toggle" title="show repos for every session, grouped by session">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> all sessions
        </label>
      </div>
      {!all && sessionId && repos.length === 0 && (
        <div className="rc-dim rc-empty">No repos yet. Cards appear once this session's hooks report a cwd or file inside a git checkout.</div>
      )}
      {all && total === 0 && <div className="rc-dim rc-empty">No session has touched a repo yet.</div>}
      {groups.map((g) => (
        <div key={g.id} className="repos-group">
          {all && <div className={`repos-group-head ${g.id === sessionId ? "active" : ""}`}>{g.label}</div>}
          {g.repos.map((r) => (
            <RepoCard
              key={`${g.id}:${r.path}`}
              sessionId={g.id}
              repo={r}
              diff={diffs[diffKey(g.id, r.path)]}
              onRequestDiff={() => (g.id === sessionId ? onRequestDiff(r.path) : requestDiff(g.id, r.path))}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

const REPOS_CSS = `
.repos { display: flex; flex-direction: column; gap: 8px; }
.repos-bar { display: flex; justify-content: space-between; align-items: center; font-size: 11px; }
.repos-toggle { color: var(--fg-dim); cursor: pointer; display: flex; align-items: center; gap: 4px; user-select: none; }
.repos-toggle input { margin: 0; }
.repos-group { display: flex; flex-direction: column; gap: 8px; }
.repos-group-head { font-size: 11px; color: var(--fg-dim); border-bottom: 1px solid var(--border); padding-bottom: 2px; margin-top: 4px; }
.repos-group-head.active { color: var(--accent); border-bottom-color: var(--accent); }
.rc { border: 1px solid var(--border); border-radius: 6px; background: var(--bg-3); padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.rc-head { display: flex; align-items: center; gap: 8px; }
.rc-name { font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-wt { font-size: 10px; color: var(--warn); border: 1px solid var(--warn); border-radius: 3px; padding: 0 4px; white-space: nowrap; }
.rc-spacer { flex: 1; }
.rc-diffbtn { padding: 1px 8px; font-size: 11px; }
.rc-diffbtn.on { border-color: var(--accent); color: var(--accent); }
.rc-path { font-size: 10px; color: var(--fg-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.rc-dim { color: var(--fg-dim); font-size: 11px; }
.rc-sep { color: var(--border); }
.rc-branch { color: var(--accent); font-weight: bold; }
.rc-branch.rc-detached { color: var(--warn); }
.rc-up { display: inline-flex; gap: 6px; align-items: center; }
.rc-noup { color: var(--fg-dim); font-style: italic; }
.rc-ahead { color: var(--ok); }
.rc-behind { color: var(--warn); }
.rc-zero { color: var(--fg-dim); }
.rc-tag { font-size: 10px; border-radius: 3px; padding: 0 4px; border: 1px solid var(--border); }
.rc-notpushed { color: var(--warn); border-color: var(--warn); }
.rc-synced { color: var(--ok); border-color: var(--ok); }
.rc-dirty { color: var(--warn); }
.rc-link { background: none; border: none; padding: 0; color: var(--fg-dim); cursor: pointer; font-size: 11px; }
.rc-link:hover, .rc-link.on { color: var(--accent); }
.rc-log { border-top: 1px solid var(--border); padding-top: 4px; display: flex; flex-direction: column; gap: 2px; font-size: 11px; }
.rc-logline { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: baseline; }
.rc-sha { color: var(--accent); }
.rc-subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-when { color: var(--fg-dim); white-space: nowrap; }
.rc-err { color: var(--alarm); }
.rc-diffbar { display: flex; justify-content: flex-end; border-top: 1px solid var(--border); padding-top: 4px; }
.rc-loading { padding: 4px 0; }
.rc-empty { padding: 8px 0; line-height: 1.5; }
`;
