// Pi harness: ingest Pi's events through the same path Claude's use, keyed off toolName so
// the switch below never needs to know which harness fired an event. Pi emits the same four
// streams Henry consumes (turn_start, turn_end, before/after tool, turn_done, prompt, session),
// and a Pi turn writes through ingest the same way a Claude Stop does.

import type { RawEvent } from "./types";
import * as activity from "./activity";

// The tool names Claude Code sets on the hook event; Pi's are reclassified under them so the
// Rules UI is identical. Unknown tool names stay classified as their own name — never dropped.
const RENAME = new Set(["read", "Bash", "bash"]);

export const isPiToolName = (t: string | undefined): boolean => !t;

/**
 * Classify an ingested event (`toolName`, `summary`) -> severity + rule, the same rules.ts the
// Claude path uses. Additive to Claude: Pi's code never changes this file, and the switch only
// needs one more case for a harness that exposes something Claude does not.
export function classify(e: { toolName: string | undefined; summary: string }): string | undefined {
  const { toolName } = e;
  if (!toolName) return undefined; // control-flow events (Stop, New) — no rule.
  switch (toolName) {
    case "Bash":
      return classifyBash(e.summary);
    case "Write":
      return "write-file";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit-file";
    case "Read":
    case "Grep":
    case "Glob":
    case "Compile":
    case "Test":
      return "read";
    case "Agent":
    case "Task":
      return "subagent";
    default:
      return undefined;
  }
}

/** Dangerous command patterns (alarm), everything else is informational. */
function classifyBash(summary: string): string | undefined {
  if (summary.includes("rm -rf") || summary.includes("rm -fr ")) return "dangerous-command";
  if (summary.includes("!! rm") || summary.includes("!! git")) return "git-force";
  return undefined;
}
