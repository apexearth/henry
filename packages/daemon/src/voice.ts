// Talking to Henry. The panel records while a key is held, posts the clip here, and this
// module runs the round trip: whisper.cpp transcribes it, the overseer's backend answers it
// over the overseer's own context, and the platform voice (or a configured command) speaks
// the answer back as a WAV.
//
// Two things make the transcription better than a generic assistant's. Henry already knows
// what its sessions and repos are called, so those names go in as whisper's initial prompt
// and bias the decode toward them; and whatever still comes back mangled is matched against
// the same list rather than trusted literally. "Dune versus squid" survives both ways.
//
// Push-to-talk on purpose: the key release ends the utterance, so there is no voice activity
// detection to tune. The panel keeps the capture device open for a minute between holds, with
// its tracks disabled, because opening one costs the first words of whatever you were saying.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { RepoState, Session, VocabTerm, VoiceAction, VoiceContextSlice, VoiceReply, VoiceVocabulary } from "@henry/shared";
import { config } from "./config";
import * as db from "./db";
import * as federation from "./federation";
import * as git from "./git";
import { readHistory } from "./history";
import { askBackend, eventLine, globalHistory, liveSessions, oneLine, safeRepos, sessionDetail, sessionHeader } from "./overseer";
import { STT_INSTALL_HINT, speakSpec } from "./platform";

/** Long enough for a held key, short enough that a stuck one cannot fill the disk. */
export const MAX_CLIP_BYTES = 8 << 20;
const STT_TIMEOUT_MS = 30_000;
const TTS_TIMEOUT_MS = 30_000;
const ANSWER_TIMEOUT_MS = 30_000;
/** whisper takes n_text_ctx/2 tokens of initial prompt; this stays well inside it. */
const BIAS_CHARS = 700;
/** A relayed message is a sentence, not a payload. */
const MAX_RELAY_CHARS = 1_000;
/** Sessions described in detail in one answer's context, across every machine. Each machine
 * offers up to this many of its own and the merge keeps the most recently active. */
const SESSIONS_IN_CONTEXT = 8;
/** How much of the live session's actual conversation rides along (conversationTail). */
const TAIL_TURNS = 8;
const TAIL_BLOCK_CHARS = 1_500;
const TAIL_CHARS = 6_000;
/** A paired daemon that has not answered by then is described from what this one already
 * holds about it (the roster) rather than holding the answer up. */
const PEER_CONTEXT_TIMEOUT_MS = 4_000;
/** Repos named per machine as places a new session can open. */
const REPOS_IN_CONTEXT = 60;

