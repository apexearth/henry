// Milestone 4: feed of notable/alarm events with unread badge, linking to the tool call
// and the rule that fired. `events` is the raw feed (milestone 2 shows it here too).
import type { Flag, HenryEvent } from "@henry/shared";

export interface FlagsPanelProps {
  sessionId: string | null;
  flags: Flag[];
  events: HenryEvent[];
  onMarkRead: (ids: string[]) => void;
}

export function FlagsPanel({ sessionId, flags, events }: FlagsPanelProps) {
  return (
    <div className="placeholder">
      <div>flags panel coming in milestone 4 (raw event feed in milestone 2)</div>
      <div>session: {sessionId ?? "none"} · {flags.length} flags · {events.length} events</div>
    </div>
  );
}
