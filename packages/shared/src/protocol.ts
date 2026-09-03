// WebSocket protocol (/ws) and REST shapes. Every frame is one JSON object with a `type`.
import type { Flag, HenryConfig, HenryEvent, PlaybookEntry, RepoState, Session, Usage } from "./types";

export type ClientMessage =
  | { type: "attach"; sessionId: string }
  | { type: "detach"; sessionId: string }
  | { type: "pty:input"; sessionId: string; data: string }
  | { type: "pty:resize"; sessionId: string; cols: number; rows: number }
  | {
      type: "session:create";
      cwd: string;
      title?: string;
      /** Program to run; defaults to "claude". Tests pass a shell. */
      command?: string;
      args?: string[];
      /** Claude session id to resume (`claude --resume <id>`) instead of starting fresh. */
      resume?: string;
      /** Echoed back on the resulting session:update so the creator can select it. */
      requestId?: string;
    }
  | { type: "session:kill"; sessionId: string }
  | { type: "flags:markRead"; ids: string[] }
  | { type: "playbook:request"; sessionId: string | null }
  | { type: "repo:diff"; sessionId: string; repoPath: string }
  | { type: "state:request" };

/** Full snapshot; also the body of GET /api/state (without `type`). */
export interface StateMessage {
  type: "state";
  sessions: Session[];
  repos: Record<string, RepoState[]>;
  flags: Flag[];
  usage: Usage;
  playbook: PlaybookEntry[];
  config: HenryConfig;
}

export type StateSnapshot = Omit<StateMessage, "type">;

export type ServerMessage =
  | StateMessage
  | { type: "pty:data"; sessionId: string; data: string }
  | { type: "pty:scrollback"; sessionId: string; data: string }
  | { type: "pty:exit"; sessionId: string; exitCode: number }
  | { type: "session:update"; session: Session; requestId?: string }
  | { type: "event"; event: HenryEvent }
  | { type: "flag"; flag: Flag }
  | { type: "repos:update"; sessionId: string; repos: RepoState[] }
  | { type: "usage:update"; usage: Usage }
  | { type: "playbook:update"; entry: PlaybookEntry }
  | { type: "repo:diff"; sessionId: string; repoPath: string; diff: string; baseline: string };

export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;
export type ClientMessageOf<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;
