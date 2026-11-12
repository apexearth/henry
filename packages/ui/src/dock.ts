// Layout state for the dockable UI: the Dockview API singleton, the default arrangement,
// localStorage persistence, and the "show this session" helper the rail uses.
import type { DockviewApi, DockviewGroupPanel, DockviewTheme, IDockviewPanel, SerializedDockview } from "dockview-react";
import type { Session } from "@henry/shared";
import { isClaudeSession } from "@henry/shared";
import { baseName } from "./platform";
import { themeDocument } from "./theme";
import { focusPopout, isPoppedOut, popOut, watchPopouts } from "./popout";
import { getState } from "./ws";

export type ToolId = "sessions" | "files" | "history" | "flags" | "playbook" | "usage" | "changes";
export const TOOLS: { id: ToolId; title: string }[] = [
  { id: "sessions", title: "Sessions" },
  { id: "files", title: "Files" },
  { id: "history", title: "History" },
  { id: "flags", title: "Flags" },
  { id: "playbook", title: "Playbook" },
  { id: "usage", title: "Usage" },
  { id: "changes", title: "Changes" },
];
/** Panes of their own under the tool tabs rather than more tabs. */
const STACKED: ToolId[] = ["changes"];
/** A pane that is gone from the dock (voice moved into the status strip). Its component stays
 *  registered as nothing so a saved layout naming it still restores; the pane is then removed. */
const RETIRED = ["voice"];

// v3 put the usage gauges in the status strip and made Usage a tab again; v4 added a Voice pane
// under the tools; v5 the Changes pane, and voice has since left for the status strip. An older
// layout is still read, and gains Changes once on the way in — one-shot, because a panel the
// user then closes must stay closed.
const STORAGE_KEY = "henry.layout.v5";
const LEGACY_KEYS = ["henry.layout.v4", "henry.layout.v3"];
export const TERM_PREFIX = "term:";
export const termPanelId = (sessionId: string) => TERM_PREFIX + sessionId;
export const FILE_PREFIX = "file:";
export const filePanelId = (path: string) => FILE_PREFIX + path;
export const isFilePanel = (id: string) => id.startsWith(FILE_PREFIX);

// Variables live in styles.css under this class; dockview only needs the name and drag behaviour.
export const henryTheme: DockviewTheme = {
  name: "henry",
  className: "dockview-theme-henry",
  colorScheme: "dark",
  dndOverlayMounting: "absolute",
  dndPanelOverlay: "group",
};

let api: DockviewApi | null = null;
export function setDockApi(a: DockviewApi | null) {
  api = a;
}
export function getDockApi() {
  return api;
}

/** The centre is a stage, not a tab strip: the rail picks the session, so terminal groups hide
 *  their header. Locked keeps tools from being dropped in; they still dock around its edges. */
export function styleTerminalGroup(g: DockviewGroupPanel) {
  g.header.hidden = true;
  g.locked = true;
}
export function isTerminalGroup(g: DockviewGroupPanel) {
  return g.id === "center" || g.panels.some((p) => p.id.startsWith(TERM_PREFIX) || isFilePanel(p.id));
}

export function sessionTitle(s: Session): string {
  const glyph = isClaudeSession(s) ? "✦" : "$";
  return `${glyph} ${s.title}${s.status === "exited" ? " (exited)" : ""}`;
}

/** True once a v2 layout was read; its usage pane gets folded into the tabs after restore. */
let fromLegacy = false;

export function loadLayout(): SerializedDockview | null {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    for (const key of LEGACY_KEYS) {
      if (raw) break;
      raw = localStorage.getItem(key);
      fromLegacy = !!raw;
    }
    if (!raw) return null;
    const saved = JSON.parse(raw) as SerializedDockview;
    // For a while the left panel's tab was a Sessions/Files switch; that tab component is gone.
    const left = saved.panels?.sessions as { tabComponent?: string } | undefined;
    if (left) delete left.tabComponent;
    // The Repos tab became the Files tool. Renamed in place, so the tab keeps its slot.
    renamePanel(saved, "repos", "files");
    for (const id of RETIRED) dropPanel(saved, id);
    // Only peeks pop out, and peeks don't come back; restoring one would open an empty window.
    delete saved.popoutGroups;
    return saved;
  } catch {
    return null;
  }
}

