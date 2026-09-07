// The conversation behind a Claude session, read from the daemon (GET /api/history).
//
// Claude Code's TUI holds the alternate screen for the whole session, and a terminal on the
// alternate screen has no scrollback: there is nothing above the frame for the window to scroll
// back into. The turns still exist in the transcript, so the History panel reads them from there.
import { useEffect, useState } from "react";
import type { History } from "@henry/shared";
import { useStore } from "./ws";

export async function fetchHistory(sessionId: string): Promise<History> {
  const r = await fetch(`/api/history?sessionId=${encodeURIComponent(sessionId)}`);
  if (!r.ok) return { sessionId, turns: [], complete: true, reason: `daemon answered ${r.status}` };
  return (await r.json()) as History;
}

/**
 * One session's turns, refetched whenever its usage row changes — the transcript tailer updates
 * that on every assistant message, which is as close to "a turn landed" as the window can see
 * without a second stream. `nudge` refetches on demand (the panel's refresh).
 */
export function useHistory(sessionId: string | null): { history?: History; loading: boolean; refresh: () => void } {
  const usage = useStore((s) => (sessionId ? s.usage.perSession[sessionId] : undefined));
  const activity = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.activity);
  const [history, setHistory] = useState<History>();
  const [loading, setLoading] = useState(false);
  const [nudge, setNudge] = useState(0);
  useEffect(() => {
    if (!sessionId) return setHistory(undefined);
    let on = true;
    setLoading(true);
    fetchHistory(sessionId)
      .then((h) => on && setHistory(h))
      .finally(() => on && setLoading(false));
    return () => {
      on = false;
    };
  }, [sessionId, usage, activity, nudge]);
  return {
    history: history && history.sessionId === sessionId ? history : undefined,
    loading,
    refresh: () => setNudge((n) => n + 1),
  };
}
