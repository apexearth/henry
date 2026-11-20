/**
 * The tools a topic's coordinator gets on top of the session list (mcp.ts serves them only to a
 * caller that is a coordinator). Every answer is a summary: prompts, activity, files written,
 * git state, the last reply. Never source or diffs; the coordinator runs with no file or shell
 * tools either (topics.ts COORDINATOR_DENIED), so this is the whole of what it can see.
 *
 * The writes go through topics.ts, which holds the rules: membership changes only for a running
 * session, suggestions only for one here in no topic, prompts only to members and only between
 * their turns. A member on a paired machine is read and prompted through that machine, which
 * builds its summary the same way (server.ts /api/topic/member).
 */
import { isClaudeSession, type Session } from "@henry/shared";
import * as db from "./db";
import * as git from "./git";
import { readHistory } from "./history";
import { activityPhrase, age, reposOfSession, short, writtenPaths, type CallContext, type ToolDef } from "./mcp";
import * as topics from "./topics";
import { matchNamed } from "./voice";

const MAX_FILES = 8;
const MAX_LOOSE = 10;
const REPLY_CHARS = 1_500;
const PROMPT_CHARS = 300;

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/** The topic the calling coordinator keeps, or the reason it has none. */
function own(ctx: CallContext): { topicId: string; name: string } | string {
  const self = topics.allSessions().find((s) => s.id === ctx.sessionId);
  if (!self?.coordinator || !self.topicId) return "henry: only a topic's coordinator has these tools.";
  const t = topics.get(self.topicId);
  return t ? { topicId: t.id, name: t.name } : "henry: your topic was closed; there is nothing to coordinate.";
}

/** A session named by id (or its first 8 characters) or by title, among `pool`. */
function find(name: string, pool: Session[]): Session | undefined {
  const want = name.trim().replace(/^\[|\]$/g, "");
  if (want.length >= 4) {
    const byId = pool.filter((s) => s.id.startsWith(want));
    if (byId.length === 1) return byId[0];
  }
  return matchNamed(want, pool, (s) => s.title);
}

function repoLine(s: Session): string {
  const repos = git.getSessionRepos(s.id);
  if (!repos.length) return "";
  return repos.map((r) => `${r.name}@${r.branch || "detached"} (${r.dirty} dirty${r.commitsSinceBaseline ? `, +${r.commitsSinceBaseline} commits since it started` : ""})`).join("; ");
}

/** Files the session is on record as writing, across its repos, repo-relative. */
function filesLine(s: Session): string {
  const out: string[] = [];
  for (const path of reposOfSession(s)) {
    const info = git.resolveRepo(path);
    if (!info) continue;
    for (const f of writtenPaths(s.id, info.path)) out.push(`${info.name}/${f}`);
  }
  if (!out.length) return "";
  return out.slice(0, MAX_FILES).join(", ") + (out.length > MAX_FILES ? `, +${out.length - MAX_FILES} more` : "");
}

function head(s: Session, now: number): string {
  const kind = isClaudeSession(s) ? "" : " (terminal)";
  const state = s.status === "running" ? activityPhrase(s, now) : `exited ${s.endedAt ? age(s.endedAt, now) + " ago" : ""}`.trim();
  return `"${s.title}" [${s.id.slice(0, 8)}]${kind} ${state} — cwd ${short(s.cwd)}${s.peer ? ` — on ${s.peer}` : ""}`;
}

/** A few lines per session: who, doing what, asked what, touching which files. notes-fill.ts reads
 * sessions the same way. */
export function sessionBrief(s: Session, now: number, prompts = 1): string[] {
  const lines = [head(s, now)];
  const repos = repoLine(s);
  if (repos) lines.push(`  repos: ${repos}`);
  const asked = db.listPrompts(s.id, prompts, PROMPT_CHARS);
  for (const p of asked) lines.push(`  asked ${age(p.ts, now)} ago: "${clip(p.prompt, PROMPT_CHARS)}"`);
  const files = filesLine(s);
  if (files) lines.push(`  wrote: ${files}`);
  return lines;
}

export function lastReply(s: Session): string | undefined {
  if (!isClaudeSession(s)) return undefined;
  const turns = readHistory(s.id, 40).turns.filter((t) => t.role === "assistant" && !t.sidechain);
  for (let i = turns.length - 1; i >= 0; i--) {
    const text = turns[i]!.blocks.filter((b) => b.kind === "text").map((b) => b.text).join(" ");
    if (text.trim()) return clip(text, REPLY_CHARS);
  }
  return undefined;
}

/** sessionBrief and the last reply, for a session here or, asked over the link, on a peer. */
export async function memberBrief(s: Session, now: number, prompts = 1): Promise<{ lines: string[]; reply?: string }> {
  if (!s.peer) return { lines: sessionBrief(s, now, prompts), reply: lastReply(s) };
  const r = await topics.askPeer<{ lines: string[]; reply?: string }>({ session: s.id }, "GET", `/api/topic/member?session=${encodeURIComponent(s.id)}&prompts=${prompts}`);
  // The first line is rebuilt here, so it says which machine the session is on.
  if (!r.ok) return { lines: [head(s, now), `  (${s.peer} did not say more: ${r.reason})`] };
  return { lines: [head(s, now), ...r.value.lines.slice(1)], reply: r.value.reply };
}

