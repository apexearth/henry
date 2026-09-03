// Milestone 2: POST /hook and POST /statusline ingest. Bind HENRY_SESSION <-> claude session_id
// (sessions.bindClaudeSession), write HenryEvents (db.insertEvent), run rules.classify,
// broadcast {type:"event"} / {type:"flag"}, store statusline usage (db.insertUsageSnapshot)
// and broadcast {type:"usage:update"}.
import type { Flag, HenryEvent, Usage } from "@henry/shared";

export interface IngestResult {
  event?: HenryEvent;
  flag?: Flag;
}

/** Body of POST /hook: Claude Code hook JSON plus `henrySession` (HENRY_SESSION) and `henryHookEvent`. */
export function ingestHook(payload: unknown): IngestResult {
  console.log("[hook] (stub)", summarize(payload));
  return {};
}

/** Body of POST /statusline: the statusline JSON Claude Code hands to the status command. */
export function ingestStatusline(payload: unknown): Usage | undefined {
  console.log("[statusline] (stub)", summarize(payload));
  return undefined;
}

function summarize(p: unknown): string {
  const s = JSON.stringify(p);
  return s && s.length > 200 ? s.slice(0, 200) + "…" : String(s);
}
