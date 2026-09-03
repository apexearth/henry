// Milestone 3: per-repo cards (branch, ahead/behind, upstream, commits since baseline,
// dirty count, worktree path); click -> DiffView.
import type { RepoState } from "@henry/shared";

export interface ReposPanelProps {
  sessionId: string | null;
  repos: RepoState[];
  diffs: Record<string, { diff: string; baseline: string }>;
  onRequestDiff: (repoPath: string) => void;
}

export function ReposPanel({ sessionId, repos }: ReposPanelProps) {
  return (
    <div className="placeholder">
      <div>repos panel coming in milestone 3</div>
      <div>session: {sessionId ?? "none"} · {repos.length} repos</div>
    </div>
  );
}