export const SYSTEM_PROMPT = `You are Henry's voice. You speak with the person whose Claude Code sessions you watch, while they work. You are given the event stream, safeguard flags, repo-level git summaries, the current per-session summaries, and the tail of the actual conversation in the session they are working in — what was said, word for word, rather than a summary of it. The sessions may be spread over several machines; each is marked "here" or "on <machine>", and you see all of them the same way, so answer about the whole picture unless they ask about one machine.

Asked for a summary, what is going on, what they should be thinking about, or what they may have forgotten: sweep every session and lead with what needs them — a session waiting on input or asking for them, an unread flag, unpushed or uncommitted work, something that has gone quiet mid-task — before anything that is simply progressing. Name the session for each point.

That conversation carries code, paths and diffs. Speak the prose and describe the code: say what a change does and where it lands, never read symbols, punctuation or paths out character by character. Asked for the end of the last response, give its final point in a sentence or two in your own words, keeping any number, name or question it ended on — and if it ended by asking something, say so, because that is usually why they asked.

Everything you say is spoken aloud, so write to be heard, not read. One to three sentences, under forty words unless asked for more. No markdown, no backticks, no bullet points, no headings. Never speak a file path: say "the git watcher file", not "packages slash daemon slash source slash git dot ts". Never spell out a session id. Use the session's name as the user says it.

The user's words reach you as speech-to-text, so expect transcription errors, especially in names, identifiers and technical terms. The context lists the live sessions, repos and branches by name. When a transcribed word is close to one of those, assume the known name and carry on; do not repeat the garbled version back. Ask a short clarifying question only when two names are equally plausible.

Answer first, context second. If they ask what is happening somewhere, lead with the one thing that matters, then at most two sentences of detail. If little has changed, say so and stop. Never invent activity that is not in the context.

The roster at the top lists every running session and is the only thing you may count from; the detailed blocks below it cover just the most recently active few, so never say how many sessions there are by counting those, and never say a session does not exist because it has no detail. Asked about one that is only on the roster, use what the roster says — where it is and how long it has been quiet — and say plainly that you have no detail on it. "Quiet" there means Henry has not heard from it, which is not the same as nothing happening: a session whose hooks are not reaching Henry looks identical to an idle one, so say it has gone quiet rather than that it is doing nothing.

When the user asks to be taken to a session, put "GO: <session name>" on the first line by itself, copying the name from the context, then say one sentence about what is going on there. Use GO only when they asked to move; answering a question about a session is not a reason to switch them away from what they are looking at.

When the user asks you to tell another session something, or to pass on, relay or send a message, put "TELL: <session name>" on the first line by itself and the message on the lines after it. Write the message in the user's own voice, as an instruction to that session, in the first person: they are talking through you, not about you. Keep their intent and their specifics, drop the speech-to-text noise, and do not add requirements they did not state. Henry types it into that session and leaves it unsent for them to read; the confirmation is spoken for you, so write nothing else. Use TELL only when they asked to pass something on.

When the user asks you to open, start or spin up a new session in a repo or project, put "OPEN: <repo name>" on the first line by itself, copying the name from the list of repos that can be opened, with " on <machine>" after it when the repo is on a paired machine rather than here. If they said what the session should do, write that on the lines after, in the user's own voice and in the first person, as an instruction to the new session, keeping their specifics and dropping the speech-to-text noise; if they gave it no task, write nothing after the first line. Henry starts the session and types the instruction into its prompt unsent; the confirmation is spoken for you, so write nothing else. Use OPEN only when they asked for a session to be opened: a question about a repo is not a reason to open one.`;

/**
 * Every running session on every machine, this machine's most recently active first. What a
 * spoken name is matched against: the roster names all of them, so a GO or a TELL aimed at any
 * of them has to find it, not just the few described in detail.
 */
function allRunning(): Session[] {
  return [...liveSessions(Number.MAX_SAFE_INTEGER), ...federation.peerSessions().filter((s) => s.status === "running")];
}

/** A session's repos wherever it lives: git.ts for a local one, the link's mirror for a peer's. */
function reposOf(s: Session): RepoState[] {
  return s.peer ? federation.linkNamed(s.peer)?.repos[s.id] ?? [] : safeRepos(s.id);
}

/**
 * Everything whisper is told to expect, in the order it would be missed.
 *
 * Words you set yourself come first and are never dropped: they are the ones whisper has no
 * other way to learn ("subsquid" is not a word, and nothing in a repo layout spells it). Then
 * the names of what is open, then the files the session is actually touching.
 */
export async function vocabulary(sessionId?: string): Promise<VocabTerm[]> {
  const out: VocabTerm[] = [];
  const seen = new Set<string>();
  const add = (term: string, source: VocabTerm["source"]) => {
    const key = squash(term);
    if (!key || key.length < 2 || seen.has(key)) return;
    seen.add(key);
    out.push({ term, source });
  };
  for (const w of config.voice.vocabulary ?? []) add(w, "you");
  for (const s of allRunning()) {
    if (s.title) add(s.title, "session");
    for (const r of reposOf(s)) {
      add(r.name, "repo");
      if (r.branch) add(r.branch, "branch");
    }
  }
  if (sessionId) for (const w of await sessionWords(sessionId)) add(w, "file");
  return out;
}

