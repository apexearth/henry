// The dialing side of a federation link: connects to a paired daemon, authenticates, then
// mirrors that daemon's sessions (tagged `peer`) and relays PTY traffic and requests for
// the windows attached here. When the link drops, its sessions leave the rail until it is
// back; nothing about them is persisted here, the peer's own DB has all of it.
import type { Flag, PlaybookEntry, RepoState, ServerMessage, Session, SessionUsage, StateSnapshot } from "@henry/shared";
import { FED_VERSION, Handshake, fingerprint, isHello, proofsEqual, signTranscript, verifyTranscript, type Channel, type Derived, type IdentityKeys } from "./fed-crypto";
import type { FedRequest, FedResponse, PeerRecord } from "./federation";

/** What one daemon shows another: its own state minus config and window concerns. */
export type FedState = Omit<StateSnapshot, "config" | "uiBuild" | "peers" | "host" | "firstRun">;

export interface LinkDeps {
  /** Every window of this daemon, and nobody else (relayed messages must not fan back out). */
  toWindows(msg: ServerMessage): void;
  /** PTY traffic to the windows attached to one session. */
  publishSession(sessionId: string, msg: ServerMessage): void;
  /** The merged snapshot windows expect (server.buildState). */
  buildState(): StateSnapshot;
}

export interface LinkIdentity {
  identity: IdentityKeys;
  name: string;
}

type Status = "connecting" | "connected" | "offline";
type Handshaken = { ws: WebSocket; channel: Channel; theirName: string; theirKey: string };

const CONNECT_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const KEEP_FLAGS = 500;
const KEEP_PLAYBOOK = 200;

/**
 * Open a socket to `url` and run the handshake as the client. `auth` pins a known identity;
 * `pair` proves a pairing code and accepts whatever identity answers (the caller stores it).
 */
async function dial(
  url: string,
  me: LinkIdentity,
  mode: { t: "auth"; publicKey: string } | { t: "pair"; code: string; listenUrl?: string },
): Promise<Handshaken> {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const hs = new Handshake("client", me.identity, me.name);
  let derived: Derived | undefined;
  let theirHello: ReturnType<Handshake["hello"]> | undefined;
  return new Promise<Handshaken>((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error("handshake timeout")), CONNECT_TIMEOUT_MS);
    let done = false;
    // Reject before closing: Bun runs onclose synchronously inside close(), and that must
    // not overwrite the real reason with "closed (1000)".
    const fail = (e: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
      try {
        ws.close();
      } catch {}
    };
    ws.onerror = () => fail(new Error(`cannot reach ${url}`));
    ws.onclose = (ev) => fail(new Error(ev.reason || `closed (${ev.code})`));
    ws.onopen = () => ws.send(JSON.stringify(hs.hello()));
    ws.onmessage = (ev) => {
      try {
        if (typeof ev.data === "string") {
          if (derived) throw new Error("second hello");
          const m = JSON.parse(ev.data);
          if (!isHello(m)) throw new Error("bad hello");
          if (m.v !== FED_VERSION) throw new Error(`peer speaks protocol v${m.v}, this daemon v${FED_VERSION}`);
          if (mode.t === "auth" && m.id !== mode.publicKey) throw new Error(`identity changed: ${fingerprint(m.id)} is not the paired ${fingerprint(mode.publicKey)}`);
          theirHello = m;
          derived = hs.derive(m);
          const sig = signTranscript(me.identity, "client", derived.transcript);
          const auth =
            mode.t === "auth" ? { t: "auth", sig } : { t: "pair", sig, proof: derived.pairProof(mode.code, "client").toString("base64url"), listenUrl: mode.listenUrl };
          ws.send(derived.channel.seal(auth));
          return;
        }
        if (!derived || !theirHello) throw new Error("binary before hello");
        const m = derived.channel.open(new Uint8Array(ev.data as ArrayBuffer)) as { t?: string; reason?: string; sig?: unknown; name?: string; proof?: unknown };
        if (m.t === "err") throw new Error(m.reason || "refused");
        if (m.t !== "ok") throw new Error("expected ok");
        if (!verifyTranscript(theirHello.id, "server", derived.transcript, m.sig)) throw new Error("peer failed to prove its identity");
        // Whoever answered must hold the code too; otherwise we would pin a stranger's key.
        if (mode.t === "pair" && !proofsEqual(derived.pairProof(mode.code, "server"), m.proof)) throw new Error("the daemon at that address does not know this pairing code");
        clearTimeout(timer);
        done = true;
        ws.onerror = ws.onclose = ws.onmessage = null;
        resolve({ ws, channel: derived.channel, theirName: typeof m.name === "string" ? m.name : theirHello.name, theirKey: theirHello.id });
      } catch (e) {
        fail(e as Error);
      }
    };
  });
}