// ---- tools ----

async function topicView(ctx: CallContext, now = Date.now()): Promise<string> {
  const mine = own(ctx);
  if (typeof mine === "string") return mine;
  const t = topics.get(mine.topicId)!;
  const members = topics.membersOf(t.id);
  const notes = topics.notesOf(t.id, now);
  const out = [`You coordinate the topic "${t.name}", made ${age(t.createdAt, now)} ago.`, "", t.brief ? `Brief:\n${t.brief}` : "Brief: (none yet; write one with henry_brief once you know what this topic is)"];
  out.push("", notes.length ? `Notes:\n${notes.map((n) => `- [${n.id}] ${n.text} (${age(n.ts, now)} ago${n.expiresAt ? `, ${Math.max(1, Math.round((n.expiresAt - now) / 60_000))}m left` : ""})`).join("\n")}` : "Notes: none");
  out.push("", `Members (${members.length}):`);
  if (!members.length) out.push("  none yet. The user adds sessions from the rail, or asks you to.");
  for (const b of await Promise.all(members.map((s) => memberBrief(s, now)))) out.push(...b.lines.map((l) => "  " + l));

  const loose = topics.looseSessions();
  if (loose.length) {
    out.push("", `In no topic (${loose.length}) — henry_membership can suggest one belongs here:`);
    for (const s of loose.slice(0, MAX_LOOSE)) out.push(...sessionBrief(s, now).map((l) => "  " + l));
    if (loose.length > MAX_LOOSE) out.push(`  +${loose.length - MAX_LOOSE} more`);
  }
  const suggested = topics.list(now).find((x) => x.id === t.id)?.suggestions ?? [];
  if (suggested.length) out.push("", `Your suggestions waiting on the user: ${suggested.map((x) => `[${x.sessionId.slice(0, 8)}] ${x.reason}`).join("; ")}`);

  const others = topics.list(now).filter((x) => x.id !== t.id);
  if (others.length) {
    out.push("", "Other topics (read-only to you):");
    for (const o of others) {
      const n = topics.membersOf(o.id).filter((s) => s.status === "running").length;
      out.push(`  "${o.name}" — ${n} running — ${o.brief ? clip(o.brief, 200) : "no brief"}`);
    }
  }
  return out.join("\n");
}

/** Any session here, and the members of your topic on other machines. */
async function sessionView(args: Record<string, unknown>, ctx: CallContext, now = Date.now()): Promise<string> {
  const mine = own(ctx);
  if (typeof mine === "string") return mine;
  const name = typeof args.session === "string" ? args.session : "";
  const pool = [...topics.allSessions().filter((s) => !s.coordinator && !s.peer), ...topics.membersOf(mine.topicId).filter((s) => s.peer)];
  const s = find(name, pool);
  if (!s) return `henry: no session here or in your topic matches "${name}". henry_topic lists them with their ids.`;
  const where = s.topicId === mine.topicId ? "in your topic" : s.topicId ? `in the topic "${topics.get(s.topicId)?.name ?? "?"}"` : "in no topic";
  const brief = await memberBrief(s, now, 6);
  const out = [...brief.lines, `  ${where}`];
  const reply = brief.reply;
  out.push(reply ? `  last reply: "${reply}"` : "  last reply: (none on record)");
  const queued = topics.queuedFor(s.id);
  if (queued) out.push(`  ${queued} message${queued === 1 ? "" : "s"} from you waiting for its turn to end`);
  return out.join("\n");
}

function briefTool(args: Record<string, unknown>, ctx: CallContext): string {
  const mine = own(ctx);
  if (typeof mine === "string") return mine;
  const done: string[] = [];
  if (typeof args.brief === "string") {
    const r = topics.setBrief(mine.topicId, args.brief);
    if (!r.ok) return `henry: ${r.reason}`;
    done.push("brief saved");
  }
  if (typeof args.drop_note === "string" && args.drop_note.trim()) {
    const r = topics.dropNote(mine.topicId, args.drop_note.trim());
    if (!r.ok) return `henry: ${r.reason}`;
    done.push(`note ${args.drop_note.trim()} dropped`);
  }
  if (typeof args.note === "string" && args.note.trim()) {
    const minutes = typeof args.minutes === "number" ? args.minutes : undefined;
    const r = topics.addNote(mine.topicId, args.note, minutes);
    if (!r.ok) return `henry: ${r.reason}`;
    done.push(`note ${r.value.id} added${r.value.expiresAt ? `, expires in ${Math.round(minutes!)}m` : ""}`);
  }
  if (!done.length) return "henry: nothing to do. Pass brief, note, or drop_note.";
  return `${done.join("; ")}. Members see it on their next prompt.`;
}