/**
 * whisper's initial prompt, and what did not fit.
 *
 * Phrased as a sentence because that is what biases a language model's decode; a bare list
 * reads as noise to it. The cap is whisper's, not ours (it takes n_text_ctx/2 tokens), but what
 * falls off the end used to do so silently — a word could be absent for no visible reason and
 * no way to find out. Now the overflow is returned so the panel can show it.
 */
export function biasFrom(terms: VocabTerm[]): { prompt: string; used: VocabTerm[]; dropped: VocabTerm[] } {
  if (!terms.length) return { prompt: "", used: [], dropped: [] };
  const lead = "The speaker is a developer talking about these projects and sessions: ";
  const used: VocabTerm[] = [];
  const dropped: VocabTerm[] = [];
  let length = lead.length + 1;
  for (const t of terms) {
    const cost = t.term.length + 2;
    if (length + cost > BIAS_CHARS) dropped.push(t);
    else {
      used.push(t);
      length += cost;
    }
  }
  return { prompt: used.length ? `${lead}${used.map((t) => t.term).join(", ")}.` : "", used, dropped };
}

/** Letters and digits only: "sub-squid", "Sub Squid" and "subsquid" all come down to the same. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Put known words back the way they are spelled.
 *
 * Telling whisper a word exists makes it likelier, not certain: it still writes "sub-squid" for
 * subsquid and "session D" for sessiond, because those are the spellings English suggests. Any
 * run of up to three transcribed words whose letters and digits match a known term is replaced
 * by the term, so the spelling you use is the spelling that reaches the model — and the one that
 * lands in a session when you dictate.
 */
export function canonicalize(text: string, terms: VocabTerm[]): string {
  const byKey = new Map<string, string>();
  for (const t of terms) if (squash(t.term)) byKey.set(squash(t.term), t.term);
  if (!byKey.size) return text;
  const tokens = text.split(/(\s+)/);
  const words = tokens.map((t, i) => (i % 2 === 0 ? t : null));
  for (let i = 0; i < tokens.length; i += 2) {
    for (let n = Math.min(3, (tokens.length - i + 1) / 2); n >= 1; n--) {
      const span = tokens.slice(i, i + n * 2 - 1);
      const joined = span.join("");
      // Punctuation that ends a sentence belongs to the sentence, not to the word.
      const trail = joined.match(/[.,!?;:]+$/)?.[0] ?? "";
      const core = trail ? joined.slice(0, -trail.length) : joined;
      const hit = byKey.get(squash(core));
      if (!hit || squash(core).length < 3) continue;
      words[i] = hit + trail;
      for (let k = i + 1; k < i + n * 2 - 1; k++) words[k] = "";
      i += (n - 1) * 2;
      break;
    }
  }
  return tokens.map((t, i) => (i % 2 === 0 ? (words[i] ?? t) : words[i] === "" ? "" : t)).join("");
}

/**
 * Every running session there is, one line each, on every machine.
 *
 * The detailed blocks below are capped — they cost real tokens each — and for a while that cap
 * *was* the whole list, so a question about a session outside the top few got "I only see eight
 * sessions", which is both wrong and unfalsifiable from the user's side: the rail in front of
 * them plainly showed fifteen. A roster is cheap enough to be complete, so the count is always
 * right and nothing is invisible, while detail stays where the work is.
 *
 * Each line carries how long the session has been quiet, because Henry's idea of "active" is
 * the last hook it received: a session whose hooks are not reaching the daemon looks idle here
 * no matter what is happening inside it, and the model must not describe those as busy.
 */
