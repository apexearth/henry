// Milestone 5: overseer log for this session, newest first, with a "right now" summary on top.
import type { PlaybookEntry } from "@henry/shared";

export interface PlaybookPanelProps {
  sessionId: string | null;
  entries: PlaybookEntry[];
  onRefresh: () => void;
}

export function PlaybookPanel({ sessionId, entries }: PlaybookPanelProps) {
  return (
    <div className="placeholder">
      <div>playbook panel coming in milestone 5</div>
      <div>session: {sessionId ?? "none"} · {entries.length} entries</div>
    </div>
  );
}
