// henry_sessions and henry_message with the machines faked: who is listed, who a name reaches,
// what the recipient reads, and the hourly cap. The link is covered by federation.test.ts.
// Run: cd packages/daemon && bun test test/messages.test.ts
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@henry/shared";
import { rmScratch } from "./sessiond-helper";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "henry-messages-test-")));
process.env.HENRY_HOME = join(tmp, "home");
process.env.HENRY_PORT = "0";
const messages = await import("../src/messages");

const s = (id: string, title: string, extra: Partial<Session> = {}) =>
  ({ id, title, cwd: `/work/${title.toLowerCase().replace(/ /g, "-")}`, status: "running", kind: "claude", activity: "waiting", ...extra }) as Session;
const me = s("me000000-aaaa", "Planner");
const builder = s("b1110000-aaaa", "Builder");
const shell = s("c2220000-aaaa", "zsh", { kind: "shell" });
const coord = s("d3330000-aaaa", "bridge coordinator", { coordinator: true, topicId: "t1" });
const gone = s("e4440000-aaaa", "Old", { status: "exited" });
const macA = s("f5550000-mac", "Reviewer", { peer: "mac", cwd: "/Users/c/code/cto" });
const macB = s("f6660000-mac", "Builder", { peer: "mac" });

let queued: { to: string; text: string; send: boolean }[] = [];
let posted: { machine: string; body: Record<string, unknown> }[] = [];
let answer = (): Response => Response.json({ outcome: "sent" });

function fake(): void {
  queued = [];
  posted = [];
  answer = () => Response.json({ outcome: "sent" });
  messages.setDepsForTests({
    local: () => [me, builder, shell, coord, gone],
    peerSessions: () => [macA, macB],
    me: () => "desk",
    queue: (to, text, send) => {
      queued.push({ to: to.id, text, send });
      return { ok: true, value: send ? "sent" : "drafted" };
    },
    post: (machine, body) => {
      posted.push({ machine, body: body as Record<string, unknown> });
      return Promise.resolve(answer());
    },
  });
}

const ctx = { sessionId: me.id };
afterEach(() => messages.setDepsForTests(null));
afterAll(() => rmScratch(tmp));

describe("henry_sessions", () => {
  test("every running Claude session here and on paired machines, but not the caller, shells, coordinators or exited ones", () => {
    fake();
    const out = messages.directory("", ctx);
    expect(out).toContain('You are "Planner" [me000000] on desk.');
    expect(out).toContain('"Builder" [b1110000] on desk (this machine) · /work/builder · waiting on the human');
    expect(out).toContain('"Reviewer" [f5550000] on mac · /Users/c/code/cto');
    expect(out).toContain('"Builder" [f6660000] on mac');
    for (const not of ["zsh", "coordinator", "Old", '"Planner" [']) expect(out.split("\n").slice(1).join("\n")).not.toContain(not);
    expect(messages.directory("MAC", ctx).split("\n")).toHaveLength(3);
    expect(messages.directory("nobody", ctx)).toContain('No other session matches "nobody"');
  });

  test("a coordinator, or a caller Henry cannot place, is told so", () => {
    fake();
    expect(() => messages.directory("", { sessionId: coord.id })).toThrow("henry_prompt");
    expect(() => messages.directory("", { sessionId: "" })).toThrow("could not tell");
  });
});

describe("henry_message", () => {
  test("to a session here: labelled with the sender and where an answer goes, submitted", async () => {
    fake();
    const out = await messages.send({ to: "b1110000", text: "is the\nschema done?" }, ctx);
    expect(queued).toEqual([{ to: builder.id, text: '[message from "Planner" [me000000]; answer it with henry_message to "me000000"] is the schema done?', send: true }]);
    expect(out).toContain("sent to");
  });

  test("a name must be exact and only one session's; an id settles it", async () => {
    fake();
    await expect(messages.send({ to: "Builder", text: "hi" }, ctx)).rejects.toThrow("names 2 sessions");
    await expect(messages.send({ to: "Build", text: "hi" }, ctx)).rejects.toThrow("no running session");
    await expect(messages.send({ to: "zsh", text: "hi" }, ctx)).rejects.toThrow("no running session");
    await expect(messages.send({ to: coord.id, text: "hi" }, ctx)).rejects.toThrow("no running session");
    await expect(messages.send({ to: me.id, text: "hi" }, ctx)).rejects.toThrow("no running session");
    await expect(messages.send({ to: "builder", text: "  " }, ctx)).rejects.toThrow("required");
    expect(queued).toEqual([]);
    await messages.send({ to: "[f6660000]", text: "hi" }, ctx);
    expect(posted).toEqual([{ machine: "mac", body: { from: me.id, fromTitle: "Planner", to: macB.id, text: "hi" } }]);
  });

  test("to a session on a paired machine: that machine's answer is the outcome", async () => {
    fake();
    expect(await messages.send({ to: "reviewer", text: "look at cto" }, ctx)).toContain('"Reviewer" [f5550000] on mac');
    answer = () => Response.json({ error: "no such session running here to message" }, { status: 409 });
    await expect(messages.send({ to: "reviewer", text: "again" }, ctx)).rejects.toThrow("mac: no such session");
  });

  test("past the hour's cap, what a session is sent waits for the user", async () => {
    fake();
    for (let i = 0; i < messages.MESSAGES_PER_HOUR; i++) await messages.send({ to: builder.id, text: `n${i}` }, ctx);
    expect(queued.every((q) => q.send)).toBe(true);
    expect(await messages.send({ to: builder.id, text: "one more" }, ctx)).toContain("for the user to send");
    expect(queued.at(-1)!.send).toBe(false);
  });
});

describe("a message from a paired machine", () => {
  test("names the machine it came over and the sender as this machine sees it", () => {
    fake();
    expect(messages.fromPeer("mac", { from: macA.id, fromTitle: "Pretender", to: builder.id, text: "done" })).toEqual({ ok: true, value: "sent" });
    expect(queued[0]!.text).toBe('[message from "Reviewer" [f5550000] on mac; answer it with henry_message to "f5550000"] done');
    // One this machine has no view of keeps its own title, with nothing in it that closes the label.
    messages.fromPeer("mac", { from: 'zz"] x', fromTitle: 'Odd "one"', to: builder.id, text: "hi" });
    expect(queued[1]!.text).toBe(`[message from "Odd 'one'" [zzx] on mac; answer it with henry_message to "zzx"] hi`);
  });

  test("only to this machine's own running Claude sessions", () => {
    fake();
    for (const to of [macA.id, coord.id, shell.id, gone.id, "nope"]) expect(messages.fromPeer("mac", { from: macA.id, to, text: "hi" }).ok).toBe(false);
    expect(messages.fromPeer("mac", { from: macA.id, to: builder.id }).ok).toBe(false);
    expect(queued).toEqual([]);
  });
});