function roster(seen: Map<string, number>, shown: Set<string>): string {
  const all = allRunning();
  const peers = all.filter((s) => s.peer).length;
  const line = (s: Session) => {
    // A peer's times come with its context slice, which names only its recently active few;
    // one outside that set is quiet by definition, just not measurably so from here.
    const last = seen.get(s.id);
    const quiet = last ? `quiet ${minutes(Date.now() - last)}` : s.peer ? "not among that machine's recently active" : "never reported to Henry";
    const where = s.peer ? `on ${s.peer}` : "here";
    return `  - "${s.title}" (${where}, ${s.cwd}) — ${quiet}${shown.has(s.id) ? ", detailed below" : ""}`;
  };
  if (!all.length) return "";
  const machines = peers ? `${all.length - peers} on this machine and ${peers} on paired machines` : `all on this machine`;
  return `Every running session right now — ${all.length} in total, ${machines}. This list is complete; the detail further down covers only the most recently active:\n${all.map(line).join("\n")}`;
}

const minutes = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

/**
 * What each live session has actually been doing, straight from the event stream.
 *
 * The playbook's summaries read better, but they exist only when the overseer runs, and the
 * overseer is off by default — on a daemon that has never paid for a summary, `globalContext`
 * can offer voice nothing but session titles, which is how you get an assistant that knows
 * your sessions are there and nothing about them. Events are already in SQLite and cost
 * nothing to read, so voice gets them whether or not the playbook is switched on.
 */
function activityLines(sessionId: string): string {
  return db
    .listEvents({ sessionId, limit: 10 })
    .map((e) => `    ${eventLine(e, 140)}`)
    .join("\n");
}

/**
 * What this daemon knows about its own sessions, in the shape every daemon answers
 * `/api/voice/context` with. The same function serves a question asked here and a question
 * asked on a paired machine, which is what makes the two machines' halves of one answer
 * agree: nothing is described differently for being remote.
 */
export async function contextSlice(): Promise<VoiceContextSlice> {
  const seen = db.lastEventTimes();
  const live = liveSessions(SESSIONS_IN_CONTEXT);
  const sessions = live.map((s) => ({ id: s.id, lastEventAt: seen.get(s.id) ?? s.createdAt, detail: sessionDetail(s.id), activity: activityLines(s.id) }));
  const tail = live[0] ? conversationTail(live[0]) : "";
  let repos: VoiceContextSlice["repos"] = [];
  try {
    repos = (await git.listRepos(config.reposRoot)).slice(0, REPOS_IN_CONTEXT).map((r) => ({ name: r.name, path: r.path }));
  } catch {
    // no repos root yet; a session can still be opened by path elsewhere
  }
  return { sessions, tail: live[0] && tail ? { sessionId: live[0].id, text: tail } : undefined, repos };
}

/** Each connected peer's slice, or nothing for one that is slow or broken: the roster already
 * names its sessions, and a machine that cannot answer must not stall the machine that can. */
async function peerSlices(): Promise<{ peer: string; slice: VoiceContextSlice }[]> {
  const asked = federation.connectedLinks().map(async (l) => {
    const timeout = new Promise<undefined>((r) => setTimeout(() => r(undefined), PEER_CONTEXT_TIMEOUT_MS));
    try {
      const res = await Promise.race([l.http("GET", "/api/voice/context"), timeout]);
      if (!res?.ok) return undefined;
      const slice = (await res.json()) as VoiceContextSlice;
      if (!Array.isArray(slice.sessions)) return undefined;
      return { peer: l.rec.name, slice: { ...slice, repos: Array.isArray(slice.repos) ? slice.repos : [] } };
    } catch {
      return undefined;
    }
  });
  return (await Promise.all(asked)).filter((x): x is { peer: string; slice: VoiceContextSlice } => !!x);
}

/** A repo a new session can open in, on whichever machine holds it. */
export interface OpenTarget {
  name: string;
  path: string;
  peer?: string;
}

interface Placed {
  session: Session;
  where: string;
  lastEventAt: number;
  detail: string;
  activity: string;
}

/**
 * Every machine's picture, merged: the most recently active sessions across all of them get
 * the detail, whichever machine they are on, and the single most recent one gets its
 * conversation tail. The roster's times are filled from the same slices, since a link keeps
 * no event history of its own.
 */
