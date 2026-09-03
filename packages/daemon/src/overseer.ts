// Milestone 5: playbook writer. Backends: Anthropic API (ANTHROPIC_API_KEY) or headless
// `claude -p`; config.overseer picks. Reads events/flags/git summaries/ACTIVE-WORK.md, never
// code. Writes db.insertPlaybook and broadcasts {type:"playbook:update"}.
import type { Flag, PlaybookEntry } from "@henry/shared";

export async function onStop(_sessionId: string): Promise<PlaybookEntry | undefined> {
  return undefined;
}

export async function onFlag(_flag: Flag): Promise<PlaybookEntry | undefined> {
  return undefined;
}

export async function writeManual(_sessionId: string | null, _prompt: string): Promise<PlaybookEntry | undefined> {
  return undefined;
}
