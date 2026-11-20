/**
 * Notes: the few things you want to keep in mind while switching between sessions.
 *
 * Every paired machine holds the whole list, not just its own notes, so a window anywhere shows
 * the same notes even while the machine one was written on is asleep. Machines compare notes
 * whenever a link comes up and pass on every change after that; of two copies of one note, the
 * one changed later wins (a removal is a change). Removed notes stay as tombstones for
 * TOMBSTONE_DAYS so a machine that was offline learns they are gone rather than bringing them
 * back. A note is yours, not a session's, so unlike sessions and topics it does spread past the
 * machine it came from: a machine paired with this one gets every note this one has.
 */
import type { Note, ServerMessage } from "@henry/shared";
import * as db from "./db";

export const MAX_TEXT = 2_000;
/** Longer than any sensible absence; a machine away for longer may bring a removed note back. */
export const TOMBSTONE_DAYS = 90;

let emit: (msg: ServerMessage) => void = () => {};
let push: (notes: Note[]) => void = () => {};

/** server.ts injects its broadcast (windows and peers that dialed us) and the push to the peers
 * this daemon dialed; tests inject collectors. */
export function setOutputs(broadcast: (msg: ServerMessage) => void, toLinks: (notes: Note[]) => void): void {
  emit = broadcast;
  push = toLinks;
}

/** Every note, removed ones included, in list order (the front of the queue first). */
export function list(): Note[] {
  return db.listNotes();
}

function changed(notes: Note[]): void {
  if (!notes.length) return;
  emit({ type: "notes:update", notes });
  push(notes);
}

export function add(text: string, host: string, about?: { id: string; title: string }): Note | undefined {
  const t = text.trim().slice(0, MAX_TEXT);
  if (!t) return undefined;
  const now = Date.now();
  const note: Note = { id: crypto.randomUUID(), text: t, host, sessionId: about?.id, sessionTitle: about?.title, createdAt: now, updatedAt: now };
  db.putNote(note);
  changed([note]);
  return note;
}

export function edit(id: string, text: string): Note | undefined {
  const t = text.trim().slice(0, MAX_TEXT);
  const prev = db.getNote(id);
  if (!prev || !t || t === prev.text) return undefined;
  return touch({ ...prev, text: t });
}

/** Not now: to the end of the list, behind everything already there. */
export function defer(id: string): Note | undefined {
  const prev = db.getNote(id);
  if (!prev || prev.deleted) return undefined;
  const last = Math.max(0, ...list().filter((n) => !n.deleted).map((n) => n.queuedAt ?? n.createdAt));
  return touch({ ...prev, queuedAt: Math.max(Date.now(), last + 1) });
}

export function remove(id: string, removed: boolean): Note | undefined {
  const prev = db.getNote(id);
  if (!prev || !!prev.deleted === removed) return undefined;
  return touch({ ...prev, deleted: removed || undefined });
}

/** Clocks on two machines disagree a little; a change must still beat the copy it changed. */
function touch(n: Note): Note {
  const note = { ...n, updatedAt: Math.max(Date.now(), n.updatedAt + 1) };
  db.putNote(note);
  changed([note]);
  return note;
}

/** True when `a` should replace `b`. A tie is broken the same way on every machine. */
export function newer(a: Note, b: Note): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  if (!!a.deleted !== !!b.deleted) return !!a.deleted;
  return a.text > b.text;
}

/** Notes from a peer: keep each that is new here or changed later than ours, and pass those on.
 * What changed nothing goes nowhere, which is what stops two machines echoing a note forever. */
export function merge(incoming: unknown): Note[] {
  if (!Array.isArray(incoming)) return [];
  const taken: Note[] = [];
  for (const raw of incoming) {
    const n = sane(raw);
    if (!n) continue;
    const mine = db.getNote(n.id);
    if (mine && !newer(n, mine)) continue;
    db.putNote(n);
    taken.push(n);
  }
  changed(taken);
  return taken;
}

/** A peer is trusted, but its note still goes in a table and a window; keep it to the shape. */
function sane(v: unknown): Note | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const str = (x: unknown, max: number) => (typeof x === "string" && x.length > 0 && x.length <= max ? x : undefined);
  const id = str(o.id, 100);
  const text = str(o.text, MAX_TEXT);
  const host = str(o.host, 200);
  if (!id || !text || !host || typeof o.createdAt !== "number" || typeof o.updatedAt !== "number") return undefined;
  return {
    id,
    text,
    host,
    sessionId: str(o.sessionId, 100),
    sessionTitle: str(o.sessionTitle, 300),
    createdAt: o.createdAt,
    queuedAt: typeof o.queuedAt === "number" ? o.queuedAt : undefined,
    updatedAt: o.updatedAt,
    deleted: o.deleted === true || undefined,
  };
}

/** Tombstones past their time. Live notes are never swept: you remove them. */
export function prune(now = Date.now()): number {
  return db.pruneNoteTombstones(now - TOMBSTONE_DAYS * 24 * 60 * 60_000);
}
