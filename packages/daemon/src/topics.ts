/**
 * Topics: a named set of sessions working on one subject, each with a coordinator.
 *
 * The user makes a topic and puts sessions in it; a session is in at most one. Making one starts
 * its coordinator, a Claude session in a folder under the Henry home (never a repo) whose extra
 * tools (coordinator.ts) read summaries of the members and write three things: the brief and its
 * notes, membership, and a prompt in a member's input. The brief is Henry's, not the coordinator's
 * memory, so a coordinator can be cleared or restarted and pick up from it.
 *
 * Members learn about the topic without a tool: when the brief, the notes or the member list
 * changed since a member's last prompt, `contextFor` hands the hook the text to add to that
 * prompt. A tool in every session's list would cost every request all day; this costs a few
 * hundred tokens once per change.
 *
 * A coordinator's prompt to a member is a draft unless the user told it to send, and either way
 * it waits for that member's turn to end: typing into a running turn, or into a permission
 * prompt, would answer something nobody meant to. It is labelled as the coordinator's in the
 * text itself, so the member's transcript says where it came from.
 *
 * A topic lives on the machine that made it: its coordinator runs here and its members are this
 * machine's sessions, since the coordinator's tools read summaries this daemon holds. A paired
 * machine's window sees and drives it through the federation link (server.ts routes by topic).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { isClaudeSession, type ServerMessage, type Session, type Topic, type TopicNote, type TopicSuggestion } from "@henry/shared";
import { henryDir } from "./config";
import * as db from "./db";
import { isWindows } from "./platform";
import { sessions, type CreateOptions } from "./sessions";
import { relaySafe } from "./voice";

export const MAX_NAME = 60;
export const MAX_BRIEF = 4_000;
export const MAX_NOTE = 300;
export const MAX_NOTES = 12;
export const MAX_PROMPT = 2_000;
/** What a member is shown of the brief on a prompt; the coordinator's tools see all of it. */
const CONTEXT_BRIEF = 2_500;
/** A queued prompt for a member whose turn never ends is not worth delivering hours later. */
export const DELIVERY_TTL_MS = 30 * 60_000;
const MAX_QUEUED = 3;
/** Between the words and the Enter, so Claude Code reads them as typing rather than a paste
 * that happens to end in a newline. */
const ENTER_DELAY_MS = 150;

/** A coordinator works from summaries: no file or shell tools, and no subagent that would have them.
 * Only names Claude Code has on this platform: a deny rule naming no tool draws a warning at start. */
export const COORDINATOR_DENIED = ["Bash", ...(isWindows ? ["PowerShell"] : []), "Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep", "Agent"];

interface TopicState {
  id: string;
  name: string;
  brief: string;
  createdAt: number;
  updatedAt: number;
}

const topics = new Map<string, TopicState>();
let notes: (TopicNote & { topicId: string })[] = [];
let suggestions: (TopicSuggestion & { topicId: string; dismissed: boolean })[] = [];

let emit: (msg: ServerMessage) => void = () => {};

/** What topics needs from the session manager; tests swap in fakes rather than spawn a claude.
 * Topics follow the live registry, not the DB. */
interface Deps {
  list(): Session[];
  setTopic(id: string, topicId: string | undefined, coordinator?: boolean): void;
  write(id: string, data: string): void;
  kill(id: string): void;
  create(opts: CreateOptions): Promise<Session>;
}
const real: Deps = {
  list: () => sessions.list(),
  setTopic: (id, topicId, coordinator) => sessions.setTopic(id, topicId, coordinator),
  write: (id, data) => sessions.write(id, data),
  kill: (id) => sessions.kill(id),
  create: (opts) => sessions.create(opts),
};
let deps: Deps = real;
const held = () => deps.list();

/** server.ts injects its broadcast; tests inject a collector. */
export function setBroadcast(fn: (msg: ServerMessage) => void): void {
  emit = fn;
}

export function setDepsForTests(fake: Partial<Deps> | null): void {
  deps = fake ? { ...real, ...fake } : real;
}

let started = false;

export function start(): void {
  load();
  if (started) return;
  started = true;
  sessions.on("update", (s) => {
    flush(s.id);
    // A session that joined a topic, exited or was given a topic elsewhere changes what the
    // suggestion chips may say.
    if (suggestions.some((x) => x.sessionId === s.id && !x.dismissed)) changed();
  });
}

