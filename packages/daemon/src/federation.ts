// Sessions on other machines. Every machine runs its own daemon (hooks, git and transcripts
// are local files); this module links daemons so one window shows them all. A link is a
// WebSocket between two daemons: the dialer sees the listener's sessions and drives them
// (attach, type, resize, create, kill, the /api/* it needs), the listener sees nothing of
// the dialer's. Two machines that both listen dial each other and each sees the other.
//
// Trust is by identity key, established once by pairing (see fed-crypto.ts for the
// handshake). The listener binds the Tailscale address only, by default, and serves nothing
// but /fed. A paired machine is you: it can do to this daemon's sessions whatever a window
// here can. Nothing here is ever offered to a peer: /api/federation/*, /hook, /statusline,
// the UI. See PLAN.md "Federation".
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { ClientMessage, FederationStatus, PeerStatus, ServerMessage, StateSnapshot } from "@henry/shared";
import { config, henryDir, onConfigReload } from "./config";
import { FED_VERSION, Handshake, fingerprint, isHello, newIdentity, newPairingCode, normalizeCode, proofsEqual, signTranscript, verifyTranscript, type Derived, type IdentityKeys } from "./fed-crypto";
import { PeerLink, type FedState, type LinkDeps } from "./fed-peer";
import { localHost } from "./sessions";

/** A window or a peer link, as server.ts drives it. */
export interface Client {
  attached: Set<string>;
  readonly open: boolean;
  /** A dialed-in daemon. It gets this daemon's sessions only, never those relayed from other peers. */
  readonly fromPeer: boolean;
  send(msg: ServerMessage): void;
  subscribe(sessionId: string): void;
  unsubscribe(sessionId: string): void;
}

export interface PeerRecord {
  name: string;
  /** Ed25519 public key, base64url. Trusted inbound by this key; pinned outbound. */
  publicKey: string;
  /** ws://host:port/fed to dial; absent for a peer that only reaches us. */
  url?: string;
  pairedAt: number;
  lastSeenAt?: number;
  enabled: boolean;
}

interface Store {
  identity: IdentityKeys;
  peers: PeerRecord[];
}

/** Frames a dialer may send after the handshake. */
export type FedRequest = ClientMessage | { type: "http"; id: string; method: string; path: string; body?: string };
/** Frames a listener sends after the handshake. */
export type FedResponse = ServerMessage | { type: "http:res"; id: string; status: number; contentType: string; body: string };

export interface Deps extends LinkDeps {
  handleMessage(client: Client, msg: ClientMessage): Promise<void>;
  /** Only this daemon's own sessions etc.: what a peer is shown. */
  localState(): FedState;
  /** /api/* on behalf of a peer; the handler refuses federation endpoints. */
  handleApi(req: Request, fromPeer: boolean): Promise<Response>;
}

const storePath = join(henryDir, "federation.json");
const PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_MAX_ATTEMPTS = 5;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const LOCKOUT_FAILURES = 5;
const LOCKOUT_MS = 60_000;
const REBIND_CHECK_MS = 30_000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

let deps: Deps;
let store: Store;
const links = new Map<string, PeerLink>();
const inbound = new Set<Inbound>();
let listener: ReturnType<typeof Bun.serve<Inbound>> | undefined;
let listening: { address: string; port: number } | undefined;
let listenError: string | undefined;
let rebindTimer: ReturnType<typeof setInterval> | undefined;
let pairing: { code: string; expiresAt: number; attempts: number; timer: ReturnType<typeof setTimeout> } | undefined;
const failures = new Map<string, { n: number; until: number }>();

// ---- store ----

function loadStore(): Store {
  let s: Partial<Store> = {};
  if (existsSync(storePath)) {
    try {
      s = JSON.parse(readFileSync(storePath, "utf8"));
    } catch (e) {
      console.error(`[fed] could not parse ${storePath}: ${(e as Error).message}; starting over`);
    }
  }
  const fresh = !s.identity?.publicKey || !s.identity.privateKey;
  const out: Store = {
    identity: fresh ? newIdentity() : s.identity!,
    peers: (s.peers ?? []).filter((p) => p && typeof p.name === "string" && typeof p.publicKey === "string").map((p) => ({ ...p, enabled: p.enabled !== false })),
  };
  if (fresh || !existsSync(storePath)) saveStore(out);
  return out;
}