async function gather(): Promise<{ placed: Placed[]; seen: Map<string, number>; tail: string; repos: OpenTarget[] }> {
  const [local, peers] = await Promise.all([contextSlice(), peerSlices()]);
  const seen = new Map(db.lastEventTimes());
  const all: Placed[] = [];
  const place = (session: Session, where: string, e: VoiceContextSlice["sessions"][number]) =>
    all.push({ session, where, lastEventAt: e.lastEventAt, detail: e.detail, activity: e.activity });
  for (const e of local.sessions) {
    const session = db.getSession(e.id);
    if (session) place(session, "here", e);
  }
  for (const { peer, slice } of peers) {
    const link = federation.linkNamed(peer);
    for (const e of slice.sessions) {
      const session = link?.sessions.get(e.id);
      if (!session) continue;
      seen.set(e.id, e.lastEventAt);
      place(session, `on ${peer}`, e);
    }
  }
  all.sort((a, b) => b.lastEventAt - a.lastEventAt);
  const placed = all.slice(0, SESSIONS_IN_CONTEXT);
  const top = placed[0];
  const owner = top?.session.peer ? peers.find((p) => p.peer === top.session.peer)?.slice : local;
  const tail = top && owner?.tail?.sessionId === top.session.id ? owner.tail.text : "";
  const repos: OpenTarget[] = [...local.repos, ...peers.flatMap((p) => p.slice.repos.map((r) => ({ ...r, peer: p.peer })))];
  return { placed, seen, tail, repos };
}

function detailBlocks(placed: Placed[]): string {
  if (!placed.length) return "";
  const blocks = placed.map((p) => `${sessionHeader(p.session, p.where)}\n${p.detail}`);
  return `Detail on the ${placed.length} most recently active sessions:\n\n${blocks.join("\n\n")}`;
}

function activityBlocks(placed: Placed[]): string {
  const blocks = placed.filter((p) => p.activity).map((p) => `  "${p.session.title}" (${p.where}, newest first):\n${p.activity}`);
  return blocks.length ? `Recent activity per session, newest first:\n${blocks.join("\n")}` : "";
}

/** The repos a new session can be opened in, per machine, for OPEN to copy a name from. */
function openable(repos: OpenTarget[]): string {
  if (!repos.length) return "";
  const byMachine = new Map<string, string[]>();
  for (const r of repos) {
    const key = r.peer ? `on ${r.peer}` : "here";
    byMachine.set(key, [...(byMachine.get(key) ?? []), r.name]);
  }
  return `Repos a new session can be opened in — ${[...byMachine].map(([where, names]) => `${where}: ${names.join(", ")}`).join("; ")}.`;
}

/**
 * The tail of what was actually said in a session, for "what did it just tell me" and "read me
 * the end of that answer" — questions the event stream cannot answer, because a summary of a
 * turn is not the turn.
 *
 * Only for the session at the top of the activity order: a conversation tail is the most
 * expensive thing in this context by an order of magnitude, and "the last response" almost
 * always means the one in the session being worked in. Thinking blocks are dropped (they are
 * not what anyone means by the response) and tool calls collapse to their name.
 */
function conversationTail(session: Session): string {
  let turns;
  try {
    // Read wider than we keep: readHistory's limit counts sidechain lines too, and a turn that
    // just ran a subagent can fill the whole window with them.
    ({ turns } = readHistory(session.id, TAIL_TURNS * 4));
  } catch {
    return "";
  }
  const lines: string[] = [];
  let budget = TAIL_CHARS;
  for (const turn of turns.filter((t) => !t.sidechain).slice(-TAIL_TURNS)) {
    const parts: string[] = [];
    for (const b of turn.blocks) {
      if (b.kind === "thinking") continue;
      if (b.kind === "tool") parts.push(`(ran ${b.name ?? "a tool"})`);
      else if (b.kind === "result") parts.push(`(result: ${oneLine(b.text, 160)})`);
      else {
        const clipped = oneLine(b.text, Math.min(budget, TAIL_BLOCK_CHARS));
        budget -= clipped.length;
        parts.push(clipped);
        if (budget <= 0) break;
      }
    }
    const said = parts.filter(Boolean).join(" ").trim();
    if (!said) continue;
    lines.push(`  ${turn.role === "user" ? "you" : "it"}: ${said}`);
    if (budget <= 0) break;
  }
  if (!lines.length) return "";
  return `The most recent exchange in "${session.title}", oldest first. This is the actual conversation, not a summary:\n${lines.join("\n")}`;
}

