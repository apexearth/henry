/**
 * "Fill from sessions": one model call that reads what this machine's sessions did and writes the
 * notes worth keeping. Only when asked (a button), never on a timer: a note is a reminder you
 * chose to keep, and a call per turn would cost far more than the reminders are worth.
 *
 * It reads like the coordinator does (coordinator.sessionBrief): prompts asked, repos, files
 * written, the last reply. Never source or diffs. A session is read again only when it has done
 * something since it was last read, so pressing the button twice costs one call, and the model is
 * shown the notes already kept so it does not write them again.
 */
import { isClaudeSession, type ServerMessage, type Session } from "@henry/shared";
import { lastReply, sessionBrief } from "./coordinator";
import * as db from "./db";
import * as notes from "./notes";
import { askBackend } from "./overseer";
import { localHost, sessions } from "./sessions";

const MAX_SESSIONS = 8;
const MAX_PER_SESSION = 2;
const MAX_TEXT = 200;
const TIMEOUT_MS = 120_000;

export const SYSTEM_PROMPT = `You keep a developer's reminders. They run several Claude Code sessions at once and switch between them, and they forget what they meant to keep in mind in one session while they are in another. You are given, for each session that did something since it was last read: its title and id, what the developer asked, which repos and files it touched, the session's last reply, and the notes already kept.

Write the few things the developer must not lose track of: a decision or answer the session is waiting on, something it said must happen next or must not be forgotten, work left uncommitted or unpushed, a caveat in its last reply, a promise to someone. Not a summary of the work, not what is already plainly done, not anything an existing note already says. One line each, under 140 characters, written to the developer ("Decide whether…", "Push…"), naming the concrete thing. At most ${MAX_PER_SESSION} per session; none is the usual answer for a session that is simply progressing.

Answer with a JSON array and nothing else: [{"session": "<id as given>", "text": "<the note>"}]. An empty array is a fine answer.`;

let running = false;

export function isRunning(): boolean {
  return running;
}

/** Running Claude sessions here that did something since they were last read, most recent first. */
export function due(now = Date.now()): Session[] {
  const last = db.lastEventTimes();
  const checked = db.noteChecks();
  const at = (s: Session) => last.get(s.id) ?? s.createdAt;
  return sessions
    .list()
    .filter((s) => s.status === "running" && !s.peer && !s.coordinator && isClaudeSession(s) && at(s) > (checked.get(s.id) ?? 0) && at(s) <= now)
    .sort((a, b) => at(b) - at(a))
    .slice(0, MAX_SESSIONS);
}

export function buildPrompt(list: Session[], now = Date.now()): string {
  const kept = notes.list().filter((n) => !n.deleted);
  const blocks = list.map((s) => {
    const lines = sessionBrief(s, now, 3);
    lines[0] = `id ${s.id.slice(0, 8)}: ${lines[0]}`;
    const reply = lastReply(s);
    if (reply) lines.push(`  last reply: "${reply}"`);
    const mine = kept.filter((n) => n.sessionId === s.id);
    if (mine.length) lines.push(`  notes already kept: ${mine.map((n) => `"${n.text}"`).join("; ")}`);
    return lines.join("\n");
  });
  const loose = kept.filter((n) => !n.sessionId || !list.some((s) => s.id === n.sessionId));
  return [
    `Sessions (${list.length}):`,
    blocks.join("\n\n"),
    loose.length ? `\nOther notes already kept:\n${loose.map((n) => `- ${n.text}`).join("\n")}` : "",
  ].join("\n");
}

/** The model's answer as notes for sessions in `list`. Anything else in it is ignored. */
export function parseAnswer(text: string, list: Session[]): { session: Session; text: string }[] {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: { session: Session; text: string }[] = [];
  const per = new Map<string, number>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { session: id, text: t } = item as { session?: unknown; text?: unknown };
    if (typeof id !== "string" || typeof t !== "string" || !t.trim()) continue;
    const s = list.find((x) => x.id.startsWith(id.trim()) && id.trim().length >= 4);
    if (!s || (per.get(s.id) ?? 0) >= MAX_PER_SESSION) continue;
    per.set(s.id, (per.get(s.id) ?? 0) + 1);
    out.push({ session: s, text: t.trim().slice(0, MAX_TEXT) });
  }
  return out;
}

/** Read what is due and add what the model says to keep. Reports progress through `emit`. */
export async function fill(emit: (msg: ServerMessage) => void, ask: typeof askBackend = askBackend): Promise<void> {
  const host = localHost();
  if (running) return;
  running = true;
  emit({ type: "notes:filling", host, state: "running" });
  try {
    const now = Date.now();
    const list = due(now);
    let added = 0;
    if (list.length) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      let answer: string | undefined;
      try {
        answer = await ask(SYSTEM_PROMPT, buildPrompt(list, now), ctrl.signal);
      } finally {
        clearTimeout(timer);
      }
      for (const n of parseAnswer(answer ?? "", list)) {
        if (notes.add(n.text, host, { id: n.session.id, title: n.session.title })) added++;
      }
      // Only after an answer: a failed call leaves them due, so the next press reads them again.
      for (const s of list) db.setNoteCheck(s.id, now);
    }
    emit({ type: "notes:filling", host, state: "done", checked: list.length, added });
  } catch (e) {
    console.error("[notes] fill failed:", e);
    emit({ type: "notes:filling", host, state: "failed", error: e instanceof Error ? e.message : String(e) });
  } finally {
    running = false;
  }
}
