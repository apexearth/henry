// The dockable workspace. Every view (rail, each terminal, each tool) is a Dockview panel the
// user can drag into tabs, splits, edges or floating windows. Layout is saved to localStorage.
import { useEffect, useRef, useState } from "react";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps, type IWatermarkPanelProps } from "dockview-react";
import { Rail } from "./Rail";
import { TerminalView } from "./Terminal";
import { FileView } from "./FileView";
import { BoundFlags, BoundPlaybook, BoundRepos, BoundUsage, useSessionFlags } from "./panels/bound";
import { setActive, useStore } from "./ws";
import { buildDefaultLayout, ensureSessionPanel, henryTheme, isFilePanel, isTerminalGroup, loadLayout, noteActivePanel, saveLayout, sessionTitle, setDockApi, styleTerminalGroup, TERM_PREFIX, termPanelId } from "./dock";

function TerminalPanel({ api, params }: IDockviewPanelProps<{ sessionId: string }>) {
  const [visible, setVisible] = useState(api.isVisible);
  const [active, setPanelActive] = useState(api.isActive);
  useEffect(() => {
    const d1 = api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    const d2 = api.onDidActiveChange((e) => setPanelActive(e.isActive));
    return () => {
      d1.dispose();
      d2.dispose();
    };
  }, [api]);
  return (
    <div className="term-host">
      <TerminalView sessionId={params.sessionId} visible={visible} focused={visible && active} />
    </div>
  );
}

function FilePanel({ api, params }: IDockviewPanelProps<{ path: string; line?: number }>) {
  const [active, setPanelActive] = useState(api.isActive);
  useEffect(() => {
    const d = api.onDidActiveChange((e) => setPanelActive(e.isActive));
    return () => d.dispose();
  }, [api]);
  return <FileView path={params.path} line={params.line} active={active} />;
}

function SessionsPanel() {
  return <Rail />;
}

function ReposDock() {
  return <div className="dock-body"><BoundRepos /></div>;
}

function FlagsDock({ api }: IDockviewPanelProps) {
  const { unread } = useSessionFlags();
  useEffect(() => {
    api.setTitle(unread ? `Flags (${unread})` : "Flags");
  }, [api, unread]);
  return <div className="dock-body"><BoundFlags /></div>;
}

function PlaybookDock() {
  return <div className="dock-body"><BoundPlaybook /></div>;
}

function UsageDock() {
  return <div className="dock-body"><BoundUsage /></div>;
}

/** While a sash is being dragged, every group shows its size in pixels at its centre. */
function SizeOverlay({ api }: { api: DockviewApi }) {
  const [boxes, setBoxes] = useState<{ id: string; r: DOMRect }[] | null>(null);
  useEffect(() => {
    let raf = 0;
    const measure = () => setBoxes(api.groups.map((g) => ({ id: g.id, r: g.element.getBoundingClientRect() })));
    const move = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    const end = () => {
      cancelAnimationFrame(raf);
      setBoxes(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    const down = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(".dv-sash")) return;
      measure();
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    };
    window.addEventListener("pointerdown", down, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      end();
    };
  }, [api]);
  if (!boxes) return null;
  return (
    <>
      {boxes.map((b) => (
        <div key={b.id} className="size-badge" style={{ left: b.r.left + b.r.width / 2, top: b.r.top + b.r.height / 2 }}>
          {Math.round(b.r.width)} × {Math.round(b.r.height)}
        </div>
      ))}
    </>
  );
}

function Watermark({ group }: IWatermarkPanelProps) {
  const sessions = useStore((s) => s.sessions);
  const msg = group && !sessions.length ? "no sessions — press “+ new”" : "empty — pick a session in the rail, or drag a tool tab here";
  return <div className="empty">{msg}</div>;
}

const components = {
  terminal: TerminalPanel,
  file: FilePanel,
  sessions: SessionsPanel,
  repos: ReposDock,
  flags: FlagsDock,
  playbook: PlaybookDock,
  usage: UsageDock,
};

export function Layout() {
  const [api, setApi] = useState<DockviewApi | null>(null);
  const hydrated = useStore((s) => s.hydrated);
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const restored = useRef(false);

  const onReady = (e: DockviewReadyEvent) => {
    setDockApi(e.api);
    setApi(e.api);
  };

  // Restore (or build) the layout once sessions are known, so restored terminal tabs can be pruned.
  useEffect(() => {
    if (!api || !hydrated || restored.current) return;
    restored.current = true;
    const saved = loadLayout();
    let ok = false;
    if (saved) {
      try {
        api.fromJSON(saved);
        ok = true;
      } catch (err) {
        console.warn("[henry] saved layout unusable, rebuilding", err);
      }
    }
    if (!ok) buildDefaultLayout();
    const live = new Set(sessions.map((s) => s.id));
    for (const p of api.panels) {
      // Peeks are for the moment; they don't come back with the layout.
      if (isFilePanel(p.id) || (p.id.startsWith(TERM_PREFIX) && !live.has(p.id.slice(TERM_PREFIX.length)))) api.removePanel(p);
    }
    for (const s of sessions) ensureSessionPanel(s);
    // Header visibility isn't serialized; re-apply it to every restored terminal group.
    for (const g of api.groups) if (isTerminalGroup(g)) styleTerminalGroup(g);
    if (activeId) api.getPanel(termPanelId(activeId))?.api.setActive();
    saveLayout();
  }, [api, hydrated]);

  // Persist on every change, debounced; dock → store for the active session.
  useEffect(() => {
    if (!api) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const d1 = api.onDidLayoutChange(() => {
      if (!restored.current) return;
      clearTimeout(timer);
      timer = setTimeout(saveLayout, 300);
    });
    const d2 = api.onDidActivePanelChange((e) => {
      if (!e.panel) return;
      noteActivePanel(e.panel);
      if (e.panel.id.startsWith(TERM_PREFIX)) setActive(e.panel.id.slice(TERM_PREFIX.length));
    });
    return () => {
      clearTimeout(timer);
      d1.dispose();
      d2.dispose();
    };
  }, [api]);

  // Sessions come and go: new ones get a tab, killed ones lose theirs, titles track status.
  const known = useRef(new Set<string>());
  useEffect(() => {
    if (!api || !restored.current) return;
    const live = new Set(sessions.map((s) => s.id));
    for (const p of api.panels) {
      if (p.id.startsWith(TERM_PREFIX) && !live.has(p.id.slice(TERM_PREFIX.length))) api.removePanel(p);
    }
    for (const s of sessions) {
      const p = api.getPanel(termPanelId(s.id));
      if (p) {
        const t = sessionTitle(s);
        if (p.api.title !== t) p.api.setTitle(t);
      } else if (!known.current.has(s.id)) {
        ensureSessionPanel(s, s.id === activeId);
      }
      known.current.add(s.id);
    }
  }, [api, sessions, hydrated]);

  // Store → dock: rail clicks and ⌘N bring the session's tab forward.
  useEffect(() => {
    if (!api || !activeId) return;
    const p = api.getPanel(termPanelId(activeId));
    if (p && !p.api.isActive) p.api.setActive();
  }, [api, activeId]);

  return (
    <>
      <DockviewReact
        className="dock"
        theme={henryTheme}
        components={components}
        watermarkComponent={Watermark}
        noPanelsOverlay="emptyGroup"
        onReady={onReady}
      />
      {api && <SizeOverlay api={api} />}
    </>
  );
}
