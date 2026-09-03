// Sessions survive daemon restarts: PTYs live in henry-sessiond, the daemon reconnects.
// Boots daemons as child processes under a scratch HENRY_HOME and random ports; never
// touches ~/.henry or :4711. Run: bun test test/survival.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, ServerMessage, StateSnapshot } from "@henry/shared";
import { pidAlive, readSessiondInfo, stopSessiond, waitFor } from "./sessiond-helper";

const home = mkdtempSync(join(tmpdir(), "henry-survival-"));
const cwd = mkdtempSync(join(home, "cwd-"));
const daemonDir = join(import.meta.dir, "..");
const usedPorts = new Set<number>();
const randomPort = () => {
  let p: number;
  do p = 47500 + Math.floor(Math.random() * 400);
  while (usedPorts.has(p));
  usedPorts.add(p);
  return p;
};

interface Daemon {
  port: number;
  base: string;
  proc: ReturnType<typeof Bun.spawn>;
  stop: () => Promise<number>;
}
const daemons: Daemon[] = [];

async function startDaemon(): Promise<Daemon> {
  const port = randomPort();
  const proc = Bun.spawn(["bun", "src/index.ts", "start"], {
    cwd: daemonDir,
    env: { ...process.env, HENRY_HOME: home, HENRY_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const drain = async (s: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
    for await (const chunk of s) if (process.env.HENRY_TEST_VERBOSE) to.write(chunk);
  };
  void drain(proc.stdout as ReadableStream<Uint8Array>, process.stdout);
  void drain(proc.stderr as ReadableStream<Uint8Array>, process.stderr);
  const base = `http://127.0.0.1:${port}`;
  const d: Daemon = {
    port,
    base,
    proc,
    stop: async () => {
      proc.kill();
      return proc.exited;
    },
  };
  daemons.push(d);
  await waitFor(`daemon on ${port}`, async () => {
    try {
      return (await fetch(`${base}/api/state`)).ok || undefined;
    } catch {
      return undefined;
    }
  }, 15000);
  return d;
}

const state = (d: Daemon) => fetch(`${d.base}/api/state`).then((r) => r.json()) as Promise<StateSnapshot>;

class Win {
  inbox: ServerMessage[] = [];
  ws!: WebSocket;
  output = new Map<string, string>();
  async open(d: Daemon): Promise<this> {
    this.ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      if (m.type === "pty:data") this.output.set(m.sessionId, (this.output.get(m.sessionId) ?? "") + m.data);
      this.inbox.push(m);
    };
    await new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(e);
    });
    await this.next("state");
    return this;
  }
  send(m: ClientMessage): void {
    this.ws.send(JSON.stringify(m));
  }
  next<T extends ServerMessage["type"]>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, ms = 10000) {
    return waitFor(type, () => {
      const i = this.inbox.findIndex((m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
      return i >= 0 ? (this.inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>) : undefined;
    }, ms);
  }
  seen(id: string, needle: string | RegExp, ms = 10000) {
    return waitFor(`output ${needle}`, () => {
      const out = this.output.get(id) ?? "";
      const m = typeof needle === "string" ? (out.includes(needle) ? [needle] : null) : out.match(needle);
      return m ?? undefined;
    }, ms);
  }
  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

afterAll(async () => {
  for (const d of daemons) {
    try {
      await d.stop();
    } catch {}
  }
  await stopSessiond(home);
  rmSync(home, { recursive: true, force: true });
});

describe("sessiond survival", () => {
  let a: Daemon;
  let b: Daemon;
  let sessionId = "";
  let shPid = 0;
  let sessiondPid = 0;

  test("a fresh daemon spawns a sessiond under HENRY_HOME", async () => {
    expect(existsSync(join(home, "sessiond.json"))).toBe(false);
    a = await startDaemon();
    const info = await waitFor("sessiond.json", () => readSessiondInfo(home));
    expect(pidAlive(info.pid)).toBe(true);
    expect(info.protocolVersion).toBe(1);
    expect(info.token).toMatch(/^[0-9a-f]{64}$/);
    sessiondPid = info.pid;
  }, 30000);

  test("a shell session echoes its pid and the daemon records it", async () => {
    const w = await new Win().open(a);
    w.send({ type: "session:create", cwd, title: "survive", command: "/bin/sh", args: [], requestId: "r1" });
    const created = await w.next("session:update", (m) => m.requestId === "r1");
    sessionId = created.session.id;
    expect(created.session.status).toBe("running");
    expect(created.session.host).toBeTruthy();
    w.send({ type: "attach", sessionId });
    await w.next("pty:scrollback", (m) => m.sessionId === sessionId);
    w.send({ type: "pty:input", sessionId, data: "echo alive-$$\r" });
    const m = await w.seen(sessionId, /alive-(\d+)/);
    shPid = Number(m[1]);
    expect(shPid).toBeGreaterThan(0);
    const s = await waitFor("pid in /api/state", async () => (await state(a)).sessions.find((x) => x.id === sessionId && x.pid === shPid));
    expect(s.status).toBe("running");
    w.close();
  }, 30000);

  test("SIGTERM to the daemon leaves the shell and sessiond running", async () => {
    const code = await a.stop();
    expect(code).toBe(0);
    expect(pidAlive(shPid)).toBe(true);
    expect(pidAlive(sessiondPid)).toBe(true);
    expect(readSessiondInfo(home)?.pid).toBe(sessiondPid);
  }, 30000);

  test("a new daemon reconnects: session running, scrollback intact, input still works", async () => {
    b = await startDaemon();
    expect(readSessiondInfo(home)?.pid).toBe(sessiondPid);
    const st = await state(b);
    const s = st.sessions.find((x) => x.id === sessionId);
    expect(s).toBeDefined();
    expect(s!.status).toBe("running");
    expect(s!.pid).toBe(shPid);
    expect(s!.title).toBe("survive");

    const w1 = await new Win().open(b);
    const w2 = await new Win().open(b);
    w1.send({ type: "attach", sessionId });
    w2.send({ type: "attach", sessionId });
    const sb1 = await w1.next("pty:scrollback", (m) => m.sessionId === sessionId);
    const sb2 = await w2.next("pty:scrollback", (m) => m.sessionId === sessionId);
    expect(sb1.data).toContain(`alive-${shPid}`);
    expect(sb2.data).toContain(`alive-${shPid}`);

    // Two attached windows both get live output, from input sent by either.
    w1.send({ type: "pty:input", sessionId, data: "echo again-$((6*7))\r" });
    await w1.seen(sessionId, "again-42");
    await w2.seen(sessionId, "again-42");
    w2.send({ type: "pty:input", sessionId, data: "echo more-$((6*8))\r" });
    await w1.seen(sessionId, "more-48");
    await w2.seen(sessionId, "more-48");

    // A third window attaching later gets everything so far.
    const w3 = await new Win().open(b);
    w3.send({ type: "attach", sessionId });
    const sb3 = await w3.next("pty:scrollback", (m) => m.sessionId === sessionId);
    expect(sb3.data).toContain(`alive-${shPid}`);
    expect(sb3.data).toContain("again-42");
    expect(sb3.data).toContain("more-48");

    w1.send({ type: "session:kill", sessionId });
    const exit = await w1.next("pty:exit", (m) => m.sessionId === sessionId);
    expect(typeof exit.exitCode).toBe("number");
    await w1.next("session:update", (m) => m.session.id === sessionId && m.session.status === "exited");
    await waitFor("shell gone", () => (pidAlive(shPid) ? undefined : true));
    // Exited sessions keep their scrollback in sessiond until dismissed.
    const w4 = await new Win().open(b);
    w4.send({ type: "attach", sessionId });
    const sb4 = await w4.next("pty:scrollback", (m) => m.sessionId === sessionId);
    expect(sb4.data).toContain("more-48");
    await w4.next("pty:exit", (m) => m.sessionId === sessionId);
    // Dismiss: gone from the rail, and from sessiond.
    w4.send({ type: "session:kill", sessionId });
    await waitFor("session forgotten", async () => ((await state(b)).sessions.some((x) => x.id === sessionId) ? undefined : true));
    for (const w of [w1, w2, w3, w4]) w.close();
  }, 40000);

  test("shutdown now stops sessiond and removes sessiond.json", async () => {
    expect(await stopSessiond(home)).toBe(true);
    expect(pidAlive(sessiondPid)).toBe(false);
    expect(existsSync(join(home, "sessiond.json"))).toBe(false);
    // The daemon notices and, on its next need, starts a fresh one.
    const w = await new Win().open(b);
    w.send({ type: "session:create", cwd, title: "after-restart", command: "/bin/sh", args: [], requestId: "r2" });
    const created = await w.next("session:update", (m) => m.requestId === "r2", 15000);
    w.send({ type: "attach", sessionId: created.session.id });
    await w.next("pty:scrollback", (m) => m.sessionId === created.session.id);
    w.send({ type: "pty:input", sessionId: created.session.id, data: "echo fresh-$((1+1))\r" });
    await w.seen(created.session.id, "fresh-2");
    const info = readSessiondInfo(home);
    expect(info).toBeDefined();
    expect(info!.pid).not.toBe(sessiondPid);
    expect(pidAlive(info!.pid)).toBe(true);
    w.send({ type: "session:kill", sessionId: created.session.id });
    await w.next("pty:exit", (m) => m.sessionId === created.session.id);
    w.close();
    await b.stop();
    expect(await stopSessiond(home)).toBe(true);
  }, 40000);

  test("a stale sessiond.json (dead pid) is replaced", async () => {
    const dead = Bun.spawn(["/bin/sh", "-c", "true"]);
    await dead.exited;
    expect(pidAlive(dead.pid)).toBe(false);
    writeFileSync(join(home, "sessiond.json"), JSON.stringify({ port: 1, token: "stale", pid: dead.pid, protocolVersion: 1, startedAt: 0 }));
    const c = await startDaemon();
    const info = await waitFor("fresh sessiond.json", () => {
      const i = readSessiondInfo(home);
      return i && i.pid !== dead.pid && i.token !== "stale" ? i : undefined;
    });
    expect(pidAlive(info.pid)).toBe(true);
    expect(info.port).not.toBe(1);
    const st = await state(c);
    expect(Array.isArray(st.sessions)).toBe(true);
    await c.stop();
    expect(await stopSessiond(home)).toBe(true);
    expect(pidAlive(info.pid)).toBe(false);
  }, 30000);
});
