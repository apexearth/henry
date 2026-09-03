// Milestone 2: 5h / 7d utilization bars with reset times; per-session token and cost totals.
import type { Usage } from "@henry/shared";

export interface UsagePanelProps {
  sessionId: string | null;
  usage: Usage;
}

export function UsagePanel({ sessionId, usage }: UsagePanelProps) {
  return (
    <div className="placeholder">
      <div>usage panel coming in milestone 2</div>
      <div>session: {sessionId ?? "none"} · updated {usage.updatedAt ? new Date(usage.updatedAt).toLocaleTimeString() : "never"}</div>
    </div>
  );
}
