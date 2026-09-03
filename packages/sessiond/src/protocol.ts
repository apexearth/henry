// Wire protocol between henry-sessiond and its clients (the Henry daemon, the CLI).
// NDJSON over loopback TCP: one JSON object per line, in both directions.
//
// This file is sessiond's only contract. It has no imports and nothing outside
// packages/sessiond may be imported into sessiond; the daemon imports *this* file
// (type-only, plus PROTOCOL_VERSION). Bump PROTOCOL_VERSION when a change is not
// backward compatible; additive fields do not need a bump.

export const PROTOCOL_VERSION = 1;

/** Contents of <HENRY_HOME>/sessiond.json, written by sessiond on start (mode 0600). */
export interface SessiondInfo {
  port: number;
  token: string;
  pid: number;
  protocolVersion: number;
  startedAt: number;
}

export type SessionStatus = "running" | "exited";

export interface SessionSummary {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  pid: number;
  cols: number;
  rows: number;
  status: SessionStatus;
  exitCode?: number;
  createdAt: number;
  endedAt?: number;
}

/** Client -> server. The first message on a connection must be `hello`. */
export type ClientMessage =
  | { op: "hello"; token: string; protocolVersion: number }
  | { op: "spawn"; id: string; command: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }
  | { op: "write"; id: string; data: string }
  | { op: "resize"; id: string; cols: number; rows: number }
  /** On a running session: deliver the signal (default SIGHUP). On an exited one: forget it. */
  | { op: "kill"; id: string; signal?: string }
  /** Subscribe to a session's output: server replies `scrollback` first, then live `data`. */
  | { op: "attach"; id: string }
  | { op: "detach"; id: string }
  | { op: "list" }
  /** idle = exit once no session is running; now = SIGHUP every running session, then exit. */
  | { op: "shutdown"; when: "idle" | "now" }
  | { op: "ping" };

/** Server -> client. */
export type ServerMessage =
  | { op: "hello"; protocolVersion: number; pid: number; sessions: SessionSummary[] }
  | { op: "spawned"; id: string; pid: number }
  | { op: "data"; id: string; data: string }
  | { op: "scrollback"; id: string; data: string }
  | { op: "exit"; id: string; exitCode: number; signal?: number }
  /** Full session table; sent to every client after any change and in reply to `list`. */
  | { op: "sessions"; sessions: SessionSummary[] }
  | { op: "error"; id?: string; message: string }
  | { op: "pong" };
