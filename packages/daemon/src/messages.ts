// Sessions messaging each other, on this machine or one paired with it: `henry_sessions` lists
// who can be reached, `henry_message` puts a line in one's input. A message waits for the
// recipient's turn to end (topics.ts's queue, shared with a coordinator's prompts), and it is
// labelled with its sender in the text itself, so the recipient's transcript and the user, who
// sees it typed into the terminal, both know where it came from and where an answer goes.
//
// Submitted, not drafted: the point is agents working together without the user carrying every
// line. What keeps two of them from driving each other all night is a cap on what any one
// session is sent: past MESSAGES_PER_HOUR its messages go in as drafts the user sends or drops.
//
// A message to a session on a paired machine is a POST over the link (/api/message), checked by
// that machine: it delivers only to its own sessions, and it names the sender's machine from the
// link the request came in on, never from the request. Coordinators neither send nor receive:
// they speak for the user, and their own tools say when.
import { isClaudeSession, type Session } from "@henry/shared";
import * as federation from "./federation";
import { activityPhrase, type CallContext, type ToolDef } from "./mcp";
import { localHost, sessions } from "./sessions";
import * as topics from "./topics";
import { relaySafe } from "./voice";

export const MAX_MESSAGE = 2_000;
const MAX_TITLE = 80;
/** Submitted per recipient per hour; past it, drafts. */
export const MESSAGES_PER_HOUR = 20;
const MAX_QUEUED = 5;
const MAX_LISTED = 40;
const HOUR = 60 * 60_000;
/** Under Claude Code's 60 s for an MCP call. */
const PEER_TIMEOUT_MS = 15_000;

export interface Deps {
  local(): Session[];
  peerSessions(): Session[];
  /** This machine's name as its own sessions are labelled. */
  me(): string;
  queue(to: Session, text: string, send: boolean): topics.Result<topics.PromptOutcome>;
  /** POST /api/message to that machine, or undefined when it is not connected. */
  post(machine: string, body: unknown): Promise<Response> | undefined;
}

const real: Deps = {
  local: () => sessions.list(),
  peerSessions: () => federation.peerSessions(),
  me: () => localHost(),
  queue: (to, text, send) => topics.queueText(to, text, send, MAX_QUEUED),
  post: (machine, body) => federation.linkNamed(machine)?.http("POST", "/api/message", JSON.stringify(body)),
};
let deps = real;

export function setDepsForTests(d: Partial<Deps> | null): void {
  deps = d ? { ...real, ...d } : real;
  received.clear();
}

/** When each session was last sent a submitted message, for MESSAGES_PER_HOUR. */
const received = new Map<string, number[]>();

const reachable = (s: Session) => s.status === "running" && isClaudeSession(s) && !s.coordinator;

function caller(ctx: CallContext): Session {
  const s = deps.local().find((x) => x.id === ctx.sessionId);
  if (!s) throw new Error("Henry could not tell which session is calling; messages are for sessions Henry started");
  if (s.coordinator) throw new Error("a coordinator reaches its members with henry_prompt");
  return s;
}

const tag = (s: Session) => `"${s.title}" [${s.id.slice(0, 8)}]`;

// ---- henry_sessions ----

export const sessionsTool: ToolDef = {
  name: "henry_sessions",
  description:
    "The Claude Code sessions you can message with henry_message, on this machine and on machines paired with it: title, id, machine, working directory and whether they are working or waiting.",
  inputSchema: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Only sessions whose title, machine or folder contains this." },
    },
  },
  run: async (args, ctx) => directory(typeof args.filter === "string" ? args.filter : "", ctx),
};

export function directory(filter: string, ctx: CallContext, now = Date.now()): string {
  const me = caller(ctx);
  const here = deps.me();
  const want = filter.trim().toLowerCase();
  const all = [...deps.local().map((s) => ({ s, on: here })), ...deps.peerSessions().map((s) => ({ s, on: s.peer ?? "?" }))]
    .filter(({ s }) => s.id !== me.id && reachable(s))
    .filter(({ s, on }) => !want || [s.title, on, s.cwd].some((v) => v.toLowerCase().includes(want)));
  const head = `You are ${tag(me)} on ${here}.`;
  if (!all.length) return `${head} No other session ${want ? `matches "${filter.trim()}"` : "is running"}.`;
  const lines = all.slice(0, MAX_LISTED).map(({ s, on }) => `- ${tag(s)} on ${on}${on === here ? " (this machine)" : ""} · ${s.cwd} · ${activityPhrase(s, now)}`);
  if (all.length > MAX_LISTED) lines.push(`(${all.length - MAX_LISTED} more; narrow it with filter)`);
  return [head, ...lines].join("\n");
}

// ---- henry_message ----

export const messageTool: ToolDef = {
  name: "henry_message",
  description:
    "Send another Claude Code session a message, on this machine or a paired one (henry_sessions lists them). It is typed into that session's input when its current turn ends, marked as from you, and its answer comes back to you the same way. For working together: a question, a handoff, where a file is. Do not answer just to acknowledge.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "The session's id (or its first 8 characters) or its exact title." },
      text: { type: "string", description: "The message; one paragraph, newlines become spaces." },
    },
    required: ["to", "text"],
  },
  run: (args, ctx) => send(args, ctx),
};

