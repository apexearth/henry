// WebSocket client + tiny store (useSyncExternalStore). PTY traffic bypasses React state:
// Terminal components subscribe per session via subscribePty.
import { useSyncExternalStore } from "react";
import { baseName } from "./platform";
import { nameHue } from "./theme";
import { isClaudeSession, type ClientMessage, type Flag, type HenryConfig, type HenryEvent, type PeerStatus, type PlaybookEntry, type RepoState, type ServerMessage, type Session, type SessionKind, type Usage } from "@henry/shared";

export type PtyMessage = Extract<ServerMessage, { type: "pty:data" | "pty:scrollback" | "pty:exit" }>;

/** How the rail buckets sessions within a machine: not at all, by working directory, by every
 * repo touched, or by who owes whom a move (your move first, longest-unanswered at the top).
 * Machines are always split: this one first, then each paired peer (buildGroups). */
export type GroupBy = "none" | "cwd" | "repos" | "attention";

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
  /** The daemon has no user-chosen reposRoot yet; the setup modal blocks until it does. */
  firstRun: boolean;
  /** This daemon's own name; sessions without `peer` live on it. */
  host: string | null;
  /** Paired machines and how their links are doing (federation). */
  peers: PeerStatus[];
  /** Persisted, so a refresh reopens the session (or at least the repo) you were in. */
  activeSessionId: string | null;
  /** Which rail row of the active session is "here": under "by repo" a session is listed
   * once per repo, and ⌘↑/↓ must step from the row you picked, not its first echo. Not
   * persisted; unknown (null) or stale means the first row. */
  activeGroup: string | null;
  /** Rail: list exited sessions below the running ones (default: hidden). Persisted. */
  showClosed: boolean;
  /** Rail: grouping of the session list. Persisted. */
  groupBy: GroupBy;
  /** Rail: machines folded away, by name ("" for this one). Their header stays so they can be
   * unfolded; their rows leave the list and the ⌘1..9 order. Persisted. */
  hiddenMachines: string[];
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
  firstRun: false,
  host: null,
  peers: [],
  activeSessionId: readLastActive()?.id ?? null,
  activeGroup: null,
  showClosed: readShowClosed(),
  groupBy: readGroupBy(),
  hiddenMachines: readHiddenMachines(),
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

function readGroupBy(): GroupBy {
  try {
    const v = localStorage.getItem("henry.groupBy");
    return v === "cwd" || v === "repos" || v === "attention" ? v : "none";
  } catch {
    return "none";
  }
}

function readHiddenMachines(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("henry.hiddenMachines") ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The session you last looked at, with its cwd so a gone session can fall back to its repo. */
interface LastActive {
  id: string;
  cwd: string;
}

function readLastActive(): LastActive | null {
  try {
    const raw = localStorage.getItem("henry.active");
    const v = raw ? (JSON.parse(raw) as Partial<LastActive>) : null;
    return v?.id ? { id: v.id, cwd: v.cwd ?? "" } : null;
  } catch {
    return null;
  }
}

let lastActive = readLastActive();

function rememberActive(id: string | null): void {
  // The cwd is only known once sessions have arrived; keep the stored one until then.
  const cwd = state.sessions.find((s) => s.id === id)?.cwd ?? (id === lastActive?.id ? lastActive.cwd : "");
  if (lastActive?.id === id && lastActive.cwd === cwd) return;
  lastActive = id ? { id, cwd } : null;
  try {
    if (lastActive) localStorage.setItem("henry.active", JSON.stringify(lastActive));
    else localStorage.removeItem("henry.active");
  } catch {}
}

const listeners = new Set<() => void>();
function setState(patch: Partial<UiState>) {
  state = { ...state, ...patch };
  if (patch.activeSessionId !== undefined || patch.sessions) rememberActive(state.activeSessionId);
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
  // The remembered session is gone (killed while away, or a restart): stay in its repo if we can.
  const inRepo = lastActive?.cwd ? sessions.filter((s) => s.cwd === lastActive!.cwd) : [];
  return (
    inRepo.find((s) => s.status === "running")?.id ??
    sessions.find((s) => s.status === "running")?.id ??
    inRepo[0]?.id ??
    sessions[0]?.id ??
    null
  );
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
        firstRun: m.firstRun,
        host: m.host ?? null,
        peers: m.peers ?? [],
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
    case "peers:update":
      setState({ peers: m.peers });
      return;
  }
}

