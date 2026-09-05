// Phone access: a throwaway daemon under a scratch home, with its phone listener on loopback
// instead of a tailnet address. Checks what the second listener will and will not do before a
// device has been granted access, that an invite is one-use, and that revoking a device takes
// its token with it. Never touches ~/.henry or :14711.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhoneStatus, ServerMessage, StateSnapshot } from "@henry/shared";
import { stopSessiond, waitFor } from "./sessiond-helper";

const daemonDir = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "henry-phone-"));
const port = 48600 + Math.floor(Math.random() * 200);
const phonePort = port + 1;
const local = `http://127.0.0.1:${port}`;
const phone = `http://127.0.0.1:${phonePort}`;

const proc = Bun.spawn(["bun", "src/index.ts", "start"], {
  cwd: daemonDir,
  env: { ...process.env, HENRY_NO_PUBLIC_LISTENERS: "1", HENRY_HOME: home, HENRY_PORT: String(port) },
  stdout: "pipe",
  stderr: "pipe",
});
const drain = async (s: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
  for await (const chunk of s) if (process.env.HENRY_TEST_VERBOSE) to.write(chunk);
};
void drain(proc.stdout as ReadableStream<Uint8Array>, process.stdout);
void drain(proc.stderr as ReadableStream<Uint8Array>, process.stderr);

const get = (base: string, path: string, cookie?: string) => fetch(base + path, cookie ? { headers: { cookie } } : undefined);
const post = (base: string, path: string, body: unknown = {}, cookie?: string) =>
  fetch(base + path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: cookie ? { "content-type": "application/json", cookie } : { "content-type": "application/json" },
  });
const phoneStatus = () => get(local, "/api/phone/status").then((r) => r.json()) as Promise<PhoneStatus>;

afterAll(async () => {
  try {
    proc.kill();
    await proc.exited;
  } catch {}
  await stopSessiond(home);
  rmSync(home, { recursive: true, force: true });
});

