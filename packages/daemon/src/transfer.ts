// Files between machines, for sessions working together across them (a topic's members on two
// machines, say): a session fetches a file from a paired machine into its own. The other
// machine only reads (`GET /api/file/bytes`, which a peer may already do), and the write is made
// here, for the session that asked, so "peers read" still holds. Pull, never push: a session
// elsewhere that wants you to have a file says where it is, and you fetch it.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import type { Session } from "@henry/shared";
import { expandHome } from "./config";
import * as federation from "./federation";
import type { CallContext, ToolDef } from "./mcp";
import { sessions } from "./sessions";

/** Under Claude Code's 60 s for an MCP call, so a slow machine's answer is Henry's, not a timeout. */
const TIMEOUT_MS = 50_000;

export interface Deps {
  /** Offer the tool at all: some machine is paired with this one. */
  paired(): boolean;
  /** Connected machines by name. */
  machines(): string[];
  peerSessions(): Session[];
  local(id: string): Session | undefined;
  /** The file's bytes from that machine, or undefined when it is not connected. */
  read(machine: string, path: string): Promise<Response> | undefined;
}

const real: Deps = {
  paired: () => federation.paired(),
  machines: () => federation.connectedLinks().map((l) => l.rec.name),
  peerSessions: () => federation.peerSessions(),
  local: (id) => sessions.get(id),
  read: (machine, path) => federation.linkNamed(machine)?.http("GET", `/api/file/bytes?path=${encodeURIComponent(path)}`),
};
let deps = real;

export function setDepsForTests(d: Partial<Deps> | null): void {
  deps = d ? { ...real, ...d } : real;
}

export const offered = (): boolean => deps.paired();

export const fetchTool: ToolDef = {
  name: "henry_fetch_file",
  description:
    "Copy a file from another machine paired with this one onto this one, up to 10 MB: something a session there wrote, for you to read or build on. Name the machine, or a session there (its title or id) to read a relative path from its working directory. Ask that session or your topic's coordinator for the path if you do not have it.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "A paired machine's name, or a session on one: its title or id." },
      path: { type: "string", description: "The file there: absolute, ~/..., or relative to that session's working directory." },
      to: { type: "string", description: "Where to put it here, relative to your working directory; a folder keeps the name. Default: its name, in your working directory." },
      overwrite: { type: "boolean", description: "Replace a file already at `to`. Default false: it is kept and the call fails." },
    },
    required: ["from", "path"],
  },
  run: (args, ctx) => fetchFile(args, ctx),
};

/** Paths on the other machine are in its own style, whatever this one's is. */
const styleOf = (p: string) => (/^[A-Za-z]:[\\/]|^\\\\/.test(p) ? win32 : posix);

function source(from: string): { machine: string; cwd?: string } | string {
  const machines = deps.machines();
  const want = from.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const machine = machines.find((n) => n.toLowerCase() === want);
  if (machine) return { machine };
  const hits = deps.peerSessions().filter((s) => s.title.toLowerCase() === want || (want.length >= 4 && s.id.toLowerCase().startsWith(want)));
  if (hits.length === 1) return { machine: hits[0]!.peer!, cwd: hits[0]!.cwd };
  if (hits.length > 1) return `"${from}" names ${hits.length} sessions (${hits.slice(0, 5).map((s) => `"${s.title}" [${s.id.slice(0, 8)}] on ${s.peer}`).join(", ")}); give the id`;
  return `no connected machine or session on one called "${from}"; connected: ${machines.join(", ") || "none"}`;
}

export async function fetchFile(args: Record<string, unknown>, ctx: CallContext): Promise<string> {
  const from = typeof args.from === "string" ? args.from : "";
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!from || !path) throw new Error("from and path are required");
  const src = source(from);
  if (typeof src === "string") throw new Error(src);

  const style = styleOf(src.cwd ?? path);
  let there = path;
  if (!path.startsWith("~") && !style.isAbsolute(path)) {
    if (!src.cwd) throw new Error(`a relative path needs a session to start from; name one on ${src.machine}, or give an absolute path`);
    there = style.join(src.cwd, path);
  }

  const cwd = deps.local(ctx.sessionId)?.cwd;
  const rawTo = typeof args.to === "string" && args.to.trim() ? expandHome(args.to.trim()) : "";
  if (!rawTo && !cwd) throw new Error("this session's working directory is unknown; give `to` as an absolute path");
  let here = rawTo ? (isAbsolute(rawTo) ? rawTo : cwd ? resolve(cwd, rawTo) : "") : join(cwd!, win32.basename(there));
  if (!here) throw new Error("this session's working directory is unknown; give `to` as an absolute path");
  // A folder keeps the file's name: one that exists, or one `to` ends in a slash to ask for.
  if (/[\\/]$/.test(rawTo) || statSync(here, { throwIfNoEntry: false })?.isDirectory()) here = join(here, win32.basename(there));
  if (existsSync(here) && args.overwrite !== true) throw new Error(`${here} already exists; pass overwrite: true to replace it`);

  const asked = deps.read(src.machine, there);
  if (!asked) throw new Error(`${src.machine} is not connected`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const res = await Promise.race([
    asked,
    new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error(`${src.machine} did not answer in ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS))),
  ]).finally(() => clearTimeout(timer));
  if (!res.ok) {
    const why = await res.json().then((b) => (b as { error?: string }).error, () => undefined);
    throw new Error(`${src.machine}: ${why ?? `HTTP ${res.status}`} (${there})`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  mkdirSync(dirname(here), { recursive: true });
  writeFileSync(here, bytes);
  console.log(`[transfer] ${src.machine}:${there} -> ${here} (${bytes.byteLength} bytes)`);
  return `copied ${src.machine}:${there} to ${here} (${bytes.byteLength} bytes)`;
}
