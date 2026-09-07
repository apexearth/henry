// The conversation behind a Claude session, read on demand from its transcript.
//
// Claude Code's TUI holds the alternate screen for the whole session (?1049h, never released),
// and a terminal on the alternate screen has no scrollback by definition — there is nothing
// above the frame for a window to scroll back into. The conversation still exists, in the
// jsonl the tailer already follows, so the History panel reads it from there instead.
//
// Read-only and stateless: no watching, no caching. A panel asks, we read the tail of the file.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { History, HistoryBlock, HistoryTurn } from "@henry/shared";
import { sessions } from "./sessions";
import { transcriptPathOf } from "./transcript";

/** Most of a transcript one request reads. They reach tens of MB; the tail is the conversation. */
const TAIL_BYTES = 4 << 20;
const MAX_TURNS = 400;
/** Per block. A pasted file or a big tool result would otherwise swamp the page. */
const TEXT_CHARS = 20_000;
const RESULT_CHARS = 2_000;

export function readHistory(sessionId: string, limit = MAX_TURNS): History {
  const session = sessions.get(sessionId);
  if (!session) return { sessionId, turns: [], complete: true, reason: "no such session" };
  const path = transcriptPathOf(session);
  if (!path) return { sessionId, turns: [], complete: true, reason: "no Claude transcript for this session" };

  let text: string;
  let clippedFile = false;
  try {
    const size = statSync(path).size;
    const want = Math.min(size, TAIL_BYTES);
    clippedFile = want < size;
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(want);
      const n = readSync(fd, buf, 0, want, size - want);
      text = buf.toString("utf8", 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { sessionId, turns: [], complete: true, reason: "transcript not written yet" };
  }

  const turns = parseTurns(text, clippedFile);
  const cap = Math.max(1, Math.min(limit, MAX_TURNS));
  const complete = !clippedFile && turns.length <= cap;
  return { sessionId, turns: turns.slice(-cap), complete };
}

/** `partialFirstLine`: the text was read from an offset, so it opens mid-line. */
export function parseTurns(text: string, partialFirstLine = false): HistoryTurn[] {
  const lines = text.split("\n");
  if (partialFirstLine) lines.shift();
  const turns: HistoryTurn[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const turn = parseLine(line);
    if (turn) turns.push(turn);
  }
  return turns;
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface Line {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { role?: string; model?: string; content?: unknown };
}

function parseLine(raw: string): HistoryTurn | undefined {
  let line: Line;
  try {
    line = JSON.parse(raw);
  } catch {
    return;
  }
  if (!line || typeof line !== "object") return;
  if (line.type !== "user" && line.type !== "assistant") return;
  // Meta lines are Claude Code talking to itself (command output, caveats), not the conversation.
  if (line.isMeta) return;
  const blocks = blocksOf(line.message?.content, line.type);
  if (!blocks.length) return;
  return {
    uuid: line.uuid ?? `${line.timestamp ?? ""}:${turnKey++}`,
    at: Date.parse(line.timestamp ?? "") || 0,
    role: line.type,
    sidechain: line.isSidechain === true ? true : undefined,
    model: line.message?.model,
    blocks,
  };
}

/** Only used when a line has no uuid, which the real format always does. */
let turnKey = 0;

function blocksOf(content: unknown, role: "user" | "assistant"): HistoryBlock[] {
  const text = (s: string): HistoryBlock[] => {
    const t = role === "user" ? tidyUserText(s) : s;
    return t.trim() ? [clip({ kind: "text", text: t }, TEXT_CHARS)] : [];
  };
  if (typeof content === "string") return text(content);
  if (!Array.isArray(content)) return [];
  const out: HistoryBlock[] = [];
  for (const raw of content as Block[]) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.type === "text" && typeof raw.text === "string") {
      out.push(...text(raw.text));
    } else if (raw.type === "thinking" && typeof raw.thinking === "string") {
      if (raw.thinking.trim()) out.push(clip({ kind: "thinking", text: raw.thinking }, TEXT_CHARS));
    } else if (raw.type === "tool_use") {
      out.push(clip({ kind: "tool", name: raw.name ?? "tool", text: toolSummary(raw.input) }, RESULT_CHARS));
    } else if (raw.type === "tool_result") {
      const text = resultText(raw.content);
      if (text.trim()) out.push(clip({ kind: "result", text }, RESULT_CHARS));
    }
  }
  return out;
}

/** A slash command reaches the transcript as XML tags around it, and the command's own output
 * as another pair. Show what was typed and what came back, not the markup. */
function tidyUserText(text: string): string {
  const name = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (name) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return [name[1]!.trim(), args].filter(Boolean).join(" ");
  }
  return text.replace(/<\/?local-command-std(?:out|err)>/g, "").trim();
}

/** The argument worth showing: a command, a path, a pattern — else the whole input as JSON. */
function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "prompt", "url", "description"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  try {
    return JSON.stringify(o);
  } catch {
    return "";
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

function clip(b: HistoryBlock, max: number): HistoryBlock {
  if (b.text.length <= max) return b;
  return { ...b, text: b.text.slice(0, max), clipped: true };
}