/** Private key inside: 0600, written atomically. */
function saveStore(s: Store = store): void {
  const tmp = `${storePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, storePath);
}

export const identityFingerprint = () => fingerprint(store.identity.publicKey);

function uniqueName(wanted: string, publicKey: string): string {
  const base = NAME_RE.test(wanted) ? wanted : "peer";
  let name = base;
  for (let i = 2; store.peers.some((p) => p.name === name && p.publicKey !== publicKey); i++) name = `${base}-${i}`;
  return name;
}

/** Add or refresh a peer after a successful pairing (either side). */
function rememberPeer(wantedName: string, publicKey: string, url: string | undefined): PeerRecord {
  let rec = store.peers.find((p) => p.publicKey === publicKey);
  if (!rec) {
    rec = { name: uniqueName(wantedName, publicKey), publicKey, pairedAt: Date.now(), enabled: true };
    store.peers.push(rec);
  }
  if (url) rec.url = url;
  rec.lastSeenAt = Date.now();
  saveStore();
  syncLinks();
  return rec;
}

function touch(rec: PeerRecord): void {
  rec.lastSeenAt = Date.now();
  saveStore();
}

// ---- listener ----

/** The Tailscale IPv4 address (CGNAT 100.64.0.0/10) of this machine, if it has one. */
export function tailscaleAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [x, y] = a.address.split(".").map(Number);
      if (x === 100 && y! >= 64 && y! <= 127) return a.address;
    }
  }
  return undefined;
}

function resolveListen(): { address?: string; error?: string } {
  const want = config.federation.listen;
  if (want === "off") return { error: "federation.listen is off" };
  if (want === "tailscale") {
    const address = tailscaleAddress();
    return address ? { address } : { error: "no Tailscale address on this machine (federation.listen: tailscale)" };
  }
  if (want === "0.0.0.0") console.error("[fed] listening on every interface; only paired machines can connect, but anyone can knock");
  return { address: want };
}

function startListener(): void {
  stopListener();
  const { address, error } = resolveListen();
  listenError = error;
  if (!address) return;
  const port = config.federation.port;
  try {
    listener = Bun.serve<Inbound>({
      hostname: address,
      port,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname !== "/fed") return new Response("not found", { status: 404 });
        const ip = srv.requestIP(req)?.address ?? "?";
        const lock = failures.get(ip);
        if (lock && lock.n >= LOCKOUT_FAILURES && Date.now() < lock.until) return new Response("locked", { status: 429 });
        const ok = srv.upgrade(req, { data: new Inbound(ip) });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        maxPayloadLength: 16 * 1024 * 1024,
        open(ws) {
          ws.data.opened(ws);
        },
        message(ws, raw) {
          ws.data.message(raw);
        },
        close(ws) {
          ws.data.closed();
        },
      },
    });
    listening = { address, port };
    console.log(`[fed] listening on ws://${address}:${port}/fed as ${localName()} (${identityFingerprint()})`);
  } catch (e) {
    listenError = `cannot listen on ${address}:${port}: ${(e as Error).message}`;
    console.error(`[fed] ${listenError}`);
  }
  notifyPeers();
}

function stopListener(): void {
  for (const c of inbound) c.close(1001, "listener stopping");
  listener?.stop(true);
  listener = undefined;
  listening = undefined;
}

function noteFailure(ip: string): void {
  const f = failures.get(ip) ?? { n: 0, until: 0 };
  f.n++;
  if (f.n >= LOCKOUT_FAILURES) f.until = Date.now() + LOCKOUT_MS;
  failures.set(ip, f);
}

/** The URL peers should dial to reach us, when we listen on a real address. */
function advertisedUrl(): string | undefined {
  if (!listening || listening.address === "0.0.0.0") return undefined;
  return `ws://${listening.address}:${listening.port}/fed`;
}

/** One dialed-in daemon: handshake, then a Client that server.ts drives like a window. */
class Inbound implements Client {
  ws!: ServerWebSocket<Inbound>;
  private hs = new Handshake("server", store.identity, localName());
  private derived?: Derived;
  peer?: PeerRecord;
  private timer?: ReturnType<typeof setTimeout>;
  attached = new Set<string>();
  readonly fromPeer = true;
  private subscribed = new Set<string>();

  constructor(readonly ip: string) {}

  get open(): boolean {
    return this.ws.readyState === 1 && !!this.peer;
  }

