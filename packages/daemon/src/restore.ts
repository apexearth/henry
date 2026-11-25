// Sessions come back after the machine, or sessiond, went down underneath them. sessions.ts
// decides what died (it alone sees sessiond); this starts each one again in its own row, with its
// topic, and says which were cut off mid-turn rather than continuing them.
import { existsSync } from "node:fs";
import type { Flag, HenryEvent, Session, ServerMessage } from "@henry/shared";
import * as activity from "./activity";
import { config } from "./config";
import * as db from "./db";
import { sessions } from "./sessions";
import * as topics from "./topics";
import { transcriptPathOf } from "./transcript";

/** Between starts, so a dozen Claude processes are not all loading at once. */
const STAGGER_MS = 1_500;

let broadcast: (m: ServerMessage) => void = () => {};

/** After sessions, activity and topics have started: the restarts must not be replayed as old turns. */
export function start(out: (m: ServerMessage) => void): void {
  broadcast = out;
  const lost = sessions.takeLost();
  if (config.restoreSessions === false) return;
  void revive(lost);
  sessions.on("lost", (more) => void revive(more));
}

async function revive(lost: Session[]): Promise<void> {
  // Coordinators first, so each topic has its own back before its members' first prompt.
  const order = [...lost].sort((a, b) => Number(!!b.coordinator) - Number(!!a.coordinator) || a.createdAt - b.createdAt);
  for (const [i, s] of order.entries()) {
    if (i) await Bun.sleep(STAGGER_MS);
    try {
      const claude = s.kind !== "shell";
      const was = claude ? activity.lastActivity(s.id) : undefined;
      // A member keeps its topic as it is: a peer's topic may not be linked yet this early.
      const topic = s.coordinator ? topics.inherit(s, true) : s.topicId ? { topicId: s.topicId } : {};
      const path = claude ? transcriptPathOf(s) : undefined;
      const back = await sessions.respawn(s, { ...topic, resume: !!path && existsSync(path) });
      if (!back) continue;
      console.error(`[restore] ${s.title} (${s.id.slice(0, 8)}) started again${was === "working" || was === "background" || was === "needsInput" ? `; it was ${was} and was not continued` : ""}`);
      if (was === "working" || was === "background" || was === "needsInput") cutOff(back);
    } catch (e) {
      console.error(`[restore] ${s.title} (${s.id.slice(0, 8)}) could not be started again: ${(e as Error).message}`);
    }
  }
}

/** A turn the crash cut off is not run again on its own (it may have been halfway through a
 * deploy), so the session says so where you will look. */
function cutOff(s: Session): void {
  const summary = "was working when Henry went down; started again without continuing. Tell it to carry on.";
  const event: HenryEvent = {
    id: crypto.randomUUID(),
    sessionId: s.id,
    claudeSessionId: s.claudeSessionId,
    ts: Date.now(),
    kind: "system",
    cwd: s.cwd,
    payload: { restored: true },
    severity: "notable",
    rule: "restored",
    summary,
  };
  db.insertEvent(event);
  broadcast({ type: "event", event });
  const flag: Flag = { id: crypto.randomUUID(), eventId: event.id, sessionId: s.id, ts: event.ts, severity: "notable", rule: "restored", summary, read: false };
  db.insertFlag(flag);
  broadcast({ type: "flag", flag });
}
