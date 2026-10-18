// A session in a window of its own (popout.ts): a one-line bar and the terminal, nothing else.
// The rail, tools and notices stay with the main window; this one only says it is here, so the
// main window keeps its hands off the PTY until it closes.
import { useEffect } from "react";
import { baseName } from "./platform";
import { announcePopout } from "./popout";
import { ContextSky } from "./ContextSky";
import { TerminalView } from "./Terminal";
import { useStore } from "./ws";

const ACTIVITY_TEXT = { working: "working", needsInput: "needs your answer", background: "waiting on its background work", waiting: "your move", idle: "idle" } as const;

export function Solo({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId));
  const hydrated = useStore((s) => s.hydrated);
  const connected = useStore((s) => s.connected);
  const ask = useStore((s) => s.attention.find((a) => a.sessionId === sessionId));

  useEffect(() => announcePopout(sessionId), []);
  useEffect(() => {
    document.title = session ? `${ask ? "❗ " : ""}${session.title}${session.peer ? ` · ${session.peer}` : ""} — Henry` : "Henry";
  }, [session?.title, session?.peer, ask]);

  const on = session?.status === "running";
  const act = on ? session?.activity : undefined;
  return (
    <div className="app">
      <div className="topbar solo-bar">
        <span className={"m-dot" + (connected && on ? "" : " off") + (act ? " act-" + act : "")} />
        <span className="brand">{session?.title ?? (hydrated ? "session not found" : "…")}</span>
        {session && <span className="dim">{baseName(session.cwd)}{session.peer ? ` · ${session.peer}` : ""}</span>}
        <span className="dim">{on ? (act ? ACTIVITY_TEXT[act] : "") : session ? "exited" : ""}</span>
        {ask && <span className="solo-ask" title="the session asked for you; answer it from the main window's rail or by typing here">❗ {ask.message}</span>}
        <span style={{ flex: 1 }} />
        <button className="topbar-btn" onClick={() => window.close()} title="close this window; the session goes back to a tab in the main window and keeps running">back to the main window</button>
      </div>
      <div className="term-host solo-stage">
        {session && (
          <>
            <ContextSky sessionId={sessionId} />
            <TerminalView sessionId={sessionId} visible focused />
          </>
        )}
      </div>
    </div>
  );
}
