// The four tool panels wired to the store, so the Dockview tabs and the phone's panel sheet
// show the same thing. The panels themselves stay pure: props in, no store.
import { ReposPanel } from "./Repos";
import { FlagsPanel } from "./Flags";
import { PlaybookPanel } from "./Playbook";
import { UsagePanel } from "./Usage";
import { markFlagsRead, requestDiff, requestPlaybook, useStore } from "../ws";

export function BoundRepos() {
  const active = useStore((s) => s.activeSessionId);
  const repos = useStore((s) => s.repos);
  const diffs = useStore((s) => s.diffs);
  return (
    <ReposPanel sessionId={active} repos={active ? repos[active] ?? [] : []} diffs={diffs}
      onRequestDiff={(repoPath) => active && requestDiff(active, repoPath)} />
  );
}

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

export function BoundUsage() {
  const active = useStore((s) => s.activeSessionId);
  const usage = useStore((s) => s.usage);
  return <UsagePanel sessionId={active} usage={usage} />;
}
