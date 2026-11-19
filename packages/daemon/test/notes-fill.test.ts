// bun test — notes-fill.ts with a fake model, against a scratch HENRY_HOME. No server, no port,
// no PTY: the sessions are rows, which is all a fill reads.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HenryEvent, ServerMessage, Session } from "@henry/shared";
import { rmScratch, stopSessiond } from "./sessiond-helper";

const home = mkdtempSync(join(tmpdir(), "henry-notes-fill-"));
process.env.HENRY_HOME = home;
delete process.env.HENRY_PORT;

const fill = await import("../src/notes-fill");
const notes = await import("../src/notes");
const db = await import("../src/db");
const { sessions } = await import("../src/sessions");

afterAll(async () => {
  await stopSessiond(home);
  await rmScratch(home);
});

const s1: Session = { id: "aaaaaaaa-1111", cwd: home, title: "rate limiter", createdAt: Date.now() - 60_000, status: "running", command: "claude" };
const s2: Session = { id: "bbbbbbbb-2222", cwd: home, title: "docs", createdAt: Date.now() - 60_000, status: "running", command: "claude" };
// The manager's list is what a fill reads; stand it in rather than start sessiond.
sessions.list = () => [s1, s2];

function act(sessionId: string, ts: number): void {
  const e: HenryEvent = { id: crypto.randomUUID(), sessionId, ts, kind: "hook", hookEvent: "UserPromptSubmit", payload: { prompt: "make the 429 carry Retry-After" }, severity: "info", summary: "prompt" };
  db.insertEvent(e);
}

describe("fill from sessions", () => {
  test("the answer becomes notes about the sessions it names; junk and extra lines are dropped", () => {
    const got = fill.parseAnswer('Sure:\n[{"session":"aaaaaaaa","text":"Push feat/rate-limits"},{"session":"aaaaaaaa","text":"two"},{"session":"aaaaaaaa","text":"three"},{"session":"zzzz","text":"nobody"},{"text":"no session"}]', [s1, s2]);
    expect(got.map((n) => [n.session.id, n.text])).toEqual([[s1.id, "Push feat/rate-limits"], [s1.id, "two"]]);
    expect(fill.parseAnswer("no json here", [s1])).toEqual([]);
  });

  test("reads only sessions with something new, adds what comes back, and does not read them again", async () => {
    act(s1.id, Date.now() - 1000);
    const seen: string[] = [];
    const out: ServerMessage[] = [];
    await fill.fill((m) => out.push(m), async (_sys, user) => {
      seen.push(user);
      return '[{"session":"aaaaaaaa","text":"Retry-After is still a flat 60"}]';
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("rate limiter");
    expect(notes.list().map((n) => [n.text, n.sessionId])).toEqual([["Retry-After is still a flat 60", s1.id]]);
    expect(out.at(-1)).toMatchObject({ type: "notes:filling", state: "done", checked: 2, added: 1 });

    // Nothing happened since: no call at all.
    await fill.fill((m) => out.push(m), async () => {
      throw new Error("must not be called");
    });
    expect(out.at(-1)).toMatchObject({ state: "done", checked: 0, added: 0 });
  });

  test("a failed call says so and leaves the sessions due", async () => {
    act(s2.id, Date.now());
    const out: ServerMessage[] = [];
    await fill.fill((m) => out.push(m), async () => {
      throw new Error("no backend");
    });
    expect(out.at(-1)).toMatchObject({ state: "failed", error: "no backend" });
    expect(fill.due().map((s) => s.id)).toEqual([s2.id]);
  });
});