/** The rail's order: running sessions oldest first, then (when shown) exited ones newest first.
 * The exited session you are looking at stays listed until you move on. ⌘1..9 and ⌘↑/↓ follow it. */
function baseOrder(s: UiState): Session[] {
  const running = s.sessions.filter((x) => x.status === "running");
  const closed = s.sessions
    .filter((x) => x.status !== "running" && (s.showClosed || x.id === s.activeSessionId))
    .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
  return [...running, ...closed];
}

export interface RailGroup {
  /** Unique across the rail: the machine's name (empty for this one), a newline, the bucket. */
  key: string;
  /** Empty when the rail should list the rows with no header (groupBy "none"). */
  label: string;
  title: string;
  /** Set for identity groups (a folder, a repo) and left off semantic ones. */
  hue?: number;
  /** The paired machine whose sessions these are; unset for this machine's. */
  peer?: string;
  /** The machine is folded: one group carrying all its sessions so the header still counts
   * them, but the rail draws no rows and they are out of the ⌘1..9 order. */
  hidden?: boolean;
  sessions: Session[];
}

const NO_REPO = "\u0000no-repo";

/** Machine first, grouping second: this machine's sessions, then each peer's by name, with the
 * chosen grouping applied inside each. The rail draws a delimiter where the machine changes,
 * so a remote's rows never mix with local ones whatever the grouping. */
function buildGroups(order: Session[], s: UiState): RailGroup[] {
  const peers = [...new Set(order.map((x) => x.peer).filter((p): p is string => !!p))].sort();
  const out: RailGroup[] = [];
  for (const peer of [undefined, ...peers]) {
    const mine = order.filter((x) => x.peer === peer);
    if (s.hiddenMachines.includes(machineKey(peer))) {
      out.push({ key: `${peer ?? ""}\n hidden`, label: "", title: "", peer, hidden: true, sessions: mine });
      continue;
    }
    for (const g of machineGroups(mine, s)) out.push({ ...g, key: `${peer ?? ""}\n${g.key}`, peer });
  }
  return out;
}

/** How a machine is keyed in `hiddenMachines`: its peer name, or "" for this one. */
export function machineKey(peer: string | undefined): string {
  return peer ?? "";
}

function machineGroups(order: Session[], s: UiState): RailGroup[] {
  if (s.groupBy === "none") return [{ key: "all", label: "", title: "", sessions: order }];
  const groups = new Map<string, RailGroup>();
  const add = (key: string, label: string, title: string, session: Session) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, label, title, hue: key === NO_REPO ? undefined : nameHue(label), sessions: [] }));
    g.sessions.push(session);
  };
  if (s.groupBy === "attention") return attentionGroups(order);
  for (const session of order) {
    if (s.groupBy === "cwd") {
      add(session.cwd, basename(session.cwd), session.cwd, session);
      continue;
    }
    // "repos involved": a session is listed under every repo it has touched, so a session
    // working across two repos shows up in both. One that has touched none gets its own bucket.
    const repos = s.repos[session.id] ?? [];
    if (!repos.length) add(NO_REPO, "no repo", "no repo activity seen yet", session);
    else for (const r of repos) add(r.path, r.name, r.path, session);
  }
  // First-appearance order (running sessions first), except the catch-all which goes last.
  return [...groups.values()].sort((a, b) => Number(a.key === NO_REPO) - Number(b.key === NO_REPO));
}

/** Running Claude sessions split into "your move" (sorted by how long you have left them:
 * oldest input first) and "working", then terminals, then whatever closed rows are shown. */
function attentionGroups(order: Session[]): RailGroup[] {
  const yours: Session[] = [];
  const working: Session[] = [];
  const rest: Session[] = [];
  for (const x of order) {
    if (x.status !== "running" || !isClaudeSession(x)) rest.push(x);
    else if (x.activity === "working") working.push(x);
    else yours.push(x);
  }
  yours.sort((a, b) => (a.lastInputAt ?? a.activitySince ?? a.createdAt) - (b.lastInputAt ?? b.activitySince ?? b.createdAt));
  const groups: RailGroup[] = [];
  if (yours.length) groups.push({ key: "yours", label: "your move", title: "the turn ended or Claude is asking; longest since you typed first", sessions: yours });
  if (working.length) groups.push({ key: "working", label: "working", title: "a turn is running", sessions: working });
  if (rest.length) groups.push({ key: "rest", label: "other", title: "terminals and closed sessions", sessions: rest });
  return groups;
}

const basename = baseName;