/** Rename a panel throughout a saved layout: its entry, and every group listing it. */
function renamePanel(saved: SerializedDockview, from: string, to: string) {
  const entry = saved.panels?.[from];
  if (!entry || saved.panels[to]) return;
  delete saved.panels[from];
  saved.panels[to] = { ...entry, id: to, contentComponent: to, title: TOOLS.find((t) => t.id === to)?.title ?? to };
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const o = node as { views?: string[]; activeView?: string };
    if (Array.isArray(o.views)) o.views = o.views.map((v) => (v === from ? to : v));
    if (o.activeView === from) o.activeView = to;
    for (const v of Object.values(o)) walk(v);
  };
  walk(saved.grid);
  walk(saved.floatingGroups);
  walk(saved.popoutGroups);
}

type GridNode = { type: "leaf" | "branch"; data: unknown; size?: number };
type LeafData = { views: string[]; activeView?: string };

/** Take a panel out of a saved layout before Dockview reads it. A group it leaves empty goes
 *  too, and hands its size to a neighbour so the rest keep their proportions. */
function dropPanel(saved: SerializedDockview, id: string) {
  if (!saved.panels?.[id]) return;
  delete saved.panels[id];
  const prune = (node: GridNode): boolean => {
    if (node.type === "leaf") {
      const leaf = node.data as LeafData;
      leaf.views = leaf.views.filter((v) => v !== id);
      if (leaf.activeView === id) leaf.activeView = leaf.views[0];
      return leaf.views.length > 0;
    }
    const kids = node.data as GridNode[];
    for (let i = kids.length - 1; i >= 0; i--) {
      if (prune(kids[i]!)) continue;
      const gone = kids.splice(i, 1)[0]!;
      const heir = kids[i - 1] ?? kids[i];
      if (heir && heir.size !== undefined && gone.size !== undefined) heir.size += gone.size;
    }
    return kids.length > 0;
  };
  const root = (saved.grid as { root?: GridNode } | undefined)?.root;
  if (root) prune(root);
  if (saved.floatingGroups) {
    saved.floatingGroups = saved.floatingGroups.filter((g) => {
      const d = g.data as unknown as LeafData;
      d.views = d.views.filter((v) => v !== id);
      if (d.activeView === id) d.activeView = d.views[0];
      return d.views.length > 0;
    });
  }
}

export function saveLayout() {
  if (!api) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(api.toJSON()));
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  } catch {
    /* quota or private mode: layout just won't persist */
  }
}

/** A restored older layout predates the Changes pane; give it one, once. A pane the user
 * closes afterwards stays closed. (Retired panes were dropped in loadLayout.) */
export function migrateRestoredLayout() {
  if (!api || !fromLegacy) return;
  fromLegacy = false;
  const sibling = siblingTool(...STACKED);
  if (!api.getPanel("changes") && sibling) addStacked("changes", sibling);
  applyStackSizes();
}

/** The first tool panel that is actually in the layout, for positioning another beside it. */
function siblingTool(...except: ToolId[]): ToolId | undefined {
  return TOOLS.map((t) => t.id).find((t) => t !== "sessions" && !except.includes(t) && api!.getPanel(t));
}

/** Changes gets a pane of its own under the tools rather than another tab: you glance at what
 * the last prompt touched while looking at something else. */
function addStacked(id: ToolId, reference: string, direction: "above" | "below" = "below") {
  const title = TOOLS.find((t) => t.id === id)?.title ?? id;
  api?.addPanel({ id, component: id, title, position: { referencePanel: reference, direction } });
}

/** Changes takes a short list. Needs a measured grid. */
function applyStackSizes() {
  requestAnimationFrame(() => api?.getPanel("changes")?.api.setSize({ height: 240 }));
}

/** rail | terminals | tool tabs; the pre-dock arrangement. */
export function buildDefaultLayout() {
  if (!api) return;
  api.clear();
  api.addPanel({ id: "sessions", component: "sessions", title: "Sessions" });
  api.addPanel({ id: "files", component: "files", title: "Files", position: { referencePanel: "sessions", direction: "right" } });
  for (const t of TOOLS.slice(2)) {
    if (STACKED.includes(t.id)) continue;
    api.addPanel({ id: t.id, component: t.id, title: t.title, position: { referencePanel: "files", direction: "within" }, inactive: true });
  }
  addStacked("changes", "files");
  // The centre group exists even with no sessions, so the rail and tools keep their widths.
  styleTerminalGroup(api.addGroup({ id: "center", referencePanel: "files", direction: "left" }));
  for (const s of getState().sessions) ensureSessionPanel(s);
  api.getPanel("files")?.api.setActive();
  applyDefaultSizes();
}

