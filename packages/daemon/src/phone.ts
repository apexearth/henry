// Henry on a phone. The daemon opens a second listener — same UI, same /api, same WebSocket —
// on the tailnet address rather than loopback, and lets in only devices that have been granted
// access. Granting is a QR shown in the desktop UI: it carries a one-time invite, the phone
// redeems it for a long-lived token, and the token comes back in a cookie on every request
// after that. Nothing runs on the phone; it is another window onto this daemon, and through
// federation onto the machines this one is paired with.
//
// Why a token when the listener is already tailnet-only: the tailnet is a network of the
// user's own devices, not a single trusted device. A laptop that joined the tailnet for
// something else should not be able to type into a Claude session by knowing a port number.
// The token is what makes access a decision the user made, once, by scanning.
//
// What the phone listener never serves: /hook, /statusline and /mcp (loopback business, and
// unauthenticated by design), and the endpoints that manage pairing and access themselves
// (/api/federation/*, /api/phone/* other than claim and me). A phone drives sessions; it does
// not hand out keys.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { PhoneDevice, PhoneStatus } from "@henry/shared";
import { config, henryDir, onConfigReload } from "./config";
import { newPairingCode, normalizeCode } from "./fed-crypto";
// federation.ts owns "where is this machine on the tailnet"; the phone listener wants the
// same answer, resolved the same way.
import { tailscaleAddress } from "./federation";

/** A granted device. The token itself is never stored: only its SHA-256. */
interface DeviceRecord extends PhoneDevice {
  hash: string;
}

interface Store {
  devices: DeviceRecord[];
}

const storePath = join(henryDir, "phones.json");
const COOKIE = "henry_phone";
const INVITE_TTL_MS = 10 * 60_000;
const INVITE_MAX_ATTEMPTS = 5;
const REBIND_CHECK_MS = 30_000;
/** A year, so a phone that is used now and then does not have to be granted access again. */
const COOKIE_MAX_AGE = 365 * 24 * 3600;
/** lastSeenAt is written to disk, so it moves at most this often. */
const SEEN_THROTTLE_MS = 60_000;

type Server = { stop(closeActiveConnections?: boolean): void; port?: number | null };

let store: Store;
let listener: Server | undefined;
let listening: { address: string; port: number } | undefined;
let listenError: string | undefined;
let rebindTimer: ReturnType<typeof setInterval> | undefined;
let open: ((hostname: string, port: number) => Server) | undefined;
let invite: { code: string; expiresAt: number; attempts: number; timer: ReturnType<typeof setTimeout> } | undefined;

// ---- store ----

function loadStore(): Store {
  let s: Partial<Store> = {};
  if (existsSync(storePath)) {
    try {
      s = JSON.parse(readFileSync(storePath, "utf8"));
    } catch (e) {
      console.error(`[phone] could not parse ${storePath}: ${(e as Error).message}; starting over`);
    }
  }
  return { devices: (s.devices ?? []).filter((d) => d && typeof d.id === "string" && typeof d.hash === "string") };
}

/** Access tokens' hashes live in here: 0600, written atomically. */
function saveStore(): void {
  const tmp = `${storePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, storePath);
}

const publicDevice = ({ id, name, grantedAt, lastSeenAt }: DeviceRecord): PhoneDevice => ({ id, name, grantedAt, lastSeenAt });

// ---- where the phone reaches us ----

const isLoopback = (address: string) => address === "127.0.0.1" || address === "::1" || address.startsWith("127.");

function resolveListen(): { address?: string; error?: string } {
  const want = config.phone.listen;
  if (want === "off") return { error: "phone.listen is off" };
  let address = want;
  if (want === "tailscale") {
    const found = tailscaleAddress();
    if (!found) return { error: "no Tailscale address on this machine (phone.listen: tailscale)" };
    address = found;
  }
  // Every test spawns a daemon, and the tailnet address is the machine's, not the scratch
  // home's: a throwaway daemon must not put a UI on a port the user's other devices can reach,
  // nor take the port the live daemon wants. The test runner sets this for all of them.
  if (process.env.HENRY_NO_PUBLIC_LISTENERS && !isLoopback(address)) {
    return { error: `HENRY_NO_PUBLIC_LISTENERS is set; refusing to listen on ${address}` };
  }
  if (want === "0.0.0.0") console.error("[phone] listening on every interface; only granted devices get in, but anyone can knock");
  return { address };
}

/** The first non-loopback IPv4 of this machine: what to put in a url when we bound 0.0.0.0. */
function anyAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return undefined;
}

/** What a phone opens. Undefined while the listener is down. */
export function phoneUrl(): string | undefined {
  if (!listening) return undefined;
  const host = listening.address === "0.0.0.0" ? anyAddress() : listening.address;
  return host ? `http://${host}:${listening.port}/` : undefined;
}

function startListener(): void {
  stopListener();
  const { address, error } = resolveListen();
  listenError = error;
  if (!address || !open) return;
  const port = config.phone.port;
  try {
    listener = open(address, port);
    listening = { address, port };
    console.log(`[phone] listening on http://${address}:${port} (${store.devices.length} device${store.devices.length === 1 ? "" : "s"} granted access)`);
  } catch (e) {
    listenError = `cannot listen on ${address}:${port}: ${(e as Error).message}`;
    console.error(`[phone] ${listenError}`);
  }
}

function stopListener(): void {
  listener?.stop(true);
  listener = undefined;
  listening = undefined;
}

/** The tailnet address can change under us (a re-login, a different tailnet), and the old
 * socket stays bound to something nobody can reach. Same poll federation does. */
function rebindIfMoved(): void {
  const want = resolveListen();
  if (want.address !== listening?.address || (want.address && config.phone.port !== listening?.port)) startListener();
}

