// Milestone 3: unified/split diff of a repo vs the session baseline.
export interface DiffViewProps {
  repoPath: string;
  baseline: string;
  diff: string;
}

export function DiffView({ repoPath, baseline, diff }: DiffViewProps) {
  return (
    <div className="placeholder">
      <div>diff viewer coming in milestone 3</div>
      <div>{repoPath} vs {baseline || "(no baseline)"}</div>
      <pre className="diff">{diff || "(empty)"}</pre>
    </div>
  );
}
