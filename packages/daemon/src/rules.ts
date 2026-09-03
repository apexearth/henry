// Milestone 4: rules engine. Classify hook + git events with config.rules (alarm/notable
// substrings, protected branches, cross-repo writes, commit-on-protected). Never blocks.
import type { HenryEvent, Severity } from "@henry/shared";

export interface Classification {
  severity: Severity;
  rule?: string;
}

export function classify(_event: HenryEvent): Classification {
  return { severity: "info" };
}
