// WebSocket protocol (/ws) and REST shapes. Every frame is one JSON object with a `type`.
import type { Flag, HenryConfig, HenryEvent, PeerStatus, PlaybookEntry, RepoState, Session, SessionKind, Usage } from "./types";

export type ClientMessage =
  /** `reqId` is echoed on the pty:scrollback reply; a daemon relaying for several windows needs it, the UI does not. */
  | { type: "attach"; sessionId: string; reqId?: string }
  | { type: "detach"; sessionId: string }
  | { type: "pty:input"; sessionId: string; data: string }
  | {
      type: "pty:resize";
      sessionId: string;
      cols: number;
      rows: number;
      /** The terminal was just shown again: make the program repaint even if the size is
       * unchanged. How is the daemon's call, since it depends on the PTY's platform. */
      redraw?: boolean;
    }
  | {
      type: "session:create";
      cwd: string;
      title?: string;
      /** "claude" (default) or "shell" (the user's $SHELL as a login shell). */
      kind?: SessionKind;
      /** Program to run; overrides `kind`. Tests pass a shell. */
      command?: string;
      args?: string[];
      /** Claude session id to resume (`claude --resume <id>`) instead of starting fresh. */
      resume?: string;
      /** Echoed back on the resulting session:update so the creator can select it. */
      requestId?: string;
      /** Start it on a paired machine (PeerStatus.name) instead of here. */
      peer?: string;
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
  /** No `reposRoot` in ~/.henry/config.json yet: the UI asks for it before anything else. */
  firstRun: boolean;
  /** This daemon's own name (config.host); sessions without `peer` live here. */
  host?: string;
  /** Paired machines and their link state (federation). */
  peers?: PeerStatus[];
  /** Identity of the ui/dist build the daemon serves (index.html mtime); windows reload when it changes. */
  uiBuild?: string;
}

export type StateSnapshot = Omit<StateMessage, "type">;

export type ServerMessage =
  | StateMessage
  | { type: "pty:data"; sessionId: string; data: string }
  /** `reqId` and `exitCode` are set only when answering an attach that carried a reqId. */
  | { type: "pty:scrollback"; sessionId: string; data: string; reqId?: string; exitCode?: number }
  | { type: "pty:exit"; sessionId: string; exitCode: number }
  | { type: "session:update"; session: Session; requestId?: string }
  | { type: "event"; event: HenryEvent }
  | { type: "flag"; flag: Flag }
  | { type: "repos:update"; sessionId: string; repos: RepoState[] }
  | { type: "usage:update"; usage: Usage }
  | { type: "playbook:update"; entry: PlaybookEntry }
  | { type: "repo:diff"; sessionId: string; repoPath: string; diff: string; baseline: string }
  /** ui/dist was rebuilt; windows served from the daemon reload themselves. */
  | { type: "ui:build"; build: string }
  | { type: "peers:update"; peers: PeerStatus[] };

export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;
export type ClientMessageOf<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;
