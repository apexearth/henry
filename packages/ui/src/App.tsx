import { useEffect, useState } from "react";
import { HenryMark } from "./HenryMark";
import { ThemeMenu } from "./ThemeMenu";
import { FilePicker } from "./FilePicker";
import { Layout } from "./Layout";
import { closePeek, getDockApi, isFilePanel, resetLayout, showSession, stageStep } from "./dock";
import type { Session } from "@henry/shared";
import { onMenu } from "./shell";
import { getState, railOrder, setActive, useStore } from "./ws";

export function App() {
  const connected = useStore((s) => s.connected);
  const [finder, setFinder] = useState(false);

  useEffect(() => onMenu("reset-layout", resetLayout), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey) {
        // Modals close themselves on Esc; consume the key so it does not reach the
        // native window, where macOS reads an unhandled Esc as "exit full screen".
        if (document.querySelector(".modal-bg, .dm-bg, .pop-bg")) {
          e.preventDefault();
          return;
        }
        // Otherwise Esc closes the file peek in view.
        const p = getDockApi()?.activePanel;
        if (p && isFilePanel(p.id)) {
          e.preventDefault();
          closePeek(p.id);
        }
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // ⌘K finds a file to peek at. ⌃K too, except in the terminal where it is kill-line.
      if ((e.key === "k" || e.key === "K") && !e.shiftKey && (e.metaKey || !(e.target as HTMLElement | null)?.closest?.(".xterm"))) {
        e.preventDefault();
        setFinder((v) => !v);
        return;
      }
      // Cmd+←/→ walk the stage: the session, then its peeks.
      if (e.metaKey && !e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        stageStep(e.key === "ArrowLeft" ? -1 : 1);
        return;
      }
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
        <HenryMark />
        <span className="brand">henry</span>
        <span className={"conn" + (connected ? " on" : "")} title={connected ? "connected" : "reconnecting"}>●</span>
        <span style={{ flex: 1 }} />
        <ThemeMenu />
        <button className="topbar-btn" onClick={resetLayout} title="back to rail | terminals | tools">reset layout</button>
      </div>
      <Layout />
      {finder && <FilePicker onClose={() => setFinder(false)} />}
    </div>
  );
}
