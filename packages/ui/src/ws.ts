// WebSocket client + tiny store (useSyncExternalStore). PTY traffic bypasses React state:
// Terminal components subscribe per session via subscribePty.
import { useSyncExternalStore } from "react";
import type { ClientMessage, Flag, HenryConfig, HenryEvent, PlaybookEntry, RepoState, ServerMessage, Session, SessionKind, Usage } from "@henry/shared";

export type PtyMessage = Extract<ServerMessage, { type: "pty:data" | "pty:scrollback" | "pty:exit" }>;

export interface UiState {
  connected: boolean;
  /** Increments on every (re)connect; terminals re-attach when it changes. */
  connectionId: number;
  /** True once the first full state snapshot has arrived; the layout waits for it. */
  hydrated: boolean;
  sessions: Session[];
  repos: Record<string, RepoState[]>;
  flags: Flag[];
  usage: Usage;
  playbook: PlaybookEntry[];
  config: HenryConfig | null;
  activeSessionId: string | null;
  /** Rail: list exited sessions below the running ones (default: hidden). Persisted. */
  showClosed: boolean;
  /** Raw event feed (capped), for the Flags/raw-events views. */
  events: HenryEvent[];
  /** Diffs by `${sessionId}\n${repoPath}`. */
  diffs: Record<string, { diff: string; baseline: string }>;
}

let state: UiState = {
  connected: false,
  connectionId: 0,
  hydrated: false,
  sessions: [],
  repos: {},
  flags: [],
  usage: { perSession: {}, updatedAt: 0 },
  playbook: [],
  config: null,
  activeSessionId: null,
  showClosed: readShowClosed(),
  events: [],
  diffs: {},
};

function readShowClosed(): boolean {
  try {
    return localStorage.getItem("henry.showClosed") === "1";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();
function setState(patch: Partial<UiState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
export function getState() {
  return state;
}
export function useStore<T>(selector: (s: UiState) => T): T {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => selector(state));
}

const ptyListeners = new Map<string, Set<(m: PtyMessage) => void>>();
export function subscribePty(sessionId: string, cb: (m: PtyMessage) => void): () => void {
  let set = ptyListeners.get(sessionId);
  if (!set) ptyListeners.set(sessionId, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (!set!.size) ptyListeners.delete(sessionId);
  };
}

let ws: WebSocket | null = null;
let backoff = 500;
const pendingCreates = new Set<string>();

export function send(msg: ClientMessage): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function connect(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    backoff = 500;
    setState({ connected: true, connectionId: state.connectionId + 1 });
  };
  ws.onmessage = (e) => handle(JSON.parse(String(e.data)) as ServerMessage);
  ws.onclose = () => {
    setState({ connected: false });
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 5000);
  };
  ws.onerror = () => ws?.close();
}

// Served from the daemon (a build, not the Vite dev server): reload when ui/dist changes,
// including a change that happened while the daemon was down (state carries the build too).
let uiBuild: string | undefined;
function noteUiBuild(build: string | undefined): void {
  if (!build || import.meta.env.DEV) return;
  if (uiBuild === undefined) uiBuild = build;
  else if (uiBuild !== build) location.reload();
}

function pickActive(sessions: Session[], current: string | null): string | null {
  if (current && sessions.some((s) => s.id === current)) return current;
  return sessions.find((s) => s.status === "running")?.id ?? sessions[0]?.id ?? null;
}