describe("phone access", () => {
  let cookie = "";

  test("the daemon comes up with a phone listener on the configured address", async () => {
    // config.json is written before the daemon has read it: the watcher would reload anyway,
    // but starting from the final file keeps the first bind the right one.
    await Bun.write(join(home, "config.json"), JSON.stringify({ phone: { listen: "127.0.0.1", port: phonePort }, federation: { listen: "off" } }));
    await waitFor("daemon", async () => {
      try {
        return (await get(local, "/api/state")).ok || undefined;
      } catch {
        return undefined;
      }
    }, 15000);
    await waitFor("phone listener", async () => {
      const st = await phoneStatus();
      return st.listening?.port === phonePort ? st : undefined;
    }, 15000);
    const st = await phoneStatus();
    expect(st.listening).toEqual({ address: "127.0.0.1", port: phonePort });
    expect(st.url).toBe(`${phone}/`);
    expect(st.devices).toEqual([]);
    expect(st.invite).toBeUndefined();
  }, 30000);

  test("an ungranted device gets the UI shell and nothing else", async () => {
    // The bundle has to load before there is anyone to authenticate, so static is open.
    const page = await get(phone, "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    // Everything that matters is not.
    expect((await get(phone, "/api/state")).status).toBe(401);
    expect((await get(phone, "/api/human")).status).toBe(401);
    expect((await get(phone, "/api/phone/me")).status).toBe(401);
    expect((await post(phone, "/api/config", { retentionDays: 1 })).status).toBe(401);
    // A bogus cookie is no better than none.
    expect((await get(phone, "/api/state", "henry_phone=not-a-real-token")).status).toBe(401);
  }, 15000);

  test("what a phone may never reach, granted or not: hooks, MCP, pairing, its own access list", async () => {
    for (const path of ["/hook", "/statusline", "/mcp"]) {
      expect((await post(phone, path)).status).toBe(404);
      expect((await get(phone, path)).status).toBe(404);
    }
    expect((await get(phone, "/api/federation/status")).status).toBe(403);
    expect((await get(phone, "/api/phone/status")).status).toBe(403);
    expect((await post(phone, "/api/phone/invite")).status).toBe(403);
    expect((await post(phone, "/api/phone/forget", { id: "x" })).status).toBe(403);
    // The same endpoints answer on loopback, which is the machine itself.
    expect((await get(local, "/api/federation/status")).status).toBe(200);
    expect((await get(local, "/api/phone/status")).status).toBe(200);
  }, 15000);

  test("claiming needs an open invite and the right code", async () => {
    expect((await post(phone, "/api/phone/claim", { code: "AAAA-AAAA-AAAA", name: "impostor" })).status).toBe(403);
    const invite = (await (await post(local, "/api/phone/invite")).json()) as { code: string; expiresAt: number; url: string };
    expect(invite.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(invite.url).toBe(`${phone}/?i=${invite.code}`);
    expect((await phoneStatus()).invite?.code).toBe(invite.code);

    expect((await post(phone, "/api/phone/claim", { code: "AAAA-AAAA-AAAA" })).status).toBe(403);
    const ok = await post(phone, "/api/phone/claim", { code: invite.code.toLowerCase(), name: "pocket" });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("henry_phone=");
    expect(setCookie).toContain("HttpOnly");
    cookie = setCookie.split(";")[0]!;

    // One use: the code is spent, and the invite is gone from the status.
    expect((await post(phone, "/api/phone/claim", { code: invite.code, name: "second" })).status).toBe(403);
    const st = await phoneStatus();
    expect(st.invite).toBeUndefined();
    expect(st.devices.map((d) => d.name)).toEqual(["pocket"]);
    if (process.platform !== "win32") expect(statSync(join(home, "phones.json")).mode & 0o777).toBe(0o600);
    // The token itself is never written down, only its hash.
    expect(await Bun.file(join(home, "phones.json")).text()).not.toContain(cookie.split("=")[1]);
  }, 20000);

  test("a granted device is a window: state over http, and a live WebSocket", async () => {
    const me = (await (await get(phone, "/api/phone/me", cookie)).json()) as { required: boolean; device: { name: string } };
    expect(me).toMatchObject({ required: true, device: { name: "pocket" } });
    // The same endpoint on loopback says nobody had to be let in.
    expect(await (await get(local, "/api/phone/me")).json()).toEqual({ required: false });

    const state = (await (await get(phone, "/api/state", cookie)).json()) as StateSnapshot;
    expect(Array.isArray(state.sessions)).toBe(true);
    expect(state.config?.phone.port).toBe(phonePort);

    const ws = new WebSocket(`ws://127.0.0.1:${phonePort}/ws`, { headers: { cookie } } as unknown as string[]);
    const first = await new Promise<ServerMessage>((resolve, reject) => {
      ws.onmessage = (e) => resolve(JSON.parse(String(e.data)) as ServerMessage);
      ws.onerror = () => reject(new Error("phone ws refused"));
      setTimeout(() => reject(new Error("no state frame")), 8000);
    });
    expect(first.type).toBe("state");
    ws.close();

    // Without the cookie the upgrade never happens.
    const bare = new WebSocket(`ws://127.0.0.1:${phonePort}/ws`);
    await new Promise<void>((resolve) => {
      bare.onerror = () => resolve();
      bare.onclose = () => resolve();
      bare.onopen = () => resolve();
      setTimeout(resolve, 3000);
    });
    expect(bare.readyState).not.toBe(WebSocket.OPEN);
    try {
      bare.close();
    } catch {}
  }, 20000);

  test("revoking a device takes its token with it", async () => {
    const st = await phoneStatus();
    expect(st.devices[0]?.lastSeenAt).toBeGreaterThan(0);
    expect((await post(local, "/api/phone/forget", { id: "nobody" })).status).toBe(404);
    expect((await post(local, "/api/phone/forget", { id: st.devices[0]!.id })).status).toBe(200);
    expect((await phoneStatus()).devices).toEqual([]);
    expect((await get(phone, "/api/state", cookie)).status).toBe(401);
  }, 15000);

  test("turning the listener off in config closes the port", async () => {
    expect((await post(local, "/api/config", { phone: { listen: "off" } })).status).toBe(200);
    await waitFor("listener down", async () => ((await phoneStatus()).listening ? undefined : true), 10000);
    expect((await phoneStatus()).listenError).toContain("off");
    await expect(get(phone, "/")).rejects.toThrow();
  }, 20000);
});