  opened(ws: ServerWebSocket<Inbound>): void {
    this.ws = ws;
    inbound.add(this);
    this.timer = setTimeout(() => this.fail("handshake timeout"), HANDSHAKE_TIMEOUT_MS);
  }

  send(msg: ServerMessage | FedResponse): void {
    if (this.ws.readyState !== 1 || !this.derived) return;
    this.ws.send(this.derived.channel.seal(msg));
  }

  subscribe(id: string): void {
    this.subscribed.add(id);
  }

  unsubscribe(id: string): void {
    this.subscribed.delete(id);
  }

  subscribedTo(id: string): boolean {
    return this.subscribed.has(id);
  }

  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason);
    } catch {}
  }

  private fail(reason: string): void {
    console.error(`[fed] refused ${this.ip}: ${reason}`);
    noteFailure(this.ip);
    if (!this.derived) return this.close(4003, reason);
    // Say why inside the channel, then close once the frame has had a chance to go out.
    this.send({ t: "err", reason } as unknown as ServerMessage);
    this.derived = undefined;
    setTimeout(() => this.close(4003, reason), 100);
  }

  message(raw: string | Buffer): void {
    try {
      if (typeof raw === "string") return this.hello(raw);
      if (!this.derived) return this.fail("binary before hello");
      const msg = this.derived.channel.open(raw) as { t?: string; type?: string };
      if (!this.peer) return this.authenticate(msg);
      this.serve(msg as FedRequest);
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  private hello(raw: string): void {
    if (this.derived) return this.fail("second hello");
    let m: unknown;
    try {
      m = JSON.parse(raw);
    } catch {
      return this.fail("bad hello");
    }
    if (!isHello(m)) return this.fail("bad hello");
    if (m.v !== FED_VERSION) return this.fail(`protocol v${m.v}, this daemon speaks v${FED_VERSION}`);
    this.ws.send(JSON.stringify(this.hs.hello()));
    this.derived = this.hs.derive(m);
    this.theirHello = m;
  }

  private theirHello?: ReturnType<Handshake["hello"]>;

  private authenticate(msg: { t?: string; sig?: unknown; proof?: unknown; listenUrl?: unknown }): void {
    const { transcript } = this.derived!;
    const them = this.theirHello!;
    if (!verifyTranscript(them.id, "client", transcript, msg.sig)) return this.fail("bad signature");
    // Our own proof of the code goes back in the ok, so the joiner knows it reached the
    // daemon the code was shown on, not whatever answered at that address.
    let proof: string | undefined;
    if (msg.t === "auth") {
      const rec = store.peers.find((p) => p.publicKey === them.id);
      if (!rec) return this.fail(`unknown identity ${fingerprint(them.id)} (not paired)`);
      if (!rec.enabled) return this.fail(`peer ${rec.name} is disabled`);
      this.peer = rec;
      touch(rec);
    } else if (msg.t === "pair") {
      if (!pairing || Date.now() > pairing.expiresAt) return this.fail("no pairing in progress");
      if (!proofsEqual(this.derived!.pairProof(pairing.code, "client"), msg.proof)) {
        if (++pairing.attempts >= PAIRING_MAX_ATTEMPTS) {
          console.error("[fed] pairing code revoked after too many wrong attempts");
          stopPairing();
        }
        return this.fail("wrong pairing code");
      }
      proof = this.derived!.pairProof(pairing.code, "server").toString("base64url");
      const url = typeof msg.listenUrl === "string" && /^ws:\/\/[^/\s]+\/fed$/.test(msg.listenUrl) ? msg.listenUrl : undefined;
      this.peer = rememberPeer(them.name, them.id, url);
      stopPairing();
      console.log(`[fed] paired with ${this.peer.name} (${fingerprint(them.id)})${url ? `, will dial ${url}` : ""}`);
    } else return this.fail("expected auth or pair");
    clearTimeout(this.timer);
    failures.delete(this.ip);
    this.send({ t: "ok", name: localName(), sig: signTranscript(store.identity, "server", transcript), proof } as unknown as ServerMessage);
    this.send({ type: "state", ...deps.localState() } as ServerMessage);
    console.log(`[fed] ${this.peer.name} connected from ${this.ip}`);
    notifyPeers();
  }

  private serve(msg: FedRequest): void {
    if (msg.type === "http") {
      void this.proxy(msg);
      return;
    }
    void deps.handleMessage(this, msg).catch((e) => console.error(`[fed] ${msg.type} from ${this.peer?.name} failed:`, e));
  }

  private async proxy(msg: Extract<FedRequest, { type: "http" }>): Promise<void> {
    let status = 500;
    let contentType = "text/plain";
    let body = "proxy failed";
    try {
      if (!msg.path.startsWith("/api/")) throw new Error("only /api/* is served to peers");
      const req = new Request(`http://henry.fed${msg.path}`, {
        method: msg.method,
        body: msg.body,
        headers: msg.body !== undefined ? { "content-type": "application/json" } : undefined,
      });
      const res = await deps.handleApi(req, true);
      status = res.status;
      contentType = res.headers.get("content-type") ?? "application/octet-stream";
      body = await res.text();
    } catch (e) {
      body = (e as Error).message;
    }
    this.send({ type: "http:res", id: msg.id, status, contentType, body });
  }

  closed(): void {
    clearTimeout(this.timer);
    inbound.delete(this);
    if (this.peer) {
      console.log(`[fed] ${this.peer.name} disconnected`);
      notifyPeers();
    }
  }
}

// ---- outbound ----

function localName(): string {
  return localHost();
}

/** Dial every enabled peer with a url; drop links for peers that are gone or disabled. */
function syncLinks(): void {
  for (const [key, link] of links) {
    const rec = store.peers.find((p) => p.publicKey === key);
    if (!rec || !rec.enabled || !rec.url || rec.url !== link.url) {
      link.close();
      links.delete(key);
    }
  }
  for (const rec of store.peers) {
    if (!rec.enabled || !rec.url || links.has(rec.publicKey)) continue;
    const link = new PeerLink(rec, { identity: store.identity, name: localName() }, deps, {
      onStatus: () => notifyPeers(),
      onConnected: () => touch(rec),
    });
    links.set(rec.publicKey, link);
    link.connect();
  }
  notifyPeers();
}

// ---- API used by server.ts ----

export function init(d: Deps): void {
  deps = d;
}

/** Rebind when the wanted address or port no longer matches the bound one, or when a
 * previous attempt failed (Tailscale not up yet at daemon start). */
function rebindIfMoved(): void {
  const want = resolveListen();
  if (want.address !== listening?.address || (want.address && config.federation.port !== listening?.port)) startListener();
}

export function start(): void {
  store = loadStore();
  startListener();
  syncLinks();
  onConfigReload(rebindIfMoved);
  // The tailnet address can change under us (switching tailnets, re-login); the old socket
  // stays bound to an address nobody can reach, so poll rather than trust the first bind.
  rebindTimer = setInterval(rebindIfMoved, REBIND_CHECK_MS);
}

export function stop(): void {
  clearInterval(rebindTimer);
  rebindTimer = undefined;
  stopPairing();
  stopListener();
  for (const l of links.values()) l.close();
  links.clear();
}

export function linkOf(sessionId: string | null | undefined): PeerLink | undefined {
  if (!sessionId) return undefined;
  for (const l of links.values()) if (l.sessions.has(sessionId)) return l;
  return undefined;
}

export function linkNamed(name: string | undefined): PeerLink | undefined {
  if (!name) return undefined;
  for (const l of links.values()) if (l.rec.name === name) return l;
  return undefined;
}

/** Local-origin messages go to every dialed-in peer; a `state` is replaced by our local state. */
export function fanout(msg: ServerMessage): void {
  if (!inbound.size) return;
  if (msg.type === "peers:update" || msg.type === "ui:build") return;
  if (msg.type === "playbook:update" && msg.entry.sessionId === null) return;
  const out = msg.type === "state" ? ({ type: "state", ...deps.localState() } as ServerMessage) : msg;
  for (const c of inbound) if (c.open) c.send(out);
}

/** PTY traffic for one local session to the peers attached to it. */
export function publishInbound(sessionId: string, msg: ServerMessage): void {
  for (const c of inbound) if (c.open && c.subscribedTo(sessionId)) c.send(msg);
}

/** Flags that belong to a peer: mark them there and drop them from `ids`. Returns the local rest. */
export function markFlagsRead(ids: string[]): string[] {
  let rest = ids;
  for (const l of links.values()) {
    const mine = rest.filter((id) => l.flags.some((f) => f.id === id));
    if (!mine.length) continue;
    l.markRead(mine);
    rest = rest.filter((id) => !mine.includes(id));
  }
  return rest;
}

/** Local state plus every connected peer's, sessions tagged with `peer`. */
export function merge(local: StateSnapshot): StateSnapshot {
  const out: StateSnapshot = { ...local, host: localName(), peers: statuses() };
  const all = [...links.values()].filter((l) => l.status === "connected");
  if (!all.length) return out;
  out.sessions = [...local.sessions, ...all.flatMap((l) => [...l.sessions.values()])].sort((a, b) => a.createdAt - b.createdAt);
  out.repos = Object.assign({}, local.repos, ...all.map((l) => l.repos));
  out.flags = [...local.flags, ...all.flatMap((l) => l.flags)].sort((a, b) => b.ts - a.ts);
  out.playbook = [...local.playbook, ...all.flatMap((l) => l.playbook)].sort((a, b) => b.ts - a.ts);
  out.usage = { ...local.usage, perSession: Object.assign({}, local.usage.perSession, ...all.map((l) => l.usage)) };
  return out;
}

export function statuses(): PeerStatus[] {
  return store.peers.map((rec) => {
    const link = links.get(rec.publicKey);
    return {
      name: rec.name,
      fingerprint: fingerprint(rec.publicKey),
      url: rec.url,
      link: link ? link.status : "off",
      inbound: [...inbound].some((c) => c.open && c.peer === rec),
      enabled: rec.enabled,
      pairedAt: rec.pairedAt,
      lastSeenAt: rec.lastSeenAt,
      sessions: link?.status === "connected" ? link.sessions.size : 0,
      error: link?.error,
    };
  });
}

export function status(): FederationStatus {
  return {
    name: localName(),
    fingerprint: identityFingerprint(),
    listening,
    listenError,
    pairing: pairing && Date.now() < pairing.expiresAt ? { code: pairing.code, expiresAt: pairing.expiresAt } : undefined,
    peers: statuses(),
  };
}

let notifyTimer: ReturnType<typeof setTimeout> | undefined;
function notifyPeers(): void {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => deps?.toWindows({ type: "peers:update", peers: statuses() }), 20);
}