function membershipTool(args: Record<string, unknown>, ctx: CallContext): string {
  const mine = own(ctx);
  if (typeof mine === "string") return mine;
  const action = String(args.action ?? "");
  const name = typeof args.session === "string" ? args.session : "";
  // Sessions on paired machines too: one there can be in a topic here.
  const pool = topics.allSessions().concat(topics.peerSessions()).filter((s) => !s.coordinator && s.status === "running");
  const s = find(name, pool);
  if (!s) return `henry: no running session matches "${name}".`;
  const done = (r: topics.Result<"done" | "asked">, what: string) =>
    !r.ok ? `henry: ${r.reason}` : r.value === "done" ? `"${s.title}" is ${what} now.` : `asked ${s.peer} to put "${s.title}" ${what}; henry_topic shows it once that machine has.`;
  switch (action) {
    case "add": {
      if (s.topicId === mine.topicId) return `"${s.title}" is already in "${mine.name}".`;
      if (s.topicId) return `henry: "${s.title}" is in "${topics.get(s.topicId)?.name ?? "another topic"}"; the user moves it from there.`;
      return done(topics.place(s.id, mine.topicId), `in "${mine.name}"`);
    }
    case "remove": {
      if (s.topicId !== mine.topicId) return `"${s.title}" is not in "${mine.name}".`;
      return done(topics.place(s.id, null), "in no topic");
    }
    case "suggest": {
      if (s.peer) return `henry: "${s.title}" runs on ${s.peer}; suggestions are for this machine's sessions. Tell the user, who can add it from the rail.`;
      const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason : `looks like part of "${mine.name}"`;
      const r = topics.suggest(mine.topicId, s.id, reason);
      return r.ok ? `suggested: the rail shows "→ ${mine.name}?" on "${s.title}" until the user accepts or dismisses it.` : `henry: ${r.reason}`;
    }
    default:
      return 'henry: action is "add", "remove" or "suggest".';
  }
}

async function promptTool(args: Record<string, unknown>, ctx: CallContext): Promise<string> {
  const mine = own(ctx);
  if (typeof mine === "string") return mine;
  const name = typeof args.session === "string" ? args.session : "";
  const s = find(name, topics.membersOf(mine.topicId).filter((x) => x.status === "running"));
  if (!s) return `henry: no running member of "${mine.name}" matches "${name}".`;
  const send = args.send === true;
  const r = await topics.prompt(ctx.sessionId, s.id, typeof args.text === "string" ? args.text : "", send);
  if (!r.ok) return `henry: ${r.reason}`;
  switch (r.value) {
    case "sent":
      return `sent to "${s.title}". Its reply shows in henry_session once the turn ends.`;
    case "drafted":
      return `in "${s.title}"'s input, unsent: the user reads it there and presses Enter.`;
    case "queued":
      return `"${s.title}" is ${activityPhrase(s, Date.now())}; the message ${send ? "is sent" : "goes in as a draft"} when its turn ends (it gives up after ${topics.DELIVERY_TTL_MS / 60_000}m).`;
  }
}

export const COORDINATOR_TOOLS: ToolDef[] = [
  {
    name: "henry_topic",
    description: "Your topic as it is now: the brief, the notes, each member with what it is doing, what it was last asked and the files it wrote, sessions in no topic, and the other topics. Look here before answering the user; the members keep working.",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, ctx) => topicView(ctx),
  },
  {
    name: "henry_session",
    description: "One session in more depth: its last few prompts, its last reply, files written, git state. Any session on this machine, or a member of your topic on another, by title or id.",
    inputSchema: { type: "object", properties: { session: { type: "string", description: "Title or id (the 8 characters henry_topic shows)." } }, required: ["session"] },
    run: async (args, ctx) => sessionView(args, ctx),
  },
  {
    name: "henry_brief",
    description: "Rewrite the topic's brief, add a note, or drop one. Members get the brief and notes as context on their next prompt after a change. The brief is short and factual: goal, decisions, who owns which area, what is off-limits. A note is one line that is true for a while.",
    inputSchema: {
      type: "object",
      properties: {
        brief: { type: "string", description: "The whole new brief; replaces the old one." },
        note: { type: "string", description: "One line to add as a note." },
        minutes: { type: "number", description: "How long the note stays (default: until dropped)." },
        drop_note: { type: "string", description: "Id of a note to remove." },
      },
    },
    run: async (args, ctx) => briefTool(args, ctx),
  },
  {
    name: "henry_membership",
    description: "Add a session to your topic or remove one, only when the user asked you to. Otherwise use suggest: the rail offers it to the user, who accepts with a click.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Title or id." },
        action: { type: "string", enum: ["add", "remove", "suggest"] },
        reason: { type: "string", description: "For suggest: one line on why it belongs here." },
      },
      required: ["session", "action"],
    },
    run: async (args, ctx) => membershipTool(args, ctx),
  },
  {
    name: "henry_prompt",
    description: "Put a message in a member's input, marked as from you. A draft unless send is true; set send only when the user's message to you said to send it. Either way it waits until that member's turn is over. One paragraph; newlines become spaces.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "A member's title or id." },
        text: { type: "string" },
        send: { type: "boolean", description: "Submit it (default false: leave it for the user to send)." },
      },
      required: ["session", "text"],
    },
    run: async (args, ctx) => promptTool(args, ctx),
  },
];
