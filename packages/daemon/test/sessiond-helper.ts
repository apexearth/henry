// Test helpers for sessiond: every test that boots a daemon under a scratch HENRY_HOME
// causes a sessiond to start there, and must stop it (by pid, never by pattern).
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

export interface SessiondInfo {
  port: number;
  token: string;
  pid: number;
  protocolVersion: number;
  startedAt: number;
}

export function readSessiondInfo(home: string): SessiondInfo | undefined {
  try {
    return JSON.parse(readFileSync(join(home, "sessiond.json"), "utf8"));
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, ms = 10000, step = 50): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v !== undefined) return v;
    await Bun.sleep(step);
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** Open a raw client connection: hello, then `send` lines. Resolves once hello is answered. */
export function dialSessiond(info: SessiondInfo, timeoutMs = 2000): Promise<{ send: (msg: unknown) => void; close: () => void; hello: any }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: "127.0.0.1", port: info.port });
    let buf = "";
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error("sessiond did not answer hello"));
    }, timeoutMs);
    sock.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    sock.on("connect", () => sock.write(JSON.stringify({ op: "hello", token: info.token, protocolVersion: info.protocolVersion }) + "\n"));
    sock.on("data", (c) => {
      buf += c.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      clearTimeout(t);
      if (msg.op !== "hello") {
        sock.destroy();
        return reject(new Error(`refused: ${JSON.stringify(msg)}`));
      }
      resolve({ send: (m) => sock.write(JSON.stringify(m) + "\n"), close: () => sock.destroy(), hello: msg });
    });
  });
}

/**
 * Remove a scratch tree. On Windows a directory stays busy for a moment after the handles on
 * it close (config.ts watches HENRY_HOME in-process; sessiond just exited), so retry, then
 * let a leftover temp dir be rather than fail the run.
 */
export async function rmScratch(dir: string): Promise<void> {
  const { rmSync } = await import("node:fs");
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
}

/**
 * Stop the sessiond recorded in <home>/sessiond.json: `shutdown now`, wait for its pid to
 * go, SIGKILL as a last resort (it is ours: it lives under a scratch home). No-op when
 * there is none. Returns true if a sessiond was found.
 */
export async function stopSessiond(home: string): Promise<boolean> {
  const info = readSessiondInfo(home);
  if (!info) return false;
  if (pidAlive(info.pid)) {
    try {
      const c = await dialSessiond(info);
      c.send({ op: "shutdown", when: "now" });
      await Bun.sleep(50);
      c.close();
    } catch {
      // not answering; fall through to the wait / kill below
    }
    try {
      await waitFor(`sessiond pid ${info.pid} to exit`, () => (pidAlive(info.pid) ? undefined : true), 5000);
    } catch {
      console.error(`[test] sessiond pid ${info.pid} ignored shutdown; SIGKILL`);
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {}
      await waitFor(`sessiond pid ${info.pid} to die`, () => (pidAlive(info.pid) ? undefined : true), 5000);
    }
  }
  if (existsSync(join(home, "sessiond.json"))) {
    // A sessiond that exited cleanly removes its own file; a killed one leaves it behind.
    const { rmSync } = await import("node:fs");
    rmSync(join(home, "sessiond.json"), { force: true });
  }
  return true;
}