/** Rail and tools are fixed-width columns; terminals take the rest. Needs a measured grid. */
function applyDefaultSizes() {
  requestAnimationFrame(() => {
    api?.getPanel("sessions")?.api.setSize({ width: 220 });
    api?.getPanel("files")?.api.setSize({ width: 360 });
  });
  applyStackSizes();
}

export function resetLayout() {
  localStorage.removeItem(STORAGE_KEY);
  buildDefaultLayout();
  saveLayout();
}

/** Where a terminal goes when no terminal group exists: between the rail and the tools. */
function terminalHome(): { referencePanel: string; direction: "left" | "right" } | { direction: "right" } {
  if (!api) return { direction: "right" };
  for (const t of TOOLS.slice(1)) if (api.getPanel(t.id)) return { referencePanel: t.id, direction: "left" };
  if (api.getPanel("sessions")) return { referencePanel: "sessions", direction: "right" };
  return { direction: "right" };
}

export function ensureSessionPanel(s: Session, activate = false) {
  // Out in its own window (popout.ts): one window per PTY, or they fight over its size.
  if (!api || isPoppedOut(s.id)) return;
  const id = termPanelId(s.id);
  const existing = api.getPanel(id);
  if (existing) {
    if (activate) existing.api.setActive();
    return existing;
  }
  const sibling = api.panels.find((p) => p.id.startsWith(TERM_PREFIX) && p.api.isActive) ?? api.panels.find((p) => p.id.startsWith(TERM_PREFIX));
  const empty = api.groups.find((g) => g.panels.length === 0 && g.api.location.type === "grid");
  // An empty pane (the centre placeholder, or a split whose last tab was closed) is filled first.
  const position = empty
    ? { referenceGroup: empty.id, direction: "within" as const }
    : sibling
      ? { referencePanel: sibling.id, direction: "within" as const }
      : terminalHome();
  const panel = api.addPanel({ id, component: "terminal", title: sessionTitle(s), params: { sessionId: s.id }, position, inactive: !activate });
  styleTerminalGroup(panel.group);
  if (!sibling && !empty) applyDefaultSizes();
  return panel;
}

/** Rail click / ⌘N: make sure the session has a tab and bring it forward. */
export function showSession(sessionId: string) {
  if (isPoppedOut(sessionId)) return focusPopout(sessionId);
  const s = getState().sessions.find((x) => x.id === sessionId);
  if (s) ensureSessionPanel(s, true);
}

/** Move a session's terminal out of the dock into a window of its own. */
export function popOutSession(sessionId: string) {
  if (isPoppedOut(sessionId)) return focusPopout(sessionId);
  popOut(sessionId);
  const p = api?.getPanel(termPanelId(sessionId));
  if (p) api!.removePanel(p);
}

/** The main window's half of popout.ts: drop the tabs of sessions that are out (another window
 * may have popped them, or this one before it reloaded), and give a tab back when one returns. */
export function startPopouts() {
  watchPopouts((id) => {
    const s = getState().sessions.find((x) => x.id === id);
    if (s) ensureSessionPanel(s, getState().activeSessionId === id);
  });
}

/** A tab for a session that is out, restored with the layout or added before the window said so. */
export function dropPoppedPanels() {
  for (const p of api?.panels ?? []) {
    if (p.id.startsWith(TERM_PREFIX) && isPoppedOut(p.id.slice(TERM_PREFIX.length))) api!.removePanel(p);
  }
}

/** Topbar chips and the status strip: bring a tool forward, re-adding it if its tab is gone. */
export function showTool(id: ToolId) {
  if (!api) return;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const title = TOOLS.find((t) => t.id === id)?.title ?? id;
  const sibling = TOOLS.map((t) => t.id).find((t) => t !== id && api!.getPanel(t));
  api.addPanel({ id, component: id, title, position: sibling ? { referencePanel: sibling, direction: "within" } : { direction: "right" } });
}


// ---- file peeks ----
// A peek is a file panel in the stage (terminal) group, to the right of the session. The
// session sits at position 0 of the strip; ⌘←/→ walk it, Esc closes the peek in view.

