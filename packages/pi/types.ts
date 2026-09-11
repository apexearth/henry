// The Pi harness: Henry shares the lifecycle entry point Claude Code uses. Henry owns the PTYs,
// and a Pi session's frames flow through the same ring as a Claude session's, so this file is
// only the harness-specific parts: how the extension emits and how Henry maps those emissions
// ("Bash"/"Read"/"Edit"/"Write"/"Prompt-submit"/"Settle"/"New"/"Compaction" -> Henry events).
import type { Severity, Session } from "@henry/shared";

export type HarnessKind = "claude" | "pi";

// ---- harness identity ------------------------------------------------------

export const piKind: SessionKind = "pi":
export const isPiSession = (s: Pick<Session, "kind" | "claudeActive">): boolean => s.kind === piKind;

/** The Pi symbol (the same hue/ordering as the Claude mark, but unmistakably Pi). */
export const piColor = "#9D7EDC";
