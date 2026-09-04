// Layout state for the dockable UI: the Dockview API singleton, the default arrangement,
// localStorage persistence, and the "show this session" helper the rail uses.
import type { DockviewApi, DockviewGroupPanel, DockviewTheme, IDockviewPanel, SerializedDockview } from "dockview-react";
import type { Session } from "@henry/shared";
import { isClaudeSession } from "@henry/shared";
import { baseName } from "./platform";
import { getState } from "./ws";

export type ToolId = "sessions" | "repos" | "flags" | "playbook" | "usage";
export const TOOLS: { id: ToolId; title: string }[] = [
  { id: "sessions", title: "Sessions" },
  { id: "repos", title: "Repos" },
  { id: "flags", title: "Flags" },
  { id: "playbook", title: "Playbook" },
  { id: "usage", title: "Usage" },
];

// v2 moved Usage out of the tool tab strip into its own bottom-right pane.
const STORAGE_KEY = "henry.layout.v2";
/** Height of the Usage pane in the bottom-right corner: the two rate bars plus a few rows. */
const USAGE_HEIGHT = 300;
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

export function loadLayout(): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SerializedDockview) : null;
  } catch {
    return null;
  }
}

export function saveLayout() {
  if (!api) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(api.toJSON()));
  } catch {
    /* quota or private mode: layout just won't persist */
  }
}

/** rail | terminals | tool tabs, with Usage under them; the pre-dock arrangement. */
export function buildDefaultLayout() {
  if (!api) return;
  api.clear();
  api.addPanel({ id: "sessions", component: "sessions", title: "Sessions" });
  api.addPanel({ id: "repos", component: "repos", title: "Repos", position: { referencePanel: "sessions", direction: "right" } });
  for (const t of TOOLS.slice(2)) {
    if (t.id === "usage") continue; // usage is a readout you watch, not a tab you switch to
    api.addPanel({ id: t.id, component: t.id, title: t.title, position: { referencePanel: "repos", direction: "within" }, inactive: true });
  }
  // The centre group exists even with no sessions, so the rail and tools keep their widths.
  styleTerminalGroup(api.addGroup({ id: "center", referencePanel: "repos", direction: "left" }));
  // Usage sits in the bottom-right corner. It goes in after the centre group so the split stays
  // inside the tool column instead of spanning the stage too.
  addUsagePane();
  for (const s of getState().sessions) ensureSessionPanel(s);
  api.getPanel("repos")?.api.setActive();
  applyDefaultSizes();
}

/** Usage's home: its own pane under the tool column, in the bottom-right corner. */
function addUsagePane() {
  if (!api) return;
  const above = TOOLS.map((t) => t.id).find((t) => t !== "usage" && t !== "sessions" && api!.getPanel(t));
  const panel = api.addPanel({
    id: "usage",
    component: "usage",
    title: "Usage",
    position: above ? { referencePanel: above, direction: "below" } : { direction: "right" },
  });
  requestAnimationFrame(() => panel.api.setSize({ height: USAGE_HEIGHT }));
  return panel;
}

/** Rail and tools are fixed-width columns; terminals take the rest. Needs a measured grid. */
function applyDefaultSizes() {
  requestAnimationFrame(() => {
    api?.getPanel("sessions")?.api.setSize({ width: 220 });
    api?.getPanel("repos")?.api.setSize({ width: 360 });
  });
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
  if (!api) return;
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
  const s = getState().sessions.find((x) => x.id === sessionId);
  if (s) ensureSessionPanel(s, true);
}

/** Topbar activity chips: bring a tool forward, re-adding it if the user closed its tab. */
export function showTool(id: ToolId) {
  if (!api) return;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  if (id === "usage") return void addUsagePane();
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

export function peekFile(path: string, line?: number) {
  const g = stageGroup();
  if (!api || !g) return;
  const id = filePanelId(path);
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.updateParameters({ path, line });
    existing.api.setActive();
    return;
  }
  api.addPanel({ id, component: "file", title: baseName(path), params: { path, line }, position: { referenceGroup: g.id, direction: "within" } });
}

export function closePeek(id?: string) {
  if (!api) return;
  const p = id ? api.getPanel(id) : api.activePanel;
  if (!p || !isFilePanel(p.id)) return;
  const g = p.group;
  api.removePanel(p);
  // Last peek gone: back to the session that was showing, not whichever tab Dockview picks.
  if (!g.panels.some((x) => isFilePanel(x.id))) stageStrip(g)[0]?.api.setActive();
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
