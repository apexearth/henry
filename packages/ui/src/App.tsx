import { useEffect } from "react";
import { Layout } from "./Layout";
import { resetLayout, showSession } from "./dock";
import type { Session } from "@henry/shared";
import { getState, railOrder, setActive, useStore } from "./ws";

export function App() {
  const connected = useStore((s) => s.connected);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const list = railOrder();
      let s: Session | undefined;
      // Cmd+N is reserved by Chrome on macOS (browser tab switch); Ctrl+N works there. Both are bound.
      if (/^[1-9]$/.test(e.key)) s = list[Number(e.key) - 1];
      // Cmd+↑/↓ step through the rail, wrapping. Ctrl+↑/↓ stay with the terminal.
      else if (e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && list.length) {
        const i = list.findIndex((x) => x.id === getState().activeSessionId);
        s = list[(i + (e.key === "ArrowUp" ? -1 : 1) + list.length) % list.length];
      }
      if (!s) return;
      e.preventDefault();
      setActive(s.id);
      showSession(s.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">henry</span>
        <span className={"conn" + (connected ? " on" : "")} title={connected ? "connected" : "reconnecting"}>●</span>
        <span style={{ flex: 1 }} />
        <button className="topbar-btn" onClick={resetLayout} title="back to rail | terminals | tools">reset layout</button>
      </div>
      <Layout />
    </div>
  );
}