/** Last terminal shown in each stage group: where closing the last peek lands. */
const lastTerm = new Map<string, string>();
export function noteActivePanel(p: IDockviewPanel) {
  if (p.id.startsWith(TERM_PREFIX)) lastTerm.set(p.group.id, p.id);
}

/** The active session's group, else any terminal group. */
function stageGroup(): DockviewGroupPanel | undefined {
  if (!api) return;
  const active = getState().activeSessionId;
  const p = active ? api.getPanel(termPanelId(active)) : undefined;
  return p?.group ?? api.groups.find(isTerminalGroup);
}

function stageStrip(g: DockviewGroupPanel): IDockviewPanel[] {
  const term = g.panels.find((p) => p.id === lastTerm.get(g.id)) ?? g.panels.find((p) => p.id.startsWith(TERM_PREFIX));
  return [...(term ? [term] : []), ...g.panels.filter((p) => isFilePanel(p.id))];
}

/** Where a peek goes when there is no dock: the phone layout shows it as a sheet. `null` closes. */
let peekSink: ((peek: { path: string; line?: number } | null) => void) | null = null;
export function setPeekSink(fn: typeof peekSink): () => void {
  peekSink = fn;
  return () => {
    if (peekSink === fn) peekSink = null;
  };
}

/** Peeks open in the editor. They survive the next peek replacing the others. */
const held = new Set<string>();
export function holdPeek(path: string, hold: boolean) {
  if (hold) held.add(filePanelId(path));
  else held.delete(filePanelId(path));
}

/** One peek at a time: a new one replaces the ones already in the stage, except those held. */
export function peekFile(path: string, line?: number) {
  if (!api) return void peekSink?.({ path, line });
  const g = stageGroup();
  if (!g) return;
  const id = filePanelId(path);
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.updateParameters({ path, line });
    existing.api.setActive();
  } else {
    api.addPanel({ id, component: "file", title: baseName(path), params: { path, line }, position: { referenceGroup: g.id, direction: "within" } });
  }
  for (const p of [...g.panels]) if (p.id !== id && isFilePanel(p.id) && !held.has(p.id)) api.removePanel(p);
}

export function closePeek(id?: string) {
  if (!api) return void peekSink?.(null);
  const p = id ? api.getPanel(id) : api.activePanel;
  if (!p || !isFilePanel(p.id)) return;
  const g = p.group;
  api.removePanel(p);
  // Last peek gone: back to the session that was showing, not whichever tab Dockview picks.
  if (!g.panels.some((x) => isFilePanel(x.id))) stageStrip(g)[0]?.api.setActive();
}

/** A peek in a window of its own (dockview's popout: the panel moves, state stays shared).
 *  Closing that window closes the peek rather than putting it back in the stage. */
export function popoutPeek(path: string) {
  const p = api?.getPanel(filePanelId(path));
  if (!api || !p || p.api.location.type === "popout") return;
  let unTheme = () => {};
  void api.addPopoutGroup(p, {
    popoutUrl: "/popout.html",
    onDidOpen: ({ window: w }) => w.addEventListener("load", () => (unTheme = themeDocument(w.document)), { once: true }),
    onWillClose: () => {
      unTheme();
      const ids = p.group.panels.map((x) => x.id).filter(isFilePanel);
      setTimeout(() => ids.forEach((id) => api?.getPanel(id) && api.removePanel(api.getPanel(id)!)), 0);
    },
  });
}

/** Where the keyboard was when a picker opened, so closing it puts you back in the terminal. */
export function focusOrigin(): Element | null {
  return document.activeElement;
}

/**
 * Put the keyboard back after a picker closes: where it was if that was in the stage, else on
 * the terminal or peek in view. Modals steal focus and Dockview does not hand it back on its own.
 */
export function restoreFocus(origin: Element | null) {
  if (origin instanceof HTMLElement && origin.isConnected && origin.closest(".term, .peek")) return origin.focus();
  const g = stageGroup();
  if (!g) return;
  const candidates = g.element.querySelectorAll<HTMLElement>(".xterm-helper-textarea, .peek-body");
  for (const el of candidates) {
    if (el.offsetParent !== null) return el.focus();
  }
}

export function stageStep(dir: -1 | 1) {
  const g = stageGroup();
  if (!g) return;
  const strip = stageStrip(g);
  const i = strip.findIndex((p) => p === g.activePanel);
  strip[Math.max(0, i) + dir]?.api.setActive();
}