async function run(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { ok: code === 0, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The words a session is currently about: the basenames of the files it has touched, minus
 * their extensions. Dictated speech is aimed at an agent working in one repo, and "FilePicker"
 * or "sessiond" only survive transcription if whisper has been told they are words.
 */
async function sessionWords(sessionId: string): Promise<string[]> {
  try {
    const { repos } = await git.sessionFiles(sessionId);
    const words = new Set<string>();
    for (const r of repos) {
      for (const f of r.files.slice(0, 40)) {
        const base = f.path.split("/").pop()?.replace(/\.[^.]+$/, "");
        if (base && base.length > 2) words.add(base);
      }
    }
    return [...words];
  } catch {
    return [];
  }
}

/** 16 kHz mono WAV in, text out. The panel does the resampling, because the browser already
 * has an AudioContext and the daemon would otherwise need ffmpeg on two platforms.
 * `sessionId` (dictation) adds that session's own vocabulary to the bias. */
export async function transcribe(wav: Uint8Array, sessionId?: string): Promise<string> {
  const model = config.voice.sttModel;
  if (!model) throw new Error("voice.sttModel is not set");
  // Enforced here rather than at the route, so every path into whisper is capped.
  if (wav.byteLength > MAX_CLIP_BYTES) throw new Error("clip too long");
  const dir = mkdtempSync(join(tmpdir(), "henry-voice-"));
  const clip = join(dir, "clip.wav");
  try {
    await Bun.write(clip, wav);
    const terms = await vocabulary(sessionId);
    const { prompt } = biasFrom(terms);
    const args = ["-m", model, "-f", clip, "-l", "en", "-nt", "-np"];
    if (prompt) args.push("--prompt", prompt);
    const { ok, stdout, stderr } = await run(config.voice.stt, args, STT_TIMEOUT_MS);
    if (!ok) throw new Error(`${config.voice.stt} failed: ${stderr.trim().split("\n").pop() ?? "no output"}`);
    // -nt still leaves blank lines and whisper's bracketed non-speech markers ([BLANK_AUDIO]).
    const heard = stdout.replace(/\[[A-Z_ ]+\]/g, " ").replace(/\s+/g, " ").trim();
    // Biasing makes a word likelier, not certain; this puts the ones it still mis-spells back.
    return canonicalize(heard, terms);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The answer as WAV bytes. A configured `tts` command reads text on stdin and writes a WAV on
 * stdout (that is how Kokoro and Piper are wired in); otherwise the platform voice writes a file. */
export async function speak(text: string): Promise<Uint8Array> {
  const custom = config.voice.tts?.trim();
  if (custom) {
    const [command, ...args] = custom.split(/\s+/);
    const proc = Bun.spawn([command!, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), TTS_TIMEOUT_MS);
    try {
      proc.stdin.write(text);
      await proc.stdin.end();
      const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0 || !out.byteLength) throw new Error(`${command} failed: ${err.trim().split("\n").pop() ?? "no audio"}`);
      return new Uint8Array(out);
    } finally {
      clearTimeout(timer);
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "henry-say-"));
  const out = join(dir, "say.wav");
  try {
    const spec = speakSpec(text, out, config.voice.ttsVoice);
    const { ok, stderr } = await run(spec.command, spec.args, TTS_TIMEOUT_MS);
    if (!ok) throw new Error(`${spec.command} failed: ${stderr.trim().split("\n").pop() ?? "no audio"}`);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What is safe to put in another session's prompt.
 *
 * "Henry types it, you press Enter" is the whole basis on which a relay is allowed at all, and
 * nothing downstream enforces it: `pty:input` is a raw write, so a single CR or LF in the
 * message *is* the Enter. A multi-line TELL is a shape the model is asked for, so this is not
 * hypothetical. Every C0 control goes — CR, LF and tab to a space, the rest dropped, which also
 * takes escape sequences with it — and the result is capped: a relay is a sentence, not a payload.
 *
 * It matters more than it looks, because the context this text is written from now includes the
 * live session's transcript, and a transcript carries tool results: file contents, command
 * output, fetched pages. Anything Henry can read can try to say "TELL:". The stripping and the
 * cap are what keep the worst case at "a strange sentence appears in your prompt, unsent".
 */
export function relaySafe(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, MAX_RELAY_CHARS);
}

/**
 * A directive on the first line, if there is one; everything else is spoken. "GO: <name>" moves
 * the user to a session, "TELL: <name>" relays the lines beneath it into one, "OPEN: <repo>"
 * starts a session there with the lines beneath it (if any) as its first, unsent prompt.
 */
export function parseAnswer(text: string): { spoken: string; go?: string; tell?: { name: string; message: string }; open?: { name: string; message: string } } {
  const lines = text.trim().split("\n");
  const first = lines[0] ?? "";
  const rest = () => lines.slice(1).join("\n").trim();
  const go = first.match(/^GO:\s*(.+?)\s*$/i);
  if (go) return { spoken: rest(), go: go[1] };
  const tell = first.match(/^TELL:\s*(.+?)\s*$/i);
  if (tell) return { spoken: "", tell: { name: tell[1]!, message: rest() } };
  const open = first.match(/^OPEN:\s*(.+?)\s*$/i);
  if (open) return { spoken: "", open: { name: open[1]!, message: rest() } };
  return { spoken: text.trim() };
}

/**
 * Which of several named things a spoken name means. Exact name first, then containment either
 * way (whisper drops and adds small words), then the best word overlap — "dune versus squid"
 * still finds "dune vs squid" when nothing matched literally.
 */
export function matchNamed<T>(name: string, items: T[], nameOf: (t: T) => string): T | undefined {
  const want = norm(name);
  if (!want) return undefined;
  // A name of only emoji or CJK normalizes to "", and "".includes() of it is true for every
  // input — one such session would otherwise capture every GO and every relay.
  const named = items.filter((t) => norm(nameOf(t)));
  const exact = named.find((t) => norm(nameOf(t)) === want);
  if (exact) return exact;
  const contains = named.find((t) => norm(nameOf(t)).includes(want) || want.includes(norm(nameOf(t))));
  if (contains) return contains;
  const wanted = new Set(words(want));
  let best: { t: T; score: number } | undefined;
  for (const t of named) {
    const score = words(norm(nameOf(t))).filter((w) => wanted.has(w)).length;
    if (score && (!best || score > best.score)) best = { t, score };
  }
  return best?.t;
}

export function matchSession(name: string, live: Session[]): Session | undefined {
  return matchNamed(name, live, (s) => s.title);
}

/**
 * Which repo, on which machine, an OPEN names. A trailing "on <machine>" is honoured only when
 * it names a paired machine (anything else is part of the spoken name, mangled or not); without
 * one the same name on two machines picks this one, since `repos` lists it first.
 */
export function resolveOpen(name: string, repos: OpenTarget[], peers: string[]): OpenTarget | undefined {
  const m = name.match(/^(.*\S)\s+on\s+(\S+)$/i);
  const peer = m && peers.find((p) => p.toLowerCase() === m[2]!.toLowerCase());
  const want = peer ? m![1]! : name;
  const pool = peer ? repos.filter((r) => r.peer === peer) : repos;
  return matchNamed(want, pool, (r) => r.name);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
/** "vs" and "versus" are the same word to a listener, and whisper picks whichever it likes. */
const words = (s: string) => s.split(" ").filter((w) => w.length > 1 && w !== "the").map((w) => (w === "versus" ? "vs" : w));

/**
 * Answer a question that has already been transcribed.
 *
 * Separate from `transcribe` on purpose: the ear takes about a second and the answer takes
 * several, so the panel asks for them in two calls and can show you what it heard while it is
 * still working out what to say. A single round trip would hold the transcript hostage to the
 * slowest part of the turn.
 */
export async function answer(transcript: string): Promise<VoiceReply> {
  const { placed, seen, tail, repos } = await gather();
  const live = allRunning();
  const context = [
    roster(seen, new Set(placed.map((p) => p.session.id))),
    detailBlocks(placed),
    globalHistory(),
    activityBlocks(placed),
    tail,
    openable(repos),
    `The user just said (speech-to-text): ${oneLine(transcript, 1000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANSWER_TIMEOUT_MS);
  let answer: string | undefined;
  try {
    answer = await askBackend(SYSTEM_PROMPT, context, ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
  if (!answer?.trim()) return { text: "", reason: "no answer" };

  const { spoken, go, tell, open } = parseAnswer(answer);
  let action: VoiceAction | undefined;
  let confirmation: string | undefined;
  if (go) {
    const target = matchSession(go, live);
    if (target) action = { kind: "switch", sessionId: target.id, title: target.title };
  } else if (tell?.message) {
    const target = matchSession(tell.name, live);
    const message = relaySafe(tell.message);
    if (target && message) {
      action = { kind: "type", sessionId: target.id, title: target.title, text: message };
      // Spoken here rather than by the model: it is a statement about what Henry just did, and
      // it has to be true. It also has to say the message is not sent yet.
      confirmation = `Put that to ${target.title}. Read it and press enter to send.`;
    } else {
      confirmation = `I could not find a session called ${tell.name}.`;
    }
  } else if (open) {
    const target = resolveOpen(open.name, repos, federation.connectedLinks().map((l) => l.rec.name));
    if (target) {
      // The first prompt is a relay in every way that matters: typed by Henry, sent by you.
      const text = relaySafe(open.message) || undefined;
      action = { kind: "open", cwd: target.path, title: target.name, peer: target.peer, text };
      const where = target.peer ? ` on ${target.peer}` : "";
      confirmation = text ? `Opening ${target.name}${where}. Your instruction goes in once Claude is up, unsent; press enter to send it.` : `Opening a new session in ${target.name}${where}.`;
    } else {
      confirmation = `I could not find a repo called ${open.name}.`;
    }
  }
  // A directive that matched nothing leaves `spoken` empty; speaking `answer` there would read
  // the directive itself out loud ("GO colon the indexer").
  const text = confirmation || spoken || (action ? `Switching you to ${action.title}.` : go || tell ? `I could not find a session called ${go ?? tell?.name}.` : answer.trim());

  // Speech is the nice-to-have: a voice that failed still answers in the panel.
  let audio: string | undefined;
  let reason: string | undefined;
  try {
    audio = Buffer.from(await speak(text)).toString("base64");
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  return { text, action, audio, reason };
}

/** Why voice is unavailable, for the panel to show instead of a dead button. */
export function unavailable(): string | undefined {
  if (!config.voice.enabled) return "voice is off (set voice.enabled in config.json)";
  if (!config.voice.sttModel) return "no speech model (set voice.sttModel to a whisper.cpp ggml file)";
  // An absolute path is not on PATH and does not need to be; `includes("/")` alone called every
  // Windows install broken and told the user to run brew.
  if (!Bun.which(config.voice.stt) && !isAbsolute(config.voice.stt)) return `${config.voice.stt} is not on PATH (${STT_INSTALL_HINT})`;
  return undefined;
}

/** What the ear is primed with right now, for the panel's vocabulary view. */
export async function vocabularyView(sessionId?: string): Promise<VoiceVocabulary> {
  return biasFrom(await vocabulary(sessionId));
}

export function status(): { ready: boolean; reason?: string } {
  const reason = unavailable();
  return { ready: !reason, reason };
}