function load(): void {
  topics.clear();
  for (const r of db.listOpenTopics()) topics.set(r.id, { id: r.id, name: r.name, brief: r.brief, createdAt: r.created_at, updatedAt: r.updated_at });
  notes = db.listTopicNotes(Date.now()).filter((n) => topics.has(n.topic_id)).map((n) => ({ id: n.id, topicId: n.topic_id, text: n.text, ts: n.ts, expiresAt: n.expires_at ?? undefined }));
  suggestions = db.listTopicSuggestions().filter((s) => topics.has(s.topic_id)).map((s) => ({ topicId: s.topic_id, sessionId: s.session_id, reason: s.reason, ts: s.ts, dismissed: s.dismissed_at != null }));
}

export function resetForTests(): void {
  pending.clear();
  lastContext.clear();
  load();
}

// ---- reading ----

const liveNotes = (topicId: string, now: number) => notes.filter((n) => n.topicId === topicId && (!n.expiresAt || n.expiresAt > now));

/** A session the rail could offer a chip on: here, running, Claude, in no topic. */
const loose = (s: Session | undefined): boolean => !!s && s.status === "running" && !s.topicId && !s.peer && isClaudeSession(s);

export function list(now = Date.now()): Topic[] {
  const byId = new Map(held().map((s) => [s.id, s]));
  return [...topics.values()].map((t) => ({
    ...t,
    notes: liveNotes(t.id, now).map(({ topicId: _t, ...n }) => n),
    suggestions: suggestions
      .filter((s) => s.topicId === t.id && !s.dismissed && loose(byId.get(s.sessionId)))
      .map(({ topicId: _t, dismissed: _d, ...s }) => s),
  }));
}

/** Every session this daemon holds; the coordinator's tools pick from these. */
export function allSessions(): Session[] {
  return held();
}

export function get(id: string): TopicState | undefined {
  return topics.get(id);
}

export function notesOf(topicId: string, now = Date.now()): TopicNote[] {
  return liveNotes(topicId, now).map(({ topicId: _t, ...n }) => n);
}

/** Members, coordinator excluded: running first, then the exited ones still held. */
export function membersOf(topicId: string): Session[] {
  return held()
    .filter((s) => s.topicId === topicId && !s.coordinator)
    .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.createdAt - b.createdAt);
}

export function coordinatorOf(topicId: string): Session | undefined {
  return held().find((s) => s.topicId === topicId && s.coordinator && s.status === "running");
}

/** Sessions on this machine that are in no topic and could be in one. */
export function looseSessions(): Session[] {
  return held().filter((s) => loose(s));
}

function changed(): void {
  emit({ type: "topics:update", topics: list() });
}

// ---- writing ----

