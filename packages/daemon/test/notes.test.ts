// bun test — notes.ts against a scratch HENRY_HOME: what a machine keeps when a peer's copy of
// a note arrives, and what it passes on. No server, no port.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Note, ServerMessage } from "@henry/shared";
import { rmScratch } from "./sessiond-helper";

const home = mkdtempSync(join(tmpdir(), "henry-notes-"));
process.env.HENRY_HOME = home;
delete process.env.HENRY_PORT;

const notes = await import("../src/notes");
const db = await import("../src/db");

afterAll(async () => {
  await rmScratch(home);
});

let windows: ServerMessage[] = [];
let links: Note[][] = [];
beforeEach(() => {
  db.db.exec("DELETE FROM notes");
  windows = [];
  links = [];
  notes.setOutputs((m) => windows.push(m), (n) => links.push(n));
});

const peerNote = (over: Partial<Note> = {}): Note => ({ id: "n1", text: "from the laptop", host: "laptop", createdAt: 1000, updatedAt: 1000, ...over });

describe("notes", () => {
  test("adding one keeps it, tells windows and peers, and names the session it is about", () => {
    const n = notes.add("  ship the migration before Friday  ", "desk", { id: "s1", title: "henry" })!;
    expect(n.text).toBe("ship the migration before Friday");
    expect(n.sessionTitle).toBe("henry");
    expect(notes.list()).toEqual([n]);
    expect(windows).toEqual([{ type: "notes:update", notes: [n] }]);
    expect(links).toEqual([[n]]);
    expect(notes.add("   ", "desk")).toBeUndefined();
  });

  test("a removal is a change that wins over the older copy, and undo brings it back", () => {
    const n = notes.add("remember the flag", "desk")!;
    const gone = notes.remove(n.id, true)!;
    expect(gone.deleted).toBe(true);
    expect(gone.updatedAt).toBeGreaterThan(n.updatedAt);
    // A peer that never heard of the removal sends its old copy: nothing changes, nothing echoes.
    windows = [];
    expect(notes.merge([n])).toEqual([]);
    expect(windows).toEqual([]);
    expect(notes.remove(n.id, false)!.deleted).toBeUndefined();
  });

  test("a peer's newer copy replaces ours and is passed on; the same copy again is not", () => {
    notes.merge([peerNote()]);
    links = [];
    const edited = peerNote({ text: "from the laptop, edited", updatedAt: 2000 });
    expect(notes.merge([edited])).toEqual([edited]);
    expect(links).toEqual([[edited]]);
    expect(notes.merge([edited])).toEqual([]);
    expect(db.getNote("n1")!.text).toBe("from the laptop, edited");
  });

  test("two copies changed at the same moment settle the same way on both machines", () => {
    const a = peerNote({ text: "a", updatedAt: 5 });
    const b = peerNote({ text: "b", updatedAt: 5, deleted: true });
    expect(notes.newer(b, a)).toBe(true);
    expect(notes.newer(a, b)).toBe(false);
  });

  test("junk from a peer is dropped", () => {
    expect(notes.merge([{ id: "x" }, null, "nope", peerNote({ text: "" })])).toEqual([]);
    expect(notes.merge("not a list")).toEqual([]);
    expect(notes.list()).toEqual([]);
  });

  test("old tombstones are swept; live notes never are", () => {
    notes.merge([peerNote({ id: "old-gone", deleted: true, updatedAt: 1 }), peerNote({ id: "old-live", updatedAt: 1 })]);
    expect(notes.prune()).toBe(1);
    expect(notes.list().map((n) => n.id)).toEqual(["old-live"]);
  });
});
