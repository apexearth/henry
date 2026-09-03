// Milestone 2: tail ~/.claude/projects/<slug>/<claude_session_id>.jsonl for usage totals
// (db.upsertSessionUsage -> {type:"usage:update"}), tool detail, and subagent sessions.
import type { Session } from "@henry/shared";

export function startTailing(_session: Session): void {}

export function stopTailing(_sessionId: string): void {}
