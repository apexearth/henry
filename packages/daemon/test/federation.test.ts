// Federation: the handshake primitives, then two throwaway daemons (alpha, beta) under
// scratch homes on loopback ports that pair, relay a session from beta into alpha's state,
// drive its PTY through alpha, proxy /api/*, and part ways. Never touches ~/.henry or :14711.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, FederationStatus, ServerMessage, StateSnapshot } from "@henry/shared";
import { Channel, Handshake, fingerprint, isHello, newIdentity, newPairingCode, normalizeCode, proofsEqual, signTranscript, verifyTranscript, type Derived, type IdentityKeys } from "../src/fed-crypto";
import { stopSessiond, waitFor } from "./sessiond-helper";
import { echoExpr, isWindows, testShell } from "./shell";

describe("fed-crypto", () => {
  const a = newIdentity();
  const b = newIdentity();

  test("both sides derive the same channel and can talk both ways", () => {
    const hc = new Handshake("client", a, "alpha");
    const hs = new Handshake("server", b, "beta");
    const dc = hc.derive(hs.hello());
    const ds = hs.derive(hc.hello());
    expect(dc.transcript.equals(ds.transcript)).toBe(true);
    const frame = dc.channel.seal({ hi: 1 });
    expect(ds.channel.open(frame)).toEqual({ hi: 1 });
    expect(dc.channel.open(ds.channel.seal(["back"]))).toEqual(["back"]);
    // Replay: the same frame again is out of order.
    expect(() => ds.channel.open(frame)).toThrow();
    // Tampering fails the tag.
    const bad = dc.channel.seal({ x: 2 });
    bad[bad.length - 1] ^= 1;
    expect(() => ds.channel.open(bad)).toThrow();
  });

  test("a different ephemeral key on one side (a man in the middle) breaks the transcript", () => {
    const hc = new Handshake("client", a, "alpha");
    const hs = new Handshake("server", b, "beta");
    const mitm = new Handshake("server", b, "beta");
    const dc = hc.derive(mitm.hello());
    const ds = hs.derive(hc.hello());
    expect(dc.transcript.equals(ds.transcript)).toBe(false);
    const sig = signTranscript(a, "client", dc.transcript);
    expect(verifyTranscript(a.publicKey, "client", ds.transcript, sig)).toBe(false);
  });

  test("signatures bind identity, role and transcript", () => {
    const hc = new Handshake("client", a, "alpha");
    const hs = new Handshake("server", b, "beta");
    const { transcript } = hc.derive(hs.hello());
    const sig = signTranscript(a, "client", transcript);
    expect(verifyTranscript(a.publicKey, "client", transcript, sig)).toBe(true);
    expect(verifyTranscript(b.publicKey, "client", transcript, sig)).toBe(false);
    expect(verifyTranscript(a.publicKey, "server", transcript, sig)).toBe(false);
    expect(verifyTranscript(a.publicKey, "client", transcript, "nope")).toBe(false);
    expect(verifyTranscript(a.publicKey, "client", transcript, 42)).toBe(false);
  });

  test("pairing proof needs the shared secret and the exact code", () => {
    const hc = new Handshake("client", a, "alpha");
    const hs = new Handshake("server", b, "beta");
    const dc = hc.derive(hs.hello());
    const ds = hs.derive(hc.hello());
    const code = newPairingCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(normalizeCode(code.toLowerCase().replace(/-/g, " "))).toBe(code.replace(/-/g, ""));
    const proof = dc.pairProof(code, "client").toString("base64url");
    expect(proofsEqual(ds.pairProof(code, "client"), proof)).toBe(true);
    expect(proofsEqual(ds.pairProof(newPairingCode(), "client"), proof)).toBe(false);
    const other = new Handshake("server", b, "beta").derive(hc.hello());
    expect(proofsEqual(other.pairProof(code, "client"), proof)).toBe(false);
    // The listener's proof is a different value: the joiner's cannot be echoed back as it.
    expect(proofsEqual(ds.pairProof(code, "server"), proof)).toBe(false);
    expect(proofsEqual(dc.pairProof(code, "server"), ds.pairProof(code, "server").toString("base64url"))).toBe(true);
  });

  test("fingerprints are stable and short", () => {
    expect(fingerprint(a.publicKey)).toBe(fingerprint(a.publicKey));
    expect(fingerprint(a.publicKey)).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(fingerprint(a.publicKey)).not.toBe(fingerprint(b.publicKey));
    expect(new Channel(Buffer.alloc(32, 1), Buffer.alloc(32, 2)).seal("x").length).toBeGreaterThan(28);
  });
});

