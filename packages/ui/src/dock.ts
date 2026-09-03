// Layout state for the dockable UI: the Dockview API singleton, the default arrangement,
// localStorage persistence, and the "show this session" helper the rail uses.
import type { DockviewApi, DockviewGroupPanel, DockviewTheme, SerializedDockview } from "dockview-react";
import type { Session } from "@henry/shared";
import { isClaudeSession } from "@henry/shared";
import { getState } from "./ws";

export type ToolId = "sessions" | "repos" | "flags" | "playbook" | "usage";
export const TOOLS: { id: ToolId; title: string }[] = [
  { id: "sessions", title: "Sessions" },
  { id: "repos", title: "Repos" },
  { id: "flags", title: "Flags" },
  { id: "playbook", title: "Playbook" },
  { id: "usage", title: "Usage" },
];

const STORAGE_KEY = "henry.layout.v1";
export const TERM_PREFIX = "term:";
export const termPanelId = (sessionId: string) => TERM_PREFIX + sessionId;

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
  return g.id === "center" || g.panels.some((p) => p.id.startsWith(TERM_PREFIX));
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

/** rail | terminals | tool tabs, the pre-dock arrangement. */
export function buildDefaultLayout() {
  if (!api) return;
  api.clear();
  api.addPanel({ id: "sessions", component: "sessions", title: "Sessions" });
  api.addPanel({ id: "repos", component: "repos", title: "Repos", position: { referencePanel: "sessions", direction: "right" } });
  for (const t of TOOLS.slice(2)) {
    api.addPanel({ id: t.id, component: t.id, title: t.title, position: { referencePanel: "repos", direction: "within" }, inactive: true });
  }
  // The centre group exists even with no sessions, so the rail and tools keep their widths.
  styleTerminalGroup(api.addGroup({ id: "center", referencePanel: "repos", direction: "left" }));
  for (const s of getState().sessions) ensureSessionPanel(s);
  api.getPanel("repos")?.api.setActive();
  applyDefaultSizes();
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

