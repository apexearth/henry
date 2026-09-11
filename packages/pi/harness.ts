// The Pi harness. Henry reads a pi session from its JSONL (messages, compaction, branch-summary)
// and maps any tool *result* it finds through the exact same ingest path as Claude Code's, so the
// Rules engine, flags and status lines are identical. Henry does not need a per-event emit from Pi;
// a session is just a transcript of calls and results. pi-for-henry's role is only turn demarcation:
// Henry re-reads the JSONL and treats the boundary between a tool and its result as a call.
import type { Flag, HenryEvent, Severity, Session } from "@henry/shared";

export type Harness = "claude" | "pi";

/** A completed tool invocation: what the harness *did*. Henry keys Rules off `toolName`, so a Pi
// `write`/`edit`/`read`/`bash` classifies identically to Claude's. */
export interface Call {
  // Claude's tool name. Pi's `write`, `edit`, `read`, `bash`...
  tool: string;
  // Either the command to run, or the file-path / content to edit.
  file?: string;
}

export interface ToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  // A failure marker. Claude codes this in tool_response or `is_error`.
  error?: string;
  // A path the tool touched (for RepoState + Rules).
  file?: string;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  content?: unknown;
  isError: boolean;
}

/** The pi session JSONL, per-file. Each line is a JSON object; `role` decides how Henry reads it. */
export interface Entry {
  type: "message";
  role: string;
  ts: number;
  /** For user/assistant/tool_result */
  content?: unknown;
  /** For tool_result */
  isError?: boolean;
  /** For user/assistant */
  usage?: Record<string | number | boolean, unknown>;
  /** The pi `!` prefix / prompt kind */
  promptKind?: string | null;
  id: string;
  parentId: string | null;
}

/** What Henry emits per pi turn, plus the call that ended it. This is the *only* pi-specific
// thing that flows to the daemon: the rest is the shared transcript. */
export interface Turn {
  ts: number;
  /** Claude's Stop hook. */
  stopHookActive?: boolean;
}

export const isPiSession = (s: Pick<Session, "kind" | "command" | "claudeActive">): boolean => s.kind === "pi";

/** Severity of a pi turn. Turn-level flags are rare; most turns are informational, but a failure
// call (error) raises the turn to *alarm*, and any non-error call is informational. */
export function turnSeverity(t: Turn, error?: string): Severity {
  return error ? "alarm" : "info";
}

/** The pi "⚡" — same hue/ordering as the Claude mark, but unmistakably Pi. Used in title, rail and
// usage. Renders at the same 16..48px sizes as the Claude mark so the rail never reshapes. */
export const piColor = "#111111";
export const piGlyph = "⚡";

/** True when Henry runs the pi harness (a pi process is installed for this daemon). Nothing changes
// without a re-`bun run dev`; the running daemon never sees Pi. */
export function isPiLaunched(): boolean {
  // The daemon only launches pi via `pi -e`; a running daemon never sees a pi process.
  return !!process.env.PI_HENRY;
}