export class PeerLink {
  status: Status = "connecting";
  error?: string;
  readonly url: string;
  /** The peer's sessions, already tagged with `peer`. */
  sessions = new Map<string, Session>();
  repos: Record<string, RepoState[]> = {};
  flags: Flag[] = [];
  usage: Record<string, SessionUsage> = {};
  playbook: PlaybookEntry[] = [];

  private ws?: WebSocket;
  private channel?: Channel;
  private closed = false;
  private backoff = BACKOFF_MIN_MS;
  private retry?: ReturnType<typeof setTimeout>;
  private attachWaiters = new Map<string, (data: string, exitCode?: number) => void>();
  private attachCount = new Map<string, number>();
  private createWaiters = new Map<string, (s: Session) => void>();
  private httpWaiters = new Map<string, (r: Extract<FedResponse, { type: "http:res" }>) => void>();

  constructor(
    readonly rec: PeerRecord,
    private readonly me: LinkIdentity,
    private readonly deps: LinkDeps,
    private readonly on: { onStatus(): void; onConnected(): void },
  ) {
    this.url = rec.url!;
  }

  /** One-shot: pair with the daemon at `url`. Resolves with its identity; the socket is closed. */
  static async pair(url: string, code: string, me: LinkIdentity, listenUrl: string | undefined): Promise<{ name: string; publicKey: string }> {
    const h = await dial(url, me, { t: "pair", code, listenUrl });
    try {
      h.ws.close();
    } catch {}
    return { name: h.theirName, publicKey: h.theirKey };
  }

  connect(): void {
    if (this.closed) return;
    this.setStatus("connecting");
    dial(this.url, this.me, { t: "auth", publicKey: this.rec.publicKey })
      .then((h) => this.attach_(h))
      .catch((e: Error) => this.lost(e.message));
  }

  private attach_(h: Handshaken): void {
    if (this.closed) {
      h.ws.close();
      return;
    }
    this.ws = h.ws;
    this.channel = h.channel;
    this.backoff = BACKOFF_MIN_MS;
    this.error = undefined;
    h.ws.onmessage = (ev) => {
      try {
        if (typeof ev.data === "string") throw new Error("text frame after handshake");
        this.handle(this.channel!.open(new Uint8Array(ev.data as ArrayBuffer)) as FedResponse);
      } catch (e) {
        console.error(`[fed] ${this.rec.name}: ${(e as Error).message}`);
        h.ws.close();
      }
    };
    h.ws.onclose = (ev) => this.lost(ev.reason || "connection closed");
    h.ws.onerror = () => h.ws.close();
    this.setStatus("connected");
    this.on.onConnected();
    console.log(`[fed] connected to ${this.rec.name} at ${this.url}`);
  }