/** Open a pairing window: one code, ten minutes, five wrong guesses. A new call replaces the code. */
export function startPairing(): { code: string; expiresAt: number } {
  stopPairing();
  const code = newPairingCode();
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  pairing = { code, expiresAt, attempts: 0, timer: setTimeout(stopPairing, PAIRING_TTL_MS) };
  console.log(`[fed] pairing open for 10 min; on the other machine, dial ${advertisedUrl() ?? "(not listening!)"} with code ${code}`);
  return { code, expiresAt };
}

export function stopPairing(): void {
  if (!pairing) return;
  clearTimeout(pairing.timer);
  pairing = undefined;
}

/** Dial `address` (host[:port]) and pair with the code shown there. Stores and links the peer on success. */
export async function pair(address: string, code: string): Promise<PeerStatus> {
  const a = address.trim().replace(/^ws:\/\//, "").replace(/\/fed$/, "");
  if (!/^[A-Za-z0-9.:\[\]-]+$/.test(a)) throw new Error("address must be host or host:port");
  // host, host:port, [v6], [v6]:port; a missing port is ours (both machines default to 4712).
  const hasPort = a.startsWith("[") ? /\]:\d+$/.test(a) : a.split(":").length === 2;
  const url = `ws://${hasPort ? a : `${a}:${config.federation.port}`}/fed`;
  if (!normalizeCode(code)) throw new Error("code required");
  const result = await PeerLink.pair(url, normalizeCode(code), { identity: store.identity, name: localName() }, advertisedUrl());
  if (result.publicKey === store.identity.publicKey) throw new Error("that is this machine");
  const rec = rememberPeer(result.name, result.publicKey, url);
  return statuses().find((p) => p.name === rec.name)!;
}

export function forgetPeer(name: string): boolean {
  const i = store.peers.findIndex((p) => p.name === name);
  if (i < 0) return false;
  const rec = store.peers[i]!;
  store.peers.splice(i, 1);
  saveStore();
  for (const c of inbound) if (c.peer === rec) c.close(4004, "forgotten");
  syncLinks();
  return true;
}

export function enablePeer(name: string, enabled: boolean): boolean {
  const rec = store.peers.find((p) => p.name === name);
  if (!rec) return false;
  rec.enabled = enabled;
  saveStore();
  if (!enabled) for (const c of inbound) if (c.peer === rec) c.close(4005, "disabled");
  syncLinks();
  return true;
}
