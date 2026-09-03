// Shared domain types. Daemon and UI both import from here; keep additive.

export type Severity = "info" | "notable" | "alarm";
export type FlagSeverity = Exclude<Severity, "info">;
export type SessionStatus = "running" | "exited";
/**
 * What a Claude session is doing right now, derived from the hook stream (see daemon/activity.ts):
 * `working` a turn is running, `needsInput` it is blocked on a permission prompt, `waiting` the
 * turn ended and the next move is yours, `idle` it has been waiting a while.
 */
export type SessionActivity = "working" | "needsInput" | "waiting" | "idle";
/** What Henry launched in the PTY: Claude Code, or the user's shell. */
export type SessionKind = "claude" | "shell";

export interface Session {
  id: string;
  /** Claude Code's own session_id, bound from the first hook payload (milestone 2). */
  claudeSessionId?: string;
  cwd: string;
  title: string;
  createdAt: number;
  status: SessionStatus;
  exitCode?: number;
  /** When the process ended; orders closed sessions in the rail. */
  endedAt?: number;
  parentSessionId?: string;
  /** Program spawned in the PTY. Defaults to "claude"; the smoke test passes a shell. */
  command?: string;
  /** Missing on rows from before shells existed: treat as "claude" (or external). */
  kind?: SessionKind;
  /** A Claude Code process is posting hooks from this PTY right now. Shells set this when
   * `claude` is started inside them and clear it on SessionEnd. */
  claudeActive?: boolean;
  pid?: number;
  /** Short name of the machine whose daemon owns this session (config.host, default os.hostname()). */
  host?: string;
  /** Set by the daemon you are attached to on sessions it relays from a paired machine
   * (federation): the peer's name in this daemon's peer list. Absent on local sessions. */
  peer?: string;
  /** Derived, never persisted: undefined for terminals and for Claude sessions yet to post a hook. */
  activity?: SessionActivity;
  /** When the session entered `activity`; the rail shows the time since. */
  activitySince?: number;
  /** Your side of the session (daemon/engagement.ts): when you last typed into it, prompt
   * or keystroke. Derived like `activity`; a restart recovers the last prompt only. */
  lastInputAt?: number;
  /** Timestamps of your prompts over the last PROMPT_WINDOW_MS, ascending. The rail draws
   * them as a sparkline so a session you stopped feeding reads as a flat tail. */
  prompts?: number[];
}

export interface RepoState {
  path: string;
  name: string;
  branch: string;
  head: string;
  upstream?: string;
  /** Web URL of the upstream's remote (origin when the branch has none), when it is a hosted git URL. */
  remoteUrl?: string;
  ahead: number;
  behind: number;
  /** Number of dirty (modified/untracked) paths. */
  dirty: number;
  isWorktree: boolean;
  worktreeOf?: string;
  /** HEAD sha recorded when the session first touched this repo. */
  baseline?: string;
  commitsSinceBaseline: number;
  lastCommitAt?: number;
}

export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionStart"
  | "UserPromptSubmit"
  | "SubagentStop"
  | "Notification"
  | "PreCompact"
  | "SessionEnd";

export type EventKind = "hook" | "git" | "statusline" | "transcript" | "system";

export interface HenryEvent {
  id: string;
  sessionId: string;
  claudeSessionId?: string;
  ts: number;
  kind: EventKind;
  hookEvent?: HookEventName | string;
  toolName?: string;
  cwd?: string;
  /** Repo path the event resolved into, if any. */
  repo?: string;
  payload: unknown;
  severity: Severity;
  /** Name of the rule that set the severity (milestone 4). */
  rule?: string;
  summary: string;
}

export interface Flag {
  id: string;
  eventId: string;
  sessionId: string;
  ts: number;
  severity: FlagSeverity;
  rule: string;
  summary: string;
  read: boolean;
}

export type PlaybookTrigger = "stop" | "flag" | "manual";

export interface PlaybookEntry {
  id: string;
  /** null = global playbook (across all sessions). */
  sessionId: string | null;
  ts: number;
  text: string;
  trigger: PlaybookTrigger;
  model?: string;
  /** "entry" (default) = one playbook step; "summary" = the rolling "right now" paragraph (newest wins). */
  kind?: "entry" | "summary";
}

export interface RateWindow {
  /** 0..1 fraction of the limit used. */
  utilization: number;
  /** Epoch ms when the window resets. */
  resetsAt?: number;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  model?: string;
  /** Live context occupancy: the last main-chain API call's input + cache read + cache write. */
  contextTokens?: number;
  /** Model context window in tokens (statusline `context_window_size`); UI assumes 200k when absent. */
  contextWindow?: number;
}

export interface Usage {
  fiveHour?: RateWindow;
  sevenDay?: RateWindow;
  perSession: Record<string, SessionUsage>;
  updatedAt: number;
}

export type OverseerBackend = "auto" | "api" | "claude-cli";

