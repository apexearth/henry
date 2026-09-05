// Henry on a phone: one session filling the screen, everything else behind a menu.
//
// The desktop layout is a Dockview grid — a rail on the left, tools on the right, panels the
// user drags around. None of that survives a 390-pixel screen, and a phone is not where you
// arrange a workspace anyway. So the phone keeps the one thing you came for, the terminal, and
// puts the two rails behind buttons: ☰ opens the session rail as a drawer, ⋮ opens the tool
// panels as a sheet. The terminal is a screen you read (zoom it out until the columns fit) and
// the composer under it is what you type or talk at.
import { useEffect, useState } from "react";
import { isClaudeSession, type Session } from "@henry/shared";
import { Rail } from "../Rail";
import { TerminalView } from "../Terminal";
import { BoundFlags, BoundPlaybook, BoundRepos, BoundUsage, useSessionFlags } from "../panels/bound";
import { useAskTitle } from "../title";
import { answerAttention, useStore } from "../ws";
import { Composer } from "./Composer";
import { useFontSize, useViewportHeight } from "./useMobile";

const TABS = [
  { id: "repos", title: "repos", body: BoundRepos },
  { id: "flags", title: "flags", body: BoundFlags },
  { id: "playbook", title: "playbook", body: BoundPlaybook },
  { id: "usage", title: "usage", body: BoundUsage },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function Mobile() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const connected = useStore((s) => s.connected);
  const hydrated = useStore((s) => s.hydrated);
  const attention = useStore((s) => s.attention);
  const [drawer, setDrawer] = useState(false);
  const [tab, setTab] = useState<TabId | null>(null);
  const { fontSize, zoom } = useFontSize();
  const { unread } = useSessionFlags();
  useViewportHeight();
  useAskTitle();

  const session = sessions.find((s) => s.id === activeId);
  // Off the subscribed list, not asksFor's module-level default, so a new ask redraws the bar.
  const asks = session ? attention.filter((a) => a.sessionId === session.id) : [];
  // Picking a session in the drawer is the whole reason the drawer is open.
  useEffect(() => setDrawer(false), [activeId]);
  // With nothing to show, the rail is the screen rather than an empty stage behind a button.
  // Only once the first snapshot has landed: every window starts with an empty session list.
  useEffect(() => {
    if (hydrated && !sessions.length) setDrawer(true);
  }, [hydrated, sessions.length]);

  const waiting = sessions.filter((s) => s.status === "running" && (s.activity === "needsInput" || s.activity === "waiting")).length;

  return (
    <div className="m-app">
      <header className="m-top">
        <button className="m-icon" onClick={() => setDrawer(true)} title="sessions" aria-label="sessions">
          ☰{waiting > 0 && <span className="m-badge">{waiting}</span>}
        </button>
        <div className="m-title">
          <span className={"m-dot" + (connected ? "" : " off") + (session?.activity ? " act-" + session.activity : "")} />
          <span className="m-name">{session?.title ?? (sessions.length ? "pick a session" : "no sessions")}</span>
        </div>
        <button className="m-icon" onClick={() => zoom(-1)} title="smaller text, more columns" aria-label="zoom out">−</button>
        <span className="m-zoom" title="terminal text size">{fontSize}</span>
        <button className="m-icon" onClick={() => zoom(1)} title="bigger text, fewer columns" aria-label="zoom in">+</button>
        <button className="m-icon" onClick={() => setTab((t) => (t ? null : "repos"))} title="repos, flags, playbook, usage" aria-label="panels">
          ⋮{unread > 0 && <span className="m-badge alarm">{unread}</span>}
        </button>
      </header>

      {asks.length > 0 && (
        // The loudest thing Henry says, and on a phone it is the reason you picked it up.
        <button className="m-ask" onClick={() => answerAttention(asks.map((a) => a.id))}
          title="tap to tell the session you have seen it">
          ❗ {asks[0]!.message}
        </button>
      )}

      <main className="m-stage">
        {session ? (
          <TerminalView key={session.id} sessionId={session.id} visible={!drawer && !tab} focused={false} fontSize={fontSize} />
        ) : (
          <div className="empty">{sessions.length ? "pick a session from ☰" : "no sessions — open ☰ and start one"}</div>
        )}
      </main>

      {session && session.status === "running" ? (
        <Composer session={session} />
      ) : session ? (
        <div className="m-composer"><div className="m-note">this session has exited</div></div>
      ) : null}

      {drawer && (
        <>
          <div className="m-scrim" onClick={() => setDrawer(false)} />
          <div className="m-drawer">
            <div className="m-sheet-top">
              <span>sessions</span>
              <button className="m-icon" onClick={() => setDrawer(false)} aria-label="close">×</button>
            </div>
            <Rail />
          </div>
        </>
      )}

      {tab && <PanelSheet tab={tab} setTab={setTab} onClose={() => setTab(null)} session={session} />}
    </div>
  );
}

function PanelSheet({ tab, setTab, onClose, session }: { tab: TabId; setTab: (t: TabId) => void; onClose: () => void; session?: Session }) {
  const Body = TABS.find((t) => t.id === tab)!.body;
  return (
    <>
      <div className="m-scrim" onClick={onClose} />
      <div className="m-sheet">
        <div className="m-sheet-top">
          <span className="dim">{session ? `${isClaudeSession(session) ? "✦" : "$"} ${session.title}` : "no session"}</span>
          <button className="m-icon" onClick={onClose} aria-label="close">×</button>
        </div>
        <div className="m-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={"m-tab" + (t.id === tab ? " on" : "")} onClick={() => setTab(t.id)}>
              {t.title}
            </button>
          ))}
        </div>
        <div className="m-sheet-body">
          <Body />
        </div>
      </div>
    </>
  );
}