/** Exact title or id prefix, never a guess: a message to the wrong session is worse than none. */
function recipient(raw: string, me: Session): { s: Session; on?: string } | string {
  const want = raw.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const pool = [...deps.local(), ...deps.peerSessions()].filter((s) => s.id !== me.id && reachable(s));
  const byId = want.length >= 4 ? pool.filter((s) => s.id.toLowerCase().startsWith(want)) : [];
  const hits = byId.length ? byId : pool.filter((s) => s.title.toLowerCase() === want);
  if (hits.length === 1) return { s: hits[0]!, on: hits[0]!.peer };
  if (hits.length > 1) return `"${raw}" names ${hits.length} sessions (${hits.slice(0, 5).map((s) => `${tag(s)} on ${s.peer ?? deps.me()}`).join(", ")}); give the id`;
  return `no running session "${raw}" to message; henry_sessions lists them`;
}

const label = (from: { title: string; id: string }, machine: string | undefined) =>
  `[message from "${from.title}" [${from.id.slice(0, 8)}]${machine ? ` on ${machine}` : ""}; answer it with henry_message to "${from.id.slice(0, 8)}"]`;

export async function send(args: Record<string, unknown>, ctx: CallContext): Promise<string> {
  const me = caller(ctx);
  const body = relaySafe(typeof args.text === "string" ? args.text : "", MAX_MESSAGE);
  const to = typeof args.to === "string" ? args.to : "";
  if (!to || !body) throw new Error("to and text are required");
  const r = recipient(to, me);
  if (typeof r === "string") throw new Error(r);
  if (!r.on) return said(r.s, deliver(r.s, `${label(me, undefined)} ${body}`));

  const pending = deps.post(r.on, { from: me.id, fromTitle: me.title, to: r.s.id, text: body });
  if (!pending) throw new Error(`${r.on} is not connected`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const res = await Promise.race([
    pending,
    new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error(`${r.on} did not answer in ${PEER_TIMEOUT_MS / 1000}s`)), PEER_TIMEOUT_MS))),
  ]).finally(() => clearTimeout(timer));
  const out = (await res.json().catch(() => ({}))) as { outcome?: topics.PromptOutcome; error?: string };
  if (!res.ok || !out.outcome) throw new Error(`${r.on}: ${out.error ?? `HTTP ${res.status}`}`);
  return said(r.s, { ok: true, value: out.outcome });
}

function said(to: Session, r: topics.Result<topics.PromptOutcome>): string {
  if (!r.ok) throw new Error(r.reason);
  const who = `${tag(to)}${to.peer ? ` on ${to.peer}` : ""}`;
  switch (r.value) {
    case "sent":
      return `sent to ${who}; its answer comes to you as a message.`;
    case "queued":
      return `${who} is mid-turn; it gets the message when the turn ends (Henry gives up after ${topics.DELIVERY_TTL_MS / 60_000}m).`;
    case "drafted":
      return `${who} has had ${MESSAGES_PER_HOUR} messages this hour, so this one waits in its input for the user to send.`;
  }
}

/** Into a session here: submitted unless it has had its hour's worth. */
function deliver(to: Session, text: string, now = Date.now()): topics.Result<topics.PromptOutcome> {
  const recent = (received.get(to.id) ?? []).filter((at) => now - at < HOUR);
  const submit = recent.length < MESSAGES_PER_HOUR;
  const r = deps.queue(to, text, submit);
  if (r.ok && submit) recent.push(now);
  received.set(to.id, recent);
  if (r.ok) console.log(`[message] -> ${to.title} [${to.id.slice(0, 8)}] (${r.value})`);
  return r;
}

/** A session on `machine` messages one here (/api/message). Only this daemon's own sessions take
 * one, and the sender is named by the link it came over: a title the peer sends is used only when
 * this machine has no view of that session. */
export function fromPeer(machine: string, b: { from?: unknown; fromTitle?: unknown; to?: unknown; text?: unknown }): topics.Result<topics.PromptOutcome> {
  const from = typeof b.from === "string" ? b.from.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) : "";
  if (!from || typeof b.to !== "string" || typeof b.text !== "string") return { ok: false, reason: "from, to and text" };
  const to = deps.local().find((s) => s.id === b.to);
  if (!to || !reachable(to)) return { ok: false, reason: "no such session running here to message" };
  const body = relaySafe(b.text, MAX_MESSAGE);
  if (!body) return { ok: false, reason: "nothing to say" };
  const seen = deps.peerSessions().find((s) => s.id === from && s.peer === machine);
  const title = seen?.title ?? (relaySafe(typeof b.fromTitle === "string" ? b.fromTitle : "", MAX_TITLE).replace(/"/g, "'") || "a session");
  return deliver(to, `${label({ title, id: from }, machine)} ${body}`);
}