// Memoised on its inputs: useSyncExternalStore needs the same array back until something
// changes, or React sees an ever-new snapshot and throws "maximum update depth exceeded".
let groupCache: { s: UiState; groups: RailGroup[]; flat: Session[]; rows: RailRow[] } | null = null;
function railCache(s: UiState): { groups: RailGroup[]; flat: Session[]; rows: RailRow[] } {
  const c = groupCache;
  if (
    c &&
    c.s.sessions === s.sessions &&
    c.s.showClosed === s.showClosed &&
    c.s.activeSessionId === s.activeSessionId &&
    c.s.groupBy === s.groupBy &&
    c.s.hiddenMachines === s.hiddenMachines &&
    c.s.repos === s.repos
  )
    return c;
  const groups = buildGroups(baseOrder(s), s);
  const shown = groups.filter((g) => !g.hidden);
  const flat = shown.length === 1 ? shown[0]!.sessions : shown.flatMap((g) => g.sessions);
  const rows = shown.flatMap((g) => g.sessions.map((session) => ({ group: g.key, session })));
  groupCache = { s, groups, flat, rows };
  return groupCache;
}

export function railGroups(s: UiState = state): RailGroup[] {
  return railCache(s).groups;
}

/** The rail's rows in display order. Under "repos" a session appears once per repo it touched,
 * so ⌘1..9 and ⌘↑/↓ walk exactly what is on screen. */
export function railOrder(s: UiState = state): Session[] {
  return railCache(s).flat;
}

export interface RailRow {
  group: string;
  session: Session;
}

/** Same rows, each with the group it sits in, for stepping and for telling the row you are on
 * from its echoes. */
export function railRows(s: UiState = state): RailRow[] {
  return railCache(s).rows;
}

/** Index of the row that is "here": the active session in its picked group, or its first
 * row when the group is unknown or no longer lists it. -1 with no active session. */
export function activeRowIndex(s: UiState = state): number {
  const rows = railCache(s).rows;
  const here = rows.findIndex((r) => r.session.id === s.activeSessionId && r.group === s.activeGroup);
  return here >= 0 ? here : rows.findIndex((r) => r.session.id === s.activeSessionId);
}

// ---- actions ----

export function toggleShowClosed(): void {
  const showClosed = !state.showClosed;
  try {
    localStorage.setItem("henry.showClosed", showClosed ? "1" : "0");
  } catch {}
  setState({ showClosed });
}

/** Fold a machine's sessions away (or bring them back). Nothing is disconnected: the rows just
 * leave the rail, so a remote you are not working on stops taking up the list. */
export function toggleMachine(peer: string | undefined): void {
  const key = machineKey(peer);
  const hiddenMachines = state.hiddenMachines.includes(key) ? state.hiddenMachines.filter((k) => k !== key) : [...state.hiddenMachines, key];
  try {
    localStorage.setItem("henry.hiddenMachines", JSON.stringify(hiddenMachines));
  } catch {}
  setState({ hiddenMachines });
}

export function setGroupBy(groupBy: GroupBy): void {
  try {
    localStorage.setItem("henry.groupBy", groupBy);
  } catch {}
  setState({ groupBy });
}

/** `group` is the rail row that was picked; callers that only know the session (a terminal
 * panel getting focus) leave it, and the row falls back to the picked group if it still lists
 * the session, else the first one. */
export function setActive(sessionId: string | null, group?: string): void {
  const activeGroup = group ?? (sessionId === state.activeSessionId ? state.activeGroup : null);
  if (sessionId !== state.activeSessionId || activeGroup !== state.activeGroup) setState({ activeSessionId: sessionId, activeGroup });
}

export function createSession(cwd: string, title?: string, kind: SessionKind = "claude", peer?: string): void {
  const requestId = crypto.randomUUID();
  pendingCreates.add(requestId);
  send({ type: "session:create", cwd, title: title || undefined, kind, requestId, peer });
}

/** Another tab of the same kind in the active session's folder, on the same machine. Nothing happens with no active tab. */
export function duplicateSession(): void {
  const s = state.sessions.find((x) => x.id === state.activeSessionId);
  if (s) createSession(s.cwd, undefined, s.kind ?? "claude", s.peer);
}

/** Start a new tab that resumes an exited session's Claude conversation, and drop the old tab. */
export function resumeSession(s: Session): void {
  if (!s.claudeSessionId) return;
  const requestId = crypto.randomUUID();
  pendingCreates.add(requestId);
  send({ type: "session:create", cwd: s.cwd, title: s.title, resume: s.claudeSessionId, requestId, peer: s.peer });
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
