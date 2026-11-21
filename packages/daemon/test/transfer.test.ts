// henry_fetch_file: where a fetched file is read from and where it lands, with the link faked.
// The link itself is covered by federation.test.ts. Run: cd packages/daemon && bun test test/transfer.test.ts
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@henry/shared";
import { rmScratch } from "./sessiond-helper";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "henry-transfer-test-")));
process.env.HENRY_HOME = join(tmp, "home");
process.env.HENRY_PORT = "0";
const transfer = await import("../src/transfer");

const here = join(tmp, "work");
mkdirSync(here, { recursive: true });
const me = { id: "me-0000000", cwd: here, title: "me", status: "running" } as Session;
const mac = { id: "abcd1234-mac", cwd: "/Users/c/code/cto", title: "Signal Work", peer: "mac", status: "running" } as Session;
const box = { id: "beef5678-box", cwd: "C:\\code\\gin", title: "Signal Work", peer: "box", status: "running" } as Session;
const lone = { id: "cafe9012-box", cwd: "C:\\code\\gin", title: "Image Work", peer: "box", status: "running" } as Session;

/** Every read, and what the fake machine answers. */
let reads: { machine: string; path: string }[] = [];
let answer = (): Response => new Response(new TextEncoder().encode("bytes from afar"));

function fake(): void {
  reads = [];
  answer = () => new Response(new TextEncoder().encode("bytes from afar"));
  transfer.setDepsForTests({
    paired: () => true,
    machines: () => ["mac", "box"],
    peerSessions: () => [mac, box, lone],
    local: (id) => (id === me.id ? me : undefined),
    read: (machine, path) => {
      reads.push({ machine, path });
      return Promise.resolve(answer());
    },
  });
}

const run = (args: Record<string, unknown>, sessionId = me.id) => transfer.fetchFile(args, { sessionId });

afterEach(() => transfer.setDepsForTests(null));
afterAll(() => rmScratch(tmp));

describe("henry_fetch_file", () => {
  test("from a machine by name, an absolute path, into the caller's working directory", async () => {
    fake();
    const out = await run({ from: "MAC", path: "/Users/c/notes/plan.md" });
    expect(reads).toEqual([{ machine: "mac", path: "/Users/c/notes/plan.md" }]);
    expect(readFileSync(join(here, "plan.md"), "utf8")).toBe("bytes from afar");
    expect(out).toContain("copied mac:/Users/c/notes/plan.md");
  });

  test("from a session, a relative path is read from its working directory, in that machine's style", async () => {
    fake();
    await run({ from: "Image Work", path: "out/a.png", to: "pics/" });
    expect(reads[0]).toEqual({ machine: "box", path: "C:\\code\\gin\\out\\a.png" });
    expect(readFileSync(join(here, "pics", "a.png"), "utf8")).toBe("bytes from afar");
    await run({ from: "[abcd1234]", path: "src/x.ts", to: "x-from-mac.ts" });
    expect(reads[1]).toEqual({ machine: "mac", path: "/Users/c/code/cto/src/x.ts" });
    expect(readFileSync(join(here, "x-from-mac.ts"), "utf8")).toBe("bytes from afar");
  });

  test("`to` naming an existing folder keeps the file's name; ~ goes to the other machine as is", async () => {
    fake();
    mkdirSync(join(here, "into"), { recursive: true });
    await run({ from: "mac", path: "~/notes/todo.txt", to: "into" });
    expect(reads[0]!.path).toBe("~/notes/todo.txt");
    expect(readFileSync(join(here, "into", "todo.txt"), "utf8")).toBe("bytes from afar");
  });

  test("an existing file is kept unless overwrite is asked for", async () => {
    fake();
    writeFileSync(join(here, "keep.txt"), "mine");
    await expect(run({ from: "mac", path: "/a/keep.txt" })).rejects.toThrow("already exists");
    expect(reads).toEqual([]);
    expect(readFileSync(join(here, "keep.txt"), "utf8")).toBe("mine");
    await run({ from: "mac", path: "/a/keep.txt", overwrite: true });
    expect(readFileSync(join(here, "keep.txt"), "utf8")).toBe("bytes from afar");
  });

  test("what it cannot do, it says", async () => {
    fake();
    await expect(run({ from: "Signal Work", path: "a" })).rejects.toThrow("names 2 sessions");
    await expect(run({ from: "jarvis", path: "/a" })).rejects.toThrow("connected: mac, box");
    await expect(run({ from: "mac", path: "relative.txt" })).rejects.toThrow("needs a session");
    await expect(run({ from: "mac", path: "/a/b.txt" }, "unknown")).rejects.toThrow("give `to` as an absolute path");
    answer = () => Response.json({ error: "not found" }, { status: 404 });
    await expect(run({ from: "mac", path: "/a/gone.txt" })).rejects.toThrow("mac: not found (/a/gone.txt)");
  });
});
