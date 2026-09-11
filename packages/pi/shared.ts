// The Pi harness: Henry shares the same ingest as Claude Code. Pi is famous for extensibility, so
// Henry adds a Pi extension the extension can emit what Henry needs, keyed off toolNames and hooks.
// The shape here mirrors Claude Code's ingest (a hook JSON + event): toolName, toolInput, summary, ts.
// A Pi event is only ever one of the extension's tools/blobs; nothing imports across a harness.
import type { Severity } from "@henry/shared";
import * as rules from "../daemon/src/rules";

export type HarnessKind = "claude" | "pi";

/** A turn's high-level event. `toolName`/`toolInput` drive the Rules engine, so a Pi Bash is
// indistinguishable from a Claude Bash. `summary` is the rail text; `ts` keeps events ordered. */
export interface Outbound {
  event: string; // Claude's hook_event_name style: "Bash", "Turn start", "Stop", "Session settle"
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  summary?: string;
  /** Claude's stop hook. Pi has no hook; a plain settle carrying `stopHookActive` means the turn ends. */
  stopHookActive?: boolean;
  /** The tool/sub-agent thread this event belongs to (Pi's nested runs). */
  thread?: string;
}

type Dict = Record<string, unknown>;
export const isObj = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);

/** `event` -> severity + rule: rules.classify in rules.ts, unchanged. Pi's events classify under
// the same rules; the switch is purely by toolName, so Pi's `Bash`/`Write`/`Read` are identical. */
export function severityForEvent(e: { toolName: string | undefined; summary: string }): string | undefined {
  const { toolName } = e;
  if (!toolName) return undefined; // control-flow events — no rule.
  switch (toolName) {
    case "Bash":
      return e.summary.includes("rm -rf") || e.summary.includes("rm -fr")
        ? "command-alarm"
        : e.summary.includes("!!")
          ? "history-rewrite"
          : undefined;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "Read":
      return undefined; // the Rules engine keys on files; nothing here owns a rule.
    default:
      return undefined;
  }
}