export type Result<T = undefined> = { ok: true; value: T } | { ok: false; reason: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (reason: string): Result<never> => ({ ok: false, reason });

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function nameError(name: string, except?: string): string | undefined {
  if (!name) return "a topic needs a name";
  if (name.length > MAX_NAME) return `a topic name is at most ${MAX_NAME} characters`;
  const clash = [...topics.values()].find((t) => t.id !== except && t.name.toLowerCase() === name.toLowerCase());
  return clash ? `there is already a topic called "${clash.name}"` : undefined;
}

/** Make a topic and start its coordinator. `sessionId` joins that session at once. */
export async function create(rawName: string, sessionId?: string, now = Date.now()): Promise<Result<Topic>> {
  const name = oneLine(rawName);
  const bad = nameError(name);
  if (bad) return no(bad);
  const t: TopicState = { id: crypto.randomUUID(), name, brief: "", createdAt: now, updatedAt: now };
  topics.set(t.id, t);
  db.insertTopic(t);
  if (sessionId) join(sessionId, t.id);
  changed();
  try {
    await startCoordinator(t.id);
  } catch (e) {
    console.error(`[topics] coordinator for "${name}" did not start:`, e);
  }
  return ok(list(now).find((x) => x.id === t.id)!);
}

export function rename(topicId: string, rawName: string, now = Date.now()): Result {
  const t = topics.get(topicId);
  if (!t) return no("no such topic");
  const name = oneLine(rawName);
  const bad = nameError(name, topicId);
  if (bad) return no(bad);
  t.name = name;
  t.updatedAt = now;
  db.updateTopic(topicId, { name }, now);
  changed();
  return ok(undefined);
}

export function setBrief(topicId: string, brief: string, now = Date.now()): Result {
  const t = topics.get(topicId);
  if (!t) return no("no such topic");
  const text = brief.trim();
  if (text.length > MAX_BRIEF) return no(`the brief is ${text.length} characters; keep it under ${MAX_BRIEF}`);
  t.brief = text;
  t.updatedAt = now;
  db.updateTopic(topicId, { brief: text }, now);
  changed();
  return ok(undefined);
}

export function addNote(topicId: string, raw: string, minutes?: number, now = Date.now()): Result<TopicNote> {
  if (!topics.has(topicId)) return no("no such topic");
  const text = oneLine(raw);
  if (!text) return no("an empty note says nothing");
  if (text.length > MAX_NOTE) return no(`a note is one line, at most ${MAX_NOTE} characters`);
  if (liveNotes(topicId, now).length >= MAX_NOTES) return no(`the topic already has ${MAX_NOTES} notes; drop one first`);
  const note = { id: crypto.randomUUID().slice(0, 8), topicId, text, ts: now, expiresAt: minutes && minutes > 0 ? now + Math.round(minutes * 60_000) : undefined };
  notes.push(note);
  db.insertTopicNote(note);
  changed();
  const { topicId: _t, ...out } = note;
  return ok(out);
}

export function dropNote(topicId: string, noteId: string): Result {
  const i = notes.findIndex((n) => n.topicId === topicId && n.id === noteId);
  if (i < 0) return no(`no note "${noteId}" in this topic`);
  notes.splice(i, 1);
  db.deleteTopicNote(noteId);
  changed();
  return ok(undefined);
}

/** Put a session in a topic, or in none (null). A coordinator stays with its own topic. */
export function join(sessionId: string, topicId: string | null): Result {
  const s = held().find((x) => x.id === sessionId);
  if (!s) return no("no such session here");
  if (s.peer) return no("that session runs on another machine; a topic's sessions run where the topic does");
  if (s.coordinator) return no("a coordinator belongs to its own topic");
  if (topicId && !topics.has(topicId)) return no("no such topic");
  deps.setTopic(sessionId, topicId ?? undefined);
  if (topicId) db.clearTopicSuggestions(sessionId);
  suggestions = suggestions.filter((x) => x.sessionId !== sessionId || x.dismissed);
  changed();
  return ok(undefined);
}

export function suggest(topicId: string, sessionId: string, reason: string, now = Date.now()): Result {
  if (!topics.has(topicId)) return no("no such topic");
  const s = held().find((x) => x.id === sessionId);
  if (!loose(s)) return no(s?.topicId ? "that session is already in a topic; only the user moves it" : "only a running Claude session in no topic can be suggested");
  const prior = suggestions.find((x) => x.topicId === topicId && x.sessionId === sessionId);
  if (prior?.dismissed) return no("the user already turned that suggestion down");
  const why = oneLine(reason).slice(0, MAX_NOTE);
  if (prior) Object.assign(prior, { reason: why, ts: now });
  else suggestions.push({ topicId, sessionId, reason: why, ts: now, dismissed: false });
  db.upsertTopicSuggestion({ topicId, sessionId, reason: why, ts: now });
  changed();
  return ok(undefined);
}

export function answerSuggestion(topicId: string, sessionId: string, accept: boolean, now = Date.now()): Result {
  const sug = suggestions.find((x) => x.topicId === topicId && x.sessionId === sessionId && !x.dismissed);
  if (!sug) return no("no such suggestion");
  if (accept) return join(sessionId, topicId);
  sug.dismissed = true;
  db.dismissTopicSuggestion(topicId, sessionId, now);
  changed();
  return ok(undefined);
}

/** The coordinator exits, the running members are in no topic, and the row stays as history. */
export function close(topicId: string, now = Date.now()): Result {
  if (!topics.has(topicId)) return no("no such topic");
  for (const s of held()) {
    if (s.topicId !== topicId || s.status !== "running") continue;
    if (s.coordinator) deps.kill(s.id);
    else deps.setTopic(s.id, undefined);
  }
  topics.delete(topicId);
  notes = notes.filter((n) => n.topicId !== topicId);
  suggestions = suggestions.filter((s) => s.topicId !== topicId);
  for (const [to, queue] of pending) pending.set(to, queue.filter((d) => d.topicId !== topicId));
  db.closeTopic(topicId, now);
  changed();
  return ok(undefined);
}

// ---- the coordinator ----

export const coordinatorDir = () => joinPath(henryDir, "coordinator");

/** The flags every coordinator runs with: its instructions, and no file or shell tools. */
function coordinatorArgs(): string[] {
  const dir = coordinatorDir();
  mkdirSync(dir, { recursive: true });
  const promptPath = joinPath(dir, "coordinator-prompt.md");
  writeFileSync(promptPath, COORDINATOR_PROMPT);
  return ["--append-system-prompt-file", promptPath, `--disallowed-tools=${COORDINATOR_DENIED.join(",")}`];
}

/** Start the topic's coordinator unless one is running. One shared folder, so Claude Code asks
 * to trust it once rather than once per topic. */
export async function startCoordinator(topicId: string): Promise<Result<Session>> {
  const t = topics.get(topicId);
  if (!t) return no("no such topic");
  const running = coordinatorOf(topicId);
  if (running) return ok(running);
  const session = await deps.create({ cwd: coordinatorDir(), title: `${t.name} coordinator`, kind: "claude", ...inherit({ topicId, coordinator: true }, true) });
  return ok(session);
}

/**
 * What a new session takes from the one it resumes or forks. A resumed coordinator is its topic's
 * coordinator again (if the topic has none running) and gets the coordinator's flags back; a
 * fork, or a coordinator's double, is only a member; a session whose topic closed gets nothing.
 */
export function inherit(prior: Pick<Session, "topicId" | "coordinator"> | undefined, resumed: boolean): Pick<CreateOptions, "topicId" | "coordinator" | "extraArgs"> {
  const topicId = prior?.topicId;
  if (!topicId || !topics.has(topicId)) return {};
  if (prior.coordinator && resumed && !coordinatorOf(topicId)) return { topicId, coordinator: true, extraArgs: coordinatorArgs() };
  if (prior.coordinator) return {};
  return { topicId };
}

// ---- what a member is told ----

const lastContext = new Map<string, string>();

function ago(ts: number, now: number): string {
  const m = Math.round((now - ts) / 60_000);
  return m < 1 ? "just now" : m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

const STATE: Record<NonNullable<Session["activity"]>, string> = {
  working: "working",
  needsInput: "stopped at a prompt for the user",
  background: "waiting on its own background work",
  waiting: "waiting on the user",
  idle: "idle",
};

/**
 * Text to add to this session's prompt, or undefined when there is nothing new. "New" is the
 * brief, the notes and who else is in the topic; the others' activity changes every minute and
 * would make every prompt carry the topic again.
 */
export function contextFor(sessionId: string, now = Date.now()): string | undefined {
  const s = held().find((x) => x.id === sessionId);
  const t = s?.topicId ? topics.get(s.topicId) : undefined;
  if (!s || !t || s.coordinator) {
    lastContext.delete(sessionId);
    return undefined;
  }
  const others = membersOf(t.id).filter((x) => x.id !== sessionId && x.status === "running");
  const live = liveNotes(t.id, now);
  const key = JSON.stringify([t.id, t.brief, live.map((n) => n.id), others.map((x) => x.id)]);
  if (lastContext.get(sessionId) === key) return undefined;
  lastContext.set(sessionId, key);

  const brief = t.brief.length > CONTEXT_BRIEF ? t.brief.slice(0, CONTEXT_BRIEF) + " …" : t.brief;
  const lines = [
    `[Henry] This session is in the topic "${t.name}"${others.length ? ` with ${others.length} other session${others.length === 1 ? "" : "s"}` : ""}. The topic changed since your last prompt, so here it is. It is background kept by the topic's coordinator, not a request from the user.`,
    brief ? `Brief:\n${brief}` : "Brief: (none yet)",
  ];
  if (live.length) lines.push(`Notes:\n${live.map((n) => `- ${n.text} (${ago(n.ts, now)})`).join("\n")}`);
  if (others.length) {
    lines.push(`Others in the topic: ${others.map((x) => `"${x.title}" (${x.activity ? STATE[x.activity] : "no activity yet"})`).join(", ")}. henry_activity shows what they hold in a repo.`);
  }
  return lines.join("\n");
}

// ---- a coordinator's prompt to a member ----

interface Delivery {
  topicId: string;
  to: string;
  text: string;
  send: boolean;
  at: number;
}

const pending = new Map<string, Delivery[]>();

/** Between turns, with Claude listening: typing now lands in its input and nowhere else. */
const ready = (s: Session) => s.status === "running" && (s.activity === "waiting" || s.activity === "idle");

function deliver(d: Delivery): void {
  deps.write(d.to, d.text);
  if (d.send) setTimeout(() => deps.write(d.to, "\r"), ENTER_DELAY_MS);
}

/** Deliver what waits for this session if its turn is over (on every session update). */
export function flush(sessionId: string, now = Date.now()): void {
  const queue = pending.get(sessionId);
  if (!queue?.length) return;
  const s = held().find((x) => x.id === sessionId);
  const fresh = queue.filter((d) => now - d.at < DELIVERY_TTL_MS);
  if (!s || s.status !== "running" || !fresh.length) {
    pending.delete(sessionId);
    return;
  }
  if (!ready(s)) {
    pending.set(sessionId, fresh);
    return;
  }
  // One at a time: a sent prompt starts a turn, and the next waits for that turn to end. Drafts
  // go in together, since nothing is submitted.
  pending.delete(sessionId);
  for (let i = 0; i < fresh.length; i++) {
    deliver(fresh[i]!);
    if (fresh[i]!.send) {
      if (i + 1 < fresh.length) pending.set(sessionId, fresh.slice(i + 1));
      return;
    }
  }
}

export type PromptOutcome = "drafted" | "sent" | "queued";

/** A coordinator puts `text` in a member's input: a draft, or sent when the user said so. */
export function prompt(coordinatorId: string, targetId: string, raw: string, send: boolean, now = Date.now()): Result<PromptOutcome> {
  const from = held().find((x) => x.id === coordinatorId);
  if (!from?.coordinator || !from.topicId) return no("only a topic's coordinator can do this");
  const t = topics.get(from.topicId);
  const to = held().find((x) => x.id === targetId);
  if (!t || !to || to.topicId !== t.id || to.coordinator) return no(`that session is not in "${t?.name ?? "this topic"}"; only members can be prompted`);
  if (to.status !== "running") return no(`"${to.title}" has exited`);
  if (!isClaudeSession(to)) return no(`"${to.title}" is a terminal with no Claude running in it`);
  const body = relaySafe(raw, MAX_PROMPT);
  if (!body) return no("nothing to say");
  const d: Delivery = { topicId: t.id, to: to.id, text: `[from the "${t.name}" coordinator] ${body}`, send, at: now };
  const queue = pending.get(to.id) ?? [];
  if (!queue.length && ready(to)) {
    deliver(d);
    return ok(send ? "sent" : "drafted");
  }
  if (queue.length >= MAX_QUEUED) return no(`"${to.title}" already has ${MAX_QUEUED} messages waiting for its turn to end`);
  pending.set(to.id, [...queue, d]);
  return ok("queued");
}

export function queuedFor(sessionId: string): number {
  return pending.get(sessionId)?.length ?? 0;
}

// ---- the coordinator's standing instructions ----

export const COORDINATOR_PROMPT = `You are the coordinator of a topic in Henry, the host these Claude Code sessions run in. A topic is a set of sessions the user grouped because their work touches: the same repo, or neighbouring problems. You sit above them, at the user's altitude. You help the user see what is going on across them, keep the topic's brief current, and carry messages between sessions when the user asks.

You work from summaries only: what each session was asked, what it last said, which files it wrote, its git state and commits. You never read source code or diffs, and you have no file or shell tools. Describe work at the level of files, commands, branches and commits.

Your tools:
- henry_topic: start here, and look again before answering, since the members keep working. The brief, the notes, every member with what it is doing, and the sessions in no topic.
- henry_session: one session in more depth: its recent prompts and its last reply.
- henry_brief: rewrite the brief, add a note that expires, or drop one. Members get the brief and notes as added context on their next prompt after a change, so keep the brief short and factual: the goal, decisions made, who owns which area, what is off-limits. It is not a log, and notes are for what is true for a while ("churning packages/shared for the next hour").
- henry_membership: add or remove a session only when the user asked you to. Otherwise suggest one, and the user accepts with a click.
- henry_prompt: put a message in a member's input. It is a draft unless the user's message to you said to send it ("send it", "tell them", "go ahead"); a draft waits for the user to press Enter. Never send on your own judgement. Either way it waits until that member's turn is over.

Which topic you coordinate is in henry_topic's answer. Keep your answers short.
`;
