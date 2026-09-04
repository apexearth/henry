import { useEffect, useState } from "react";
import { HenryMark } from "./HenryMark";
import { ThemeMenu } from "./ThemeMenu";
import { RemotesMenu } from "./RemotesMenu";
import { FilePicker } from "./FilePicker";
import { Layout } from "./Layout";
import { Setup } from "./Setup";
import { Keys } from "./Keys";
import { closePeek, getDockApi, isFilePanel, resetLayout, showSession, stageStep } from "./dock";
import { onMenu } from "./shell";
import { activeRowIndex, railRows, setActive, useStore, type RailRow } from "./ws";

export function App() {
  const connected = useStore((s) => s.connected);
  const firstRun = useStore((s) => s.hydrated && s.firstRun);
  const reposRoot = useStore((s) => s.config?.reposRoot);
  const [finder, setFinder] = useState(false);
  const [setup, setSetup] = useState(false);
  const [keys, setKeys] = useState(false);

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
      // ⌘/ lists the shortcuts.
      if (e.metaKey && !e.ctrlKey && e.key === "/") {
        e.preventDefault();
        setKeys((v) => !v);
        return;
      }
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
      const rows = railRows();
      let r: RailRow | undefined;
      // Cmd+N is reserved by Chrome on macOS (browser tab switch); Ctrl+N works there. Both are bound.
      if (/^[1-9]$/.test(e.key)) r = rows[Number(e.key) - 1];
      // Cmd+↑/↓ step through the rail's rows, wrapping, from the row you are on (a session
      // listed under several repos is several rows). Ctrl+↑/↓ stay with the terminal.
      else if (e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && rows.length) {
        const i = activeRowIndex();
        r = rows[(i + (e.key === "ArrowUp" ? -1 : 1) + rows.length) % rows.length];
      }
      if (!r) return;
      e.preventDefault();
      setActive(r.session.id, r.group);
      showSession(r.session.id);
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
        {reposRoot && (
          <button className="topbar-btn" onClick={() => setSetup(true)} title="the folder holding all your repos; click to change">
            repos {reposRoot}
          </button>
        )}
        <RemotesMenu />
        <ThemeMenu />
        <button className="topbar-btn" onClick={() => setKeys(true)} title="keyboard shortcuts (⌘/)">keys</button>
        <button className="topbar-btn" onClick={resetLayout} title="back to rail | terminals | tools">reset layout</button>
      </div>
      <Layout />
      {finder && <FilePicker onClose={() => setFinder(false)} />}
      {keys && <Keys onClose={() => setKeys(false)} />}
      {firstRun ? <Setup /> : setup && <Setup onClose={() => setSetup(false)} />}
    </div>
  );
}