function handle(m: ServerMessage): void {
  switch (m.type) {
    case "state":
      noteUiBuild(m.uiBuild);
      setState({
        sessions: m.sessions,
        repos: m.repos,
        flags: m.flags,
        usage: m.usage,
        playbook: m.playbook,
        config: m.config,
        activeSessionId: pickActive(m.sessions, state.activeSessionId),
        hydrated: true,
      });
      return;
    case "pty:data":
    case "pty:scrollback":
    case "pty:exit":
      ptyListeners.get(m.sessionId)?.forEach((cb) => cb(m));
      return;
    case "session:update": {
      const sessions = state.sessions.some((s) => s.id === m.session.id)
        ? state.sessions.map((s) => (s.id === m.session.id ? m.session : s))
        : [...state.sessions, m.session].sort((a, b) => a.createdAt - b.createdAt);
      const mine = m.requestId !== undefined && pendingCreates.delete(m.requestId);
      setState({ sessions, activeSessionId: mine ? m.session.id : pickActive(sessions, state.activeSessionId) });
      return;
    }
    case "event":
      setState({ events: [m.event, ...state.events].slice(0, 500) });
      return;
    case "flag":
      setState({ flags: [m.flag, ...state.flags.filter((f) => f.id !== m.flag.id)] });
      return;
    case "repos:update":
      setState({ repos: { ...state.repos, [m.sessionId]: m.repos } });
      return;
    case "usage:update":
      setState({ usage: m.usage });
      return;
    case "playbook:update":
      setState({ playbook: [m.entry, ...state.playbook.filter((p) => p.id !== m.entry.id)].sort((a, b) => b.ts - a.ts) });
      return;
    case "repo:diff":
      setState({ diffs: { ...state.diffs, [`${m.sessionId}\n${m.repoPath}`]: { diff: m.diff, baseline: m.baseline } } });
      return;
    case "ui:build":
      noteUiBuild(m.build);
      return;
  }
}

/** The rail's order: running sessions oldest first, then (when shown) exited ones newest first.
 * The exited session you are looking at stays listed until you move on. ⌘1..9 and ⌘↑/↓ follow it. */
// Memoised on its inputs: useSyncExternalStore needs the same array back until something
// changes, or React sees an ever-new snapshot and throws "maximum update depth exceeded".
let railCache: { sessions: Session[]; showClosed: boolean; activeSessionId: string | null; result: Session[] } | null = null;
export function railOrder(s: UiState = state): Session[] {
  const c = railCache;
  if (c && c.sessions === s.sessions && c.showClosed === s.showClosed && c.activeSessionId === s.activeSessionId) return c.result;
  const running = s.sessions.filter((x) => x.status === "running");
  const closed = s.sessions
    .filter((x) => x.status !== "running" && (s.showClosed || x.id === s.activeSessionId))
    .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
  const result = [...running, ...closed];
  railCache = { sessions: s.sessions, showClosed: s.showClosed, activeSessionId: s.activeSessionId, result };
  return result;
}

// ---- actions ----

export function toggleShowClosed(): void {
  const showClosed = !state.showClosed;
  try {
    localStorage.setItem("henry.showClosed", showClosed ? "1" : "0");
  } catch {}
  setState({ showClosed });
}

export function setActive(sessionId: string | null): void {
  if (sessionId !== state.activeSessionId) setState({ activeSessionId: sessionId });
}

export function createSession(cwd: string, title?: string, kind: SessionKind = "claude"): void {
  const requestId = crypto.randomUUID();
  pendingCreates.add(requestId);
  send({ type: "session:create", cwd, title: title || undefined, kind, requestId });
}

/** Start a new tab that resumes an exited session's Claude conversation, and drop the old tab. */
export function resumeSession(s: Session): void {
  if (!s.claudeSessionId) return;
  const requestId = crypto.randomUUID();
  pendingCreates.add(requestId);
  send({ type: "session:create", cwd: s.cwd, title: s.title, resume: s.claudeSessionId, requestId });
  killSession(s.id);
}

export function killSession(sessionId: string): void {
  send({ type: "session:kill", sessionId });
}

export function markFlagsRead(ids: string[]): void {
  if (!ids.length) return;
  send({ type: "flags:markRead", ids });
  setState({ flags: state.flags.map((f) => (ids.includes(f.id) ? { ...f, read: true } : f)) });
}

export function requestPlaybook(sessionId: string | null): void {
  send({ type: "playbook:request", sessionId });
}

export function requestDiff(sessionId: string, repoPath: string): void {
  send({ type: "repo:diff", sessionId, repoPath });
}

export const diffKey = (sessionId: string, repoPath: string) => `${sessionId}\n${repoPath}`;
