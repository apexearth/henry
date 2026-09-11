// The tool panels wired to the store, so the Dockview tabs and the phone's panel sheet
// show the same thing. The panels themselves stay pure: props in, no store.
import { FlagsPanel } from "./Flags";
import { HistoryPanel } from "./History";
import { PlaybookPanel } from "./Playbook";
import { UsagePanel } from "./Usage";
import { useHistory } from "../history";
import { markFlagsRead, requestPlaybook, useStore } from "../ws";

/** The active session's flags, and how many of them are unread (the dock tab's badge). */
export function useSessionFlags() {
  const active = useStore((s) => s.activeSessionId);
  const flags = useStore((s) => s.flags);
  const mine = flags.filter((f) => !active || f.sessionId === active);
  return { active, flags: mine, unread: mine.filter((f) => !f.read).length };
}

export function BoundFlags() {
  const { active, flags } = useSessionFlags();
  const events = useStore((s) => s.events);
  return <FlagsPanel sessionId={active} flags={flags} events={events} onMarkRead={markFlagsRead} />;
}

export function BoundPlaybook() {
  const active = useStore((s) => s.activeSessionId);
  const playbook = useStore((s) => s.playbook);
  return <PlaybookPanel sessionId={active} entries={playbook.filter((p) => p.sessionId === active)} onRefresh={() => requestPlaybook(active)} />;
}

export function BoundHistory() {
  const active = useStore((s) => s.activeSessionId);
  const { history, loading, refresh } = useHistory(active);
  return <HistoryPanel sessionId={active} history={history} loading={loading} onRefresh={refresh} />;
}

export function BoundUsage() {
  const active = useStore((s) => s.activeSessionId);
  const usage = useStore((s) => s.usage);
  return <UsagePanel sessionId={active} usage={usage} />;
}