/** One paired machine as this daemon sees it (federation). */
export interface PeerStatus {
  name: string;
  /** SHA-256 of the peer's identity key, hex, grouped; compare across machines after pairing. */
  fingerprint: string;
  /** ws://host:port/fed we dial; absent for a peer that only dials us. */
  url?: string;
  /** Our outbound link: "off" when there is no url or the peer is disabled. */
  link: "connected" | "connecting" | "offline" | "off";
  /** The peer is currently dialed in to us (it sees our sessions). */
  inbound: boolean;
  enabled: boolean;
  pairedAt: number;
  lastSeenAt?: number;
  /** Sessions currently relayed from this peer. */
  sessions: number;
  error?: string;
}

/** GET /api/federation/status. */
export interface FederationStatus {
  name: string;
  fingerprint: string;
  /** Where inbound peers reach us, once the listener is up. */
  listening?: { address: string; port: number };
  /** Why the listener is not up (config off, no tailnet address, bind failed). */
  listenError?: string;
  /** An active pairing window: a one-time code another machine can use to pair with us. */
  pairing?: { code: string; expiresAt: number };
  peers: PeerStatus[];
}

export interface HenryConfig {
  port: number;
  /** Name stamped on sessions this daemon creates; default: short os.hostname(). */
  host?: string;
  /** Absolute after load (config.ts expands "~"). */
  reposRoot: string;
  /** Absolute after load. */
  defaultRepo: string;
  overseer: {
    backend: OverseerBackend;
    model: string;
    onStop: boolean;
    onFlag: boolean;
    /** Optional; ANTHROPIC_API_KEY in the environment takes precedence. */
    apiKey?: string;
    /** Floor in seconds between two Stop-triggered playbook runs for one session (default 60). */
    stopMinIntervalSec?: number;
  };
  /** Sessions on other machines (federation.ts). The daemon dials paired peers and relays
   * their sessions; `listen` is where other machines reach this one. */
  federation: {
    /** "tailscale" binds the Tailscale (CGNAT 100.64/10) address only; "off" never listens; an
     * explicit address binds that (0.0.0.0 is accepted with a warning). Default "tailscale". */
    listen: "tailscale" | "off" | string;
    port: number;
  };
  rules: {
    protectedBranches: string[];
    alarm: string[];
    notable: string[];
    crossRepoWrite: Severity;
    commitOnProtected: Severity;
    /** Severity for `git push` to a protected branch without --force (milestone 4). Default "notable". */
    pushToProtected?: Severity;
    /** SubagentStop events per session per 10 minutes before "subagent-storm" fires (milestone 4). Default 8. */
    maxSubagentsPer10m?: number;
  };
}

export const DEFAULT_CONFIG: HenryConfig = {
  port: 4711,
  reposRoot: "~/code",
  defaultRepo: "~/code",
  overseer: { backend: "auto", model: "claude-opus-5", onStop: true, onFlag: true },
  federation: { listen: "tailscale", port: 4712 },
  rules: {
    protectedBranches: ["main", "master"],
    alarm: ["git push --force", "git push -f", "git reset --hard", "rm -rf", "git branch -D", "git checkout -- ."],
    notable: ["git push", "git rebase", "git merge", "git checkout", "git switch", "git worktree", "git stash", "gh pr"],
    crossRepoWrite: "notable",
    commitOnProtected: "alarm",
    pushToProtected: "notable",
    maxSubagentsPer10m: 8,
  },
};

/** True when the rail should present this session as Claude Code (vs a plain terminal). */
export function isClaudeSession(s: Pick<Session, "kind" | "command" | "claudeActive">): boolean {
  // Rows from before `kind` existed: judge by the command (the smoke test's /bin/sh is a shell).
  const kind = s.kind ?? (s.command && s.command !== "external" && !/(^|\/)claude$/.test(s.command) ? "shell" : "claude");
  return kind === "shell" ? !!s.claudeActive : true;
}

/** One row of the new-tab repo picker (GET /api/repos). */
export interface RepoPickerEntry {
  path: string;
  name: string;
  isWorktree: boolean;
  worktreeOf?: string;
  /** A plain directory under reposRoot with no .git (scratch space); absent for repos. */
  folder?: true;
}

/** One file, read for a peek (GET /api/file). `content` is text, capped; see `truncated`. */
export interface FilePeek {
  /** Absolute, realpath'd. */
  path: string;
  /** Working-tree root and path within it, when the file sits in a known repo. */
  repoPath?: string;
  rel?: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content: string;
}

/** A file changed since the session's baseline (working tree vs baseline; `?` = untracked). */
export interface ChangedFile {
  /** Relative to the repo root. */
  path: string;
  status: "M" | "A" | "D" | "R" | "?";
  from?: string;
  /** Working-tree mtime, ms; absent for deleted files. */
  mtime?: number;
}

/** GET /api/session/files: every repo the session touched (plus the one its cwd is in). */
export interface SessionFiles {
  sessionId: string;
  repos: { path: string; name: string; baseline: string; files: ChangedFile[] }[];
}

/** GET /api/file/diff: one file, working tree vs the session baseline (unified diff, may be empty). */
export interface FileDiff {
  baseline: string;
  diff: string;
}