  private lost(why: string): void {
    const had = this.status === "connected";
    this.ws = undefined;
    this.channel = undefined;
    this.error = why;
    const gone = this.sessions.size > 0;
    this.sessions.clear();
    this.repos = {};
    this.flags = [];
    this.usage = {};
    this.playbook = [];
    for (const w of this.httpWaiters.values()) w({ type: "http:res", id: "", status: 502, contentType: "application/json", body: JSON.stringify({ error: `${this.rec.name}: ${why}` }) });
    this.httpWaiters.clear();
    this.attachWaiters.clear();
    this.attachCount.clear();
    this.createWaiters.clear();
    if (this.closed) return;
    if (had) console.error(`[fed] lost ${this.rec.name}: ${why}`);
    this.setStatus("offline");
    if (gone) this.deps.toWindows({ type: "state", ...this.deps.buildState() });
    this.retry = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close(1000, "link closed");
    } catch {}
    const gone = this.sessions.size > 0;
    this.sessions.clear();
    if (gone) this.deps.toWindows({ type: "state", ...this.deps.buildState() });
  }

  private setStatus(s: Status): void {
    if (this.status === s) return;
    this.status = s;
    this.on.onStatus();
  }

  send(msg: FedRequest): void {
    if (this.ws?.readyState === 1 && this.channel) this.ws.send(this.channel.seal(msg));
  }

  private tag(s: Session): Session {
    return { ...s, peer: this.rec.name };
  }

  private handle(m: FedResponse): void {
    switch (m.type) {
      case "state": {
        this.sessions = new Map(m.sessions.map((s) => [s.id, this.tag(s)]));
        this.repos = m.repos;
        this.flags = m.flags;
        this.usage = m.usage.perSession;
        this.playbook = m.playbook.filter((p) => p.sessionId !== null);
        this.deps.toWindows({ type: "state", ...this.deps.buildState() });
        return;
      }
      case "session:update": {
        const session = this.tag(m.session);
        this.sessions.set(session.id, session);
        const waiter = m.requestId !== undefined ? this.createWaiters.get(m.requestId) : undefined;
        if (waiter) {
          this.createWaiters.delete(m.requestId!);
          waiter(session);
        } else this.deps.toWindows({ type: "session:update", session });
        return;
      }
      case "pty:data":
      case "pty:exit":
        this.deps.publishSession(m.sessionId, m);
        return;
      case "pty:scrollback": {
        const w = m.reqId !== undefined ? this.attachWaiters.get(m.reqId) : undefined;
        if (!w) return;
        this.attachWaiters.delete(m.reqId!);
        w(m.data, m.exitCode);
        return;
      }
      case "repos:update":
        this.repos = { ...this.repos, [m.sessionId]: m.repos };
        this.deps.toWindows(m);
        return;
      case "usage:update":
        this.usage = m.usage.perSession;
        this.deps.toWindows({ type: "usage:update", usage: this.deps.buildState().usage });
        return;
      case "flag":
        this.flags = [m.flag, ...this.flags.filter((f) => f.id !== m.flag.id)].slice(0, KEEP_FLAGS);
        this.deps.toWindows(m);
        return;
      case "playbook:update":
        if (m.entry.sessionId === null) return;
        this.playbook = [m.entry, ...this.playbook.filter((p) => p.id !== m.entry.id)].slice(0, KEEP_PLAYBOOK);
        this.deps.toWindows(m);
        return;
      case "event":
      case "repo:diff":
        this.deps.toWindows(m);
        return;
      case "http:res": {
        const w = this.httpWaiters.get(m.id);
        if (w) {
          this.httpWaiters.delete(m.id);
          w(m);
        }
        return;
      }
      case "peers:update":
      case "ui:build":
        return;
    }
  }

  /** Scrollback for one window; live output for the session keeps flowing while any window is attached. */
  attach(sessionId: string, cb: (data: string, exitCode?: number) => void): void {
    const reqId = crypto.randomUUID();
    this.attachWaiters.set(reqId, cb);
    this.attachCount.set(sessionId, (this.attachCount.get(sessionId) ?? 0) + 1);
    this.send({ type: "attach", sessionId, reqId });
  }

  detach(sessionId: string): void {
    const n = (this.attachCount.get(sessionId) ?? 1) - 1;
    if (n > 0) {
      this.attachCount.set(sessionId, n);
      return;
    }
    this.attachCount.delete(sessionId);
    this.send({ type: "detach", sessionId });
  }

  create(msg: Extract<FedRequest, { type: "session:create" }>, cb: (s: Session) => void): void {
    const requestId = msg.requestId ?? crypto.randomUUID();
    this.createWaiters.set(requestId, cb);
    this.send({ ...msg, requestId, peer: undefined });
  }

  markRead(ids: string[]): void {
    this.flags = this.flags.map((f) => (ids.includes(f.id) ? { ...f, read: true } : f));
    this.send({ type: "flags:markRead", ids });
  }

  /** Run an /api/* request on the peer. `path` includes the query string. */
  http(method: string, path: string, body?: string): Promise<Response> {
    return new Promise((resolve) => {
      if (this.status !== "connected") {
        resolve(new Response(JSON.stringify({ error: `${this.rec.name} is ${this.status}` }), { status: 502, headers: { "content-type": "application/json" } }));
        return;
      }
      const id = crypto.randomUUID();
      this.httpWaiters.set(id, (r) => resolve(new Response(r.body, { status: r.status, headers: { "content-type": r.contentType } })));
      this.send({ type: "http", id, method, path, body });
    });
  }
}
