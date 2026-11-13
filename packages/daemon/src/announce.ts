// Henry says what just happened. When notify.ts decides a session finished or needs you, a
// small model reads the end of that session's conversation and writes one spoken line — what
// it did, or what it wants from you — and the notice goes out again carrying the line and its
// audio. The chime has already rung by then; this is the sentence after it.
//
// Off unless `voice.announce`: it is a model call per finished turn. Reading the transcript is
// the same reading voice.ts does for "what did it just say"; it never reads source or diffs
// beyond what the conversation itself quoted.
import type { Notice, ServerMessage } from "@henry/shared";
import { config } from "./config";
import { askBackend } from "./overseer";
import { sessions } from "./sessions";
import { conversationTail, speak } from "./voice";

/** The Stop hook can beat the transcript's last line to disk. */
const SETTLE_MS = 1_500;
const TIMEOUT_MS = 25_000;

export const SYSTEM_PROMPT = `You tell a developer, out loud, what one of their Claude Code sessions just did. They were looking elsewhere; a chime has just told them that this session stopped. You are given the end of its conversation and why it stopped.

Say one sentence, under twenty-five words, to be heard rather than read. If it is waiting on them — a question, a choice, a permission prompt, a plan to approve — say what it needs from them. Otherwise say the result: what got done, or what went wrong. Keep the one number, name or decision that matters. Start with the substance, not with the session's name or "it has finished". No markdown, no file paths, no code, no quotes.`;

const WHY: Record<Notice["kind"], string> = {
  needsInput: "It is showing a permission prompt or a question and is blocked until they answer.",
  waiting: "It finished its turn and is waiting for their next message.",
  ask: "It asked for them by name.",
  remind: "",
};

let emit: (msg: ServerMessage) => void = () => {};
export function setBroadcast(fn: (msg: ServerMessage) => void): void {
  emit = fn;
}

/** Latest wins per session: a newer notice makes the older line stale before it is spoken. */
const inFlight = new Map<string, AbortController>();

export function onNotice(n: Notice): void {
  if (!config.voice.announce || n.kind === "remind" || n.peer || n.said) return;
  inFlight.get(n.sessionId)?.abort();
  const ctrl = new AbortController();
  inFlight.set(n.sessionId, ctrl);
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  void say(n, ctrl.signal)
    .catch((e) => {
      if (!ctrl.signal.aborted) console.warn(`[announce] ${e instanceof Error ? e.message : e}`);
    })
    .finally(() => {
      clearTimeout(timer);
      if (inFlight.get(n.sessionId) === ctrl) inFlight.delete(n.sessionId);
    });
}

async function say(n: Notice, signal: AbortSignal): Promise<void> {
  await Bun.sleep(SETTLE_MS);
  const s = sessions.get(n.sessionId);
  if (!s || signal.aborted) return;
  const tail = conversationTail(s);
  if (!tail) return;
  const user = [tail, `Why it stopped: ${WHY[n.kind]}${n.kind === "ask" ? ` Its words: ${n.body}` : ""}`].join("\n\n");
  const line = (await askBackend(SYSTEM_PROMPT, user, signal, config.voice.announceModel ?? "claude-haiku-5-5"))?.trim().split("\n")[0]?.trim();
  if (!line || signal.aborted) return;
  let audio: string | undefined;
  try {
    audio = Buffer.from(await speak(line)).toString("base64");
  } catch (e) {
    console.warn(`[announce] no voice: ${e instanceof Error ? e.message : e}`);
  }
  if (signal.aborted) return;
  emit({ type: "notify", notice: { ...n, said: line, ...(audio ? { audio } : {}) } });
}