// ---- lifecycle ----

export function start(openListener: (hostname: string, port: number) => Server): void {
  store = loadStore();
  open = openListener;
  startListener();
  onConfigReload(rebindIfMoved);
  rebindTimer = setInterval(rebindIfMoved, REBIND_CHECK_MS);
  rebindTimer.unref?.();
}

export function stop(): void {
  clearInterval(rebindTimer);
  rebindTimer = undefined;
  stopInvite();
  stopListener();
}

// ---- invites ----

/** Open a window in which one device may be granted access: one code, ten minutes, one use. */
export function startInvite(): { code: string; expiresAt: number; url: string } {
  stopInvite();
  const code = newPairingCode();
  const expiresAt = Date.now() + INVITE_TTL_MS;
  invite = { code, expiresAt, attempts: 0, timer: setTimeout(stopInvite, INVITE_TTL_MS) };
  invite.timer.unref?.();
  const url = inviteUrl(code)!;
  console.log(`[phone] invite open for 10 min: ${url}`);
  return { code, expiresAt, url };
}

export function stopInvite(): void {
  if (!invite) return;
  clearTimeout(invite.timer);
  invite = undefined;
}

function inviteUrl(code: string): string | undefined {
  const base = phoneUrl();
  return base ? `${base}?i=${code}` : undefined;
}

function liveInvite(): typeof invite {
  return invite && Date.now() < invite.expiresAt ? invite : undefined;
}

/**
 * Redeem an invite for an access token. The code is spent on the first success, and revoked
 * after five wrong guesses, so a QR photographed over a shoulder is worth nothing once the
 * phone it was shown to has used it.
 */
export function claim(code: unknown, name: unknown): { token: string; device: PhoneDevice } | { error: string } {
  const live = liveInvite();
  if (!live) return { error: "no invite is open; show a new QR on the computer" };
  if (typeof code !== "string" || normalizeCode(code) !== normalizeCode(live.code)) {
    if (++live.attempts >= INVITE_MAX_ATTEMPTS) {
      console.error("[phone] invite revoked after too many wrong codes");
      stopInvite();
    }
    return { error: "wrong invite code" };
  }
  const token = randomBytes(32).toString("base64url");
  const rec: DeviceRecord = {
    id: randomUUID(),
    name: deviceName(name),
    grantedAt: Date.now(),
    hash: createHash("sha256").update(token).digest("hex"),
  };
  store.devices.push(rec);
  saveStore();
  stopInvite();
  console.log(`[phone] granted access to ${rec.name}`);
  return { token, device: publicDevice(rec) };
}

function deviceName(name: unknown): string {
  const s = typeof name === "string" ? name.trim().slice(0, 40) : "";
  return s || "phone";
}

export function forget(id: unknown): boolean {
  const i = store.devices.findIndex((d) => d.id === id);
  if (i < 0) return false;
  console.log(`[phone] revoked ${store.devices[i]!.name}`);
  store.devices.splice(i, 1);
  saveStore();
  return true;
}

// ---- authentication ----

function cookieToken(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** The device this request comes from, if its cookie holds a token we granted. */
export function authorize(req: Request): PhoneDevice | undefined {
  const token = cookieToken(req);
  if (!token) return undefined;
  const hash = Buffer.from(createHash("sha256").update(token).digest("hex"));
  for (const d of store.devices) {
    const known = Buffer.from(d.hash);
    if (known.length !== hash.length || !timingSafeEqual(known, hash)) continue;
    const now = Date.now();
    if (!d.lastSeenAt || now - d.lastSeenAt > SEEN_THROTTLE_MS) {
      d.lastSeenAt = now;
      saveStore();
    }
    return publicDevice(d);
  }
  return undefined;
}

/** The Set-Cookie a freshly claimed token rides home in. Not `Secure`: the phone listener is
 * plain HTTP on a tailnet address, and a Secure cookie would simply never be stored. */
export function cookieHeader(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`;
}

export const clearedCookie = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;

/**
 * What the phone listener may do with a request, before any of the daemon's own routing. The
 * loopback listener never asks: it is the machine Henry runs on.
 */
export type Verdict =
  | { allow: true; device?: PhoneDevice }
  | { allow: false; status: number; error: string };

export function verdict(req: Request, url: URL): Verdict {
  const { pathname } = url;
  // Hooks, the status line and MCP are how local processes talk to the daemon. They are
  // unauthenticated on loopback because loopback is the boundary; off it, they do not exist.
  if (pathname === "/hook" || pathname === "/statusline" || pathname === "/mcp") return { allow: false, status: 404, error: "not found" };
  // Claiming is the one thing a device does before it has any credential.
  if (pathname === "/api/phone/claim") {
    return req.method === "POST" ? { allow: true } : { allow: false, status: 405, error: "method not allowed" };
  }
  // Pairing machines and handing out phone access stay on the machine itself.
  if (pathname.startsWith("/api/federation/") || (pathname.startsWith("/api/phone/") && pathname !== "/api/phone/me")) {
    return { allow: false, status: 403, error: "not available from a phone" };
  }
  if (pathname === "/ws" || pathname.startsWith("/api/")) {
    const device = authorize(req);
    return device ? { allow: true, device } : { allow: false, status: 401, error: "this device has not been granted access" };
  }
  // The rest is the UI bundle, which has to load before there is anyone to authenticate.
  return req.method === "GET" ? { allow: true } : { allow: false, status: 405, error: "method not allowed" };
}

export function status(): PhoneStatus {
  const live = liveInvite();
  return {
    listening,
    listenError,
    url: phoneUrl(),
    invite: live ? { code: live.code, expiresAt: live.expiresAt, url: inviteUrl(live.code) ?? "" } : undefined,
    devices: store.devices.map(publicDevice),
  };
}
