import { useEffect, useState } from "react";
import { Rail } from "./Rail";
import { TerminalView } from "./Terminal";
import { ReposPanel } from "./panels/Repos";
import { FlagsPanel } from "./panels/Flags";
import { PlaybookPanel } from "./panels/Playbook";
import { UsagePanel } from "./panels/Usage";
import { getState, markFlagsRead, requestDiff, requestPlaybook, setActive, useStore } from "./ws";

type Tab = "repos" | "flags" | "playbook" | "usage";

export function App() {
  const sessions = useStore((s) => s.sessions);
  const active = useStore((s) => s.activeSessionId);
  const repos = useStore((s) => s.repos);
  const flags = useStore((s) => s.flags);
  const events = useStore((s) => s.events);
  const playbook = useStore((s) => s.playbook);
  const usage = useStore((s) => s.usage);
  const diffs = useStore((s) => s.diffs);
  const [tab, setTab] = useState<Tab>("repos");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd+N is reserved by Chrome on macOS (browser tab switch); Ctrl+N works there. Both are bound.
      if (!(e.metaKey || e.ctrlKey) || e.altKey || !/^[1-9]$/.test(e.key)) return;
      const s = getState().sessions[Number(e.key) - 1];
      if (!s) return;
      e.preventDefault();
      setActive(s.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const unread = flags.filter((f) => !f.read && (!active || f.sessionId === active)).length;
  const sessionFlags = flags.filter((f) => !active || f.sessionId === active);
  const sessionPlaybook = playbook.filter((p) => p.sessionId === active);

  return (
    <div className="app">
      <Rail />
      <div className="center">
        {sessions.map((s) => (
          <TerminalView key={s.id} sessionId={s.id} active={s.id === active} />
        ))}
        {!sessions.length && <div className="empty">no sessions — press “+ new”</div>}
      </div>
      <div className="panel">
        <div className="tabs">
          {(["repos", "flags", "playbook", "usage"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
              {t === "flags" && unread > 0 ? ` (${unread})` : ""}
            </button>
          ))}
        </div>
        <div className="panel-body">
          {tab === "repos" && (
            <ReposPanel sessionId={active} repos={active ? repos[active] ?? [] : []} diffs={diffs}
              onRequestDiff={(repoPath) => active && requestDiff(active, repoPath)} />
          )}
          {tab === "flags" && <FlagsPanel sessionId={active} flags={sessionFlags} events={events} onMarkRead={markFlagsRead} />}
          {tab === "playbook" && <PlaybookPanel sessionId={active} entries={sessionPlaybook} onRefresh={() => requestPlaybook(active)} />}
          {tab === "usage" && <UsagePanel sessionId={active} usage={usage} />}
        </div>
      </div>
    </div>
  );
}
