// Shared domain types. Daemon and UI both import from here; keep additive.

export type Severity = "info" | "notable" | "alarm";
export type FlagSeverity = Exclude<Severity, "info">;
export type SessionStatus = "running" | "exited";

export interface Session {
  id: string;
  /** Claude Code's own session_id, bound from the first hook payload (milestone 2). */
  claudeSessionId?: string;
  cwd: string;
  title: string;
  createdAt: number;
  status: SessionStatus;
  exitCode?: number;
  parentSessionId?: string;
  /** Program spawned in the PTY. Defaults to "claude"; the smoke test passes a shell. */
  command?: string;
  pid?: number;
}

export interface RepoState {
  path: string;
  name: string;
  branch: string;
  head: string;
  upstream?: string;
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
}

export interface Usage {
  fiveHour?: RateWindow;
  sevenDay?: RateWindow;
  perSession: Record<string, SessionUsage>;
  updatedAt: number;
}

export type OverseerBackend = "auto" | "api" | "claude-cli";

export interface HenryConfig {
  port: number;
  /** Absolute after load (config.ts expands "~"). */
  reposRoot: string;
  /** Absolute after load. */
  defaultRepo: string;
  overseer: {
    backend: OverseerBackend;
    model: string;
    onStop: boolean;
    onFlag: boolean;
  };
  rules: {
    protectedBranches: string[];
    alarm: string[];
    notable: string[];
    crossRepoWrite: Severity;
    commitOnProtected: Severity;
  };
}

export const DEFAULT_CONFIG: HenryConfig = {
  port: 4711,
  reposRoot: "~/code",
  defaultRepo: "~/code/off-chain",
  overseer: { backend: "auto", model: "claude-opus-5", onStop: true, onFlag: true },
  rules: {
    protectedBranches: ["main", "master"],
    alarm: ["git push --force", "git push -f", "git reset --hard", "rm -rf", "git branch -D", "git checkout -- ."],
    notable: ["git push", "git rebase", "git merge", "git checkout", "git switch", "git worktree", "git stash", "gh pr"],
    crossRepoWrite: "notable",
    commitOnProtected: "alarm",
  },
};

/** One row of the new-tab repo picker (GET /api/repos). */
export interface RepoPickerEntry {
  path: string;
  name: string;
  isWorktree: boolean;
  worktreeOf?: string;
}