// ---- two daemons ----

const daemonDir = join(import.meta.dir, "..");
const usedPorts = new Set<number>();
const randomPort = () => {
  let p: number;
  do p = 48000 + Math.floor(Math.random() * 500);
  while (usedPorts.has(p));
  usedPorts.add(p);
  return p;
};

interface Daemon {
  name: string;
  home: string;
  port: number;
  fedPort: number;
  base: string;
  proc: ReturnType<typeof Bun.spawn>;
}
const daemons: Daemon[] = [];

async function startDaemon(name: string): Promise<Daemon> {
  const home = mkdtempSync(join(tmpdir(), `henry-fed-${name}-`));
  const port = randomPort();
  const fedPort = randomPort();
  writeFileSync(join(home, "config.json"), JSON.stringify({ host: name, federation: { listen: "127.0.0.1", port: fedPort } }));
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
  const d: Daemon = { name, home, port, fedPort, base: `http://127.0.0.1:${port}`, proc };
  daemons.push(d);
  await waitFor(`daemon ${name}`, async () => {
    try {
      return (await fetch(`${d.base}/api/state`)).ok || undefined;
    } catch {
      return undefined;
    }
  }, 15000);
  return d;
}

const state = (d: Daemon) => fetch(`${d.base}/api/state`).then((r) => r.json()) as Promise<StateSnapshot>;
const fedStatus = (d: Daemon) => fetch(`${d.base}/api/federation/status`).then((r) => r.json()) as Promise<FederationStatus>;
const post = (d: Daemon, path: string, body: unknown = {}) =>
  fetch(`${d.base}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

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
  seen(id: string, needle: string, ms = 10000) {
    return waitFor(`output ${needle}`, () => ((this.output.get(id) ?? "").includes(needle) ? true : undefined), ms);
  }
  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

/**
 * A daemon dialed in to `url` as `me`, speaking the wire protocol directly (what a peer's
 * daemon would send). Lets a test send frames no well-behaved daemon emits.
 */
async function rawPeer(url: string, me: IdentityKeys, name: string): Promise<{ send(m: unknown): void; next(type: string, ms?: number): Promise<Record<string, unknown> | undefined>; close(): void }> {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const hs = new Handshake("client", me, name);
  const inbox: Record<string, unknown>[] = [];
  let derived: Derived | undefined;
  await new Promise<void>((resolve, reject) => {
    ws.onerror = () => reject(new Error(`cannot reach ${url}`));
    ws.onclose = (ev) => reject(new Error(ev.reason || `closed (${ev.code})`));
    ws.onopen = () => ws.send(JSON.stringify(hs.hello()));
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const m = JSON.parse(ev.data);
        if (!isHello(m)) return reject(new Error("bad hello"));
        derived = hs.derive(m);
        ws.send(derived.channel.seal({ t: "auth", sig: signTranscript(me, "client", derived.transcript) }));
        return;
      }
      const m = derived!.channel.open(new Uint8Array(ev.data as ArrayBuffer)) as Record<string, unknown>;
      if (m.t === "err") return reject(new Error(String(m.reason)));
      if (m.t === "ok") return resolve();
      inbox.push(m);
    };
  });
  ws.onclose = null;
  return {
    send: (m) => ws.send(derived!.channel.seal(m)),
    next: (type, ms = 1500) =>
      waitFor(type, () => {
        const i = inbox.findIndex((m) => m.type === type);
        return i >= 0 ? inbox.splice(i, 1)[0] : undefined;
      }, ms).catch(() => undefined),
    close: () => ws.close(),
  };
}

/** A listener that runs the handshake correctly but accepts any pairing: it never saw the code. */
function fakeListener(): { port: number; stop(): void } {
  const id = newIdentity();
  const srv = Bun.serve<{ hs: Handshake; derived?: Derived }>({
    hostname: "127.0.0.1",
    port: randomPort(),
    fetch(req, s) {
      return s.upgrade(req, { data: { hs: new Handshake("server", id, "impostor") } }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        if (typeof raw === "string") {
          const m = JSON.parse(raw);
          ws.send(JSON.stringify(ws.data.hs.hello()));
          ws.data.derived = ws.data.hs.derive(m);
          return;
        }
        const d = ws.data.derived!;
        d.channel.open(raw as Uint8Array);
        ws.send(d.channel.seal({ t: "ok", name: "impostor", sig: signTranscript(id, "server", d.transcript) }));
      },
    },
  });
  return { port: srv.port!, stop: () => srv.stop(true) };
}

afterAll(async () => {
  for (const d of daemons) {
    try {
      d.proc.kill();
      await d.proc.exited;
    } catch {}
  }
  for (const d of daemons) {
    await stopSessiond(d.home);
    rmSync(d.home, { recursive: true, force: true });
  }
});

describe("two daemons", () => {
  let alpha: Daemon;
  let beta: Daemon;
  let betaSession = "";

  test("both listen on loopback with their own identity, 0600 on disk", async () => {
    [alpha, beta] = await Promise.all([startDaemon("alpha"), startDaemon("beta")]);
    const [sa, sb] = await Promise.all([fedStatus(alpha), fedStatus(beta)]);
    expect(sa.listening).toEqual({ address: "127.0.0.1", port: alpha.fedPort });
    expect(sb.listening).toEqual({ address: "127.0.0.1", port: beta.fedPort });
    expect(sa.fingerprint).not.toBe(sb.fingerprint);
    expect(sa.peers).toEqual([]);
    // Windows has no POSIX mode bits to check.
    if (process.platform !== "win32") expect(statSync(join(alpha.home, "federation.json")).mode & 0o777).toBe(0o600);
    const s = await state(alpha);
    expect(s.host).toBe("alpha");
    expect(s.peers).toEqual([]);
  }, 30000);

  test("pairing needs an open window and the right code; a wrong code is refused", async () => {
    const early = await post(alpha, "/api/federation/pair", { address: `127.0.0.1:${beta.fedPort}`, code: "AAAA-AAAA-AAAA" });
    expect(early.status).toBe(502);
    expect(((await early.json()) as { error: string }).error).toContain("no pairing in progress");

    const { code } = (await (await post(beta, "/api/federation/pairing/start")).json()) as { code: string };
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await fedStatus(beta)).pairing?.code).toBe(code);

    const wrong = await post(alpha, "/api/federation/pair", { address: `127.0.0.1:${beta.fedPort}`, code: "AAAA-AAAA-AAAA" });
    expect(wrong.status).toBe(502);
    expect(((await wrong.json()) as { error: string }).error).toContain("wrong pairing code");
    expect((await fedStatus(alpha)).peers).toEqual([]);

    const ok = await post(alpha, "/api/federation/pair", { address: `127.0.0.1:${beta.fedPort}`, code: code.toLowerCase() });
    expect(ok.status).toBe(200);
    const { peer } = (await ok.json()) as { peer: { name: string; fingerprint: string; url: string } };
    expect(peer.name).toBe("beta");
    expect(peer.fingerprint).toBe((await fedStatus(beta)).fingerprint);
    expect(peer.url).toBe(`ws://127.0.0.1:${beta.fedPort}/fed`);
    // The code is spent.
    expect((await fedStatus(beta)).pairing).toBeUndefined();
    const again = await post(alpha, "/api/federation/pair", { address: `127.0.0.1:${beta.fedPort}`, code });
    expect(again.status).toBe(502);
  }, 30000);

  test("links come up both ways: alpha dials beta, beta dials the url alpha advertised", async () => {
    await waitFor("alpha → beta", async () => ((await fedStatus(alpha)).peers[0]?.link === "connected" ? true : undefined));
    await waitFor("beta → alpha", async () => {
      const p = (await fedStatus(beta)).peers.find((x) => x.name === "alpha");
      return p?.link === "connected" && p.inbound ? true : undefined;
    });
    const sa = await fedStatus(alpha);
    expect(sa.peers[0]).toMatchObject({ name: "beta", link: "connected", inbound: true, enabled: true, sessions: 0 });
  }, 30000);

  test("a session on beta shows up in alpha tagged with the peer, and its terminal works through alpha", async () => {
    const wb = await new Win().open(beta);
    wb.send({ type: "session:create", cwd: beta.home, title: "on-beta", command: testShell.command, args: testShell.args, requestId: "b1" });
    const created = await wb.next("session:update", (m) => m.requestId === "b1");
    betaSession = created.session.id;
    expect(created.session.peer).toBeUndefined();
    expect(created.session.host).toBe("beta");

    const wa = await new Win().open(alpha);
    const relayed = await waitFor("session in alpha", async () => (await state(alpha)).sessions.find((s) => s.id === betaSession));
    expect(relayed.peer).toBe("beta");
    expect(relayed.host).toBe("beta");
    expect(relayed.title).toBe("on-beta");
    expect((await fedStatus(alpha)).peers[0]?.sessions).toBe(1);
    // Beta's own view never carries a peer tag for its own session, and alpha's sessions are not on beta.
    expect((await state(beta)).sessions.find((s) => s.id === betaSession)?.peer).toBeUndefined();

    wa.send({ type: "attach", sessionId: betaSession });
    const sb = await wa.next("pty:scrollback", (m) => m.sessionId === betaSession);
    expect(typeof sb.data).toBe("string");
    wa.send({ type: "pty:resize", sessionId: betaSession, cols: 90, rows: 24 });
    wa.send({ type: "pty:input", sessionId: betaSession, data: echoExpr("fed", "40+2") });
    await wa.seen(betaSession, "fed-42");
    wa.send({ type: "pty:input", sessionId: betaSession, data: isWindows ? 'echo "size=$($host.UI.RawUI.WindowSize.Height) $($host.UI.RawUI.WindowSize.Width)"\r' : "echo size=$(stty size)\r" });
    await wa.seen(betaSession, "size=24 90");

    // A second window attaching gets its own scrollback with the echo in it.
    const wa2 = await new Win().open(alpha);
    wa2.send({ type: "attach", sessionId: betaSession });
    const sb2 = await wa2.next("pty:scrollback", (m) => m.sessionId === betaSession);
    expect(sb2.data).toContain("fed-42");
    wa2.send({ type: "detach", sessionId: betaSession });
    // The first window still streams after the second detached.
    wa.send({ type: "pty:input", sessionId: betaSession, data: echoExpr("still", "1+1") });
    await wa.seen(betaSession, "still-2");
    wa2.close();
    wa.close();
    wb.close();
  }, 30000);

  test("/api/* for a peer's session is answered by the peer; federation endpoints never are", async () => {
    const files = (await (await fetch(`${alpha.base}/api/session/files?sessionId=${betaSession}`)).json()) as { sessionId: string; repos: unknown[] };
    expect(files.sessionId).toBe(betaSession);
    const repos = await fetch(`${alpha.base}/api/repos?peer=beta`);
    expect(repos.status).toBe(200);
    expect(Array.isArray(await repos.json())).toBe(true);
    const peek = (await (await fetch(`${alpha.base}/api/file?peer=beta&path=${encodeURIComponent(join(beta.home, "config.json"))}`)).json()) as { content: string };
    expect(peek.content).toContain('"host":"beta"');
    const nope = await fetch(`${alpha.base}/api/repos?peer=gamma`);
    expect(nope.status).toBe(502);
    const forbidden = await fetch(`${alpha.base}/api/federation/status?peer=beta`);
    expect(forbidden.status).toBe(200);
    expect(((await forbidden.json()) as FederationStatus).name).toBe("alpha");
    // A peer is never handed the config (it can hold an API key) and may not change ours.
    const relayedState = (await (await fetch(`${alpha.base}/api/state?peer=beta`)).json()) as Record<string, unknown>;
    expect(relayedState.config).toBeUndefined();
    expect(Array.isArray(relayedState.sessions)).toBe(true);
    const write = await fetch(`${alpha.base}/api/config?peer=beta`, { method: "POST", body: JSON.stringify({ reposRoot: "/tmp" }), headers: { "content-type": "application/json" } });
    expect(write.status).toBe(403);
  }, 30000);

  test("a listener that does not know the code cannot get itself paired", async () => {
    const fake = fakeListener();
    try {
      const before = (await fedStatus(alpha)).peers.length;
      const res = await post(alpha, "/api/federation/pair", { address: `127.0.0.1:${fake.port}`, code: newPairingCode() });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toContain("does not know this pairing code");
      expect((await fedStatus(alpha)).peers.length).toBe(before);
    } finally {
      fake.stop();
    }
  }, 30000);

  test("a peer cannot reach our other peers through us", async () => {
    // gamma pairs with alpha only. beta, dialed in to alpha, must not see or drive gamma.
    const gamma = await startDaemon("gamma");
    const { code } = (await (await post(gamma, "/api/federation/pairing/start")).json()) as { code: string };
    expect((await post(alpha, "/api/federation/pair", { address: `127.0.0.1:${gamma.fedPort}`, code })).status).toBe(200);
    await waitFor("alpha → gamma", async () => ((await fedStatus(alpha)).peers.find((p) => p.name === "gamma")?.link === "connected" ? true : undefined));
    const wg = await new Win().open(gamma);
    wg.send({ type: "session:create", cwd: gamma.home, title: "on-gamma", command: testShell.command, args: testShell.args, requestId: "g1" });
    const gammaSession = (await wg.next("session:update", (m) => m.requestId === "g1")).session.id;
    await waitFor("gamma's session in alpha", async () => (await state(alpha)).sessions.find((s) => s.id === gammaSession));

    const betaId = (JSON.parse(readFileSync(join(beta.home, "federation.json"), "utf8")) as { identity: IdentityKeys }).identity;
    const alphaUrl = (await fedStatus(beta)).peers.find((p) => p.name === "alpha")!.url!;
    const asBeta = await rawPeer(alphaUrl, betaId, "beta");
    // What alpha shows a peer is its own state: gamma's session is not in it.
    const shown = (await asBeta.next("state", 5000)) as { sessions: { id: string }[] };
    expect(shown.sessions.some((s) => s.id === gammaSession)).toBe(false);

    asBeta.send({ type: "session:create", peer: "gamma", cwd: gamma.home, title: "via-alpha", command: testShell.command, args: testShell.args, requestId: "x1" });
    asBeta.send({ type: "attach", sessionId: gammaSession, reqId: "x2" });
    asBeta.send({ type: "pty:input", sessionId: gammaSession, data: echoExpr("leaked", "5+5") });
    expect(await asBeta.next("session:update")).toBeUndefined();
    expect(await asBeta.next("pty:scrollback")).toBeUndefined();
    // The channel itself is fine: a request for alpha's own state is answered.
    asBeta.send({ type: "state:request" });
    expect(await asBeta.next("state", 5000)).toBeDefined();
    expect((await state(gamma)).sessions.length).toBe(1);
    wg.send({ type: "attach", sessionId: gammaSession });
    await wg.next("pty:scrollback");
    wg.send({ type: "pty:input", sessionId: gammaSession, data: echoExpr("mine", "1+1") });
    await wg.seen(gammaSession, "mine-2");
    expect(wg.output.get(gammaSession)).not.toContain("leaked-10");
    asBeta.close();
    wg.close();
  }, 60000);

  test("killing through alpha ends the session on beta; forgetting the peer drops its sessions", async () => {
    const wa = await new Win().open(alpha);
    wa.send({ type: "session:kill", sessionId: betaSession });
    const ended = await wa.next("session:update", (m) => m.session.id === betaSession && m.session.status === "exited");
    expect(ended.session.peer).toBe("beta");
    expect((await state(beta)).sessions.find((s) => s.id === betaSession)?.status).toBe("exited");

    expect((await post(alpha, "/api/federation/peer/forget", { name: "beta" })).status).toBe(200);
    await wa.next("peers:update", (m) => !m.peers.some((p) => p.name === "beta"));
    expect((await state(alpha)).sessions.find((s) => s.id === betaSession)).toBeUndefined();
    // Beta still remembers alpha but can no longer connect: alpha refuses the unknown key.
    await waitFor("beta's redial refused as unpaired", async () => {
      const p = (await fedStatus(beta)).peers.find((x) => x.name === "alpha");
      return p && p.link !== "connected" && !p.inbound && p.error?.includes("not paired") ? true : undefined;
    });
    wa.close();
  }, 30000);
});
