// Cryptography for daemon-to-daemon links (federation.ts). Pure functions and two small
// classes; nothing here touches the network or the file system.
//
// Identity: one Ed25519 key pair per machine, pinned by the other side at pairing time.
// Handshake: both ends send an ephemeral X25519 key + nonce in the clear, derive a shared
// secret, and from then on every frame is AES-256-GCM under a per-direction key with a
// strictly increasing counter (an ordered WebSocket makes replay = counter mismatch).
// Authentication happens inside that channel: each side signs the whole transcript (both
// nonces, both ephemeral keys, both identity keys) with its identity key, so a man in the
// middle who swapped ephemeral keys produces transcripts neither signature verifies.
// Pairing proves knowledge of a one-time code with an HMAC keyed by the shared secret, so
// a passive observer cannot brute-force the code from the wire; an active attacker gets
// one online guess per attempt, and the listener allows five per code. Both sides prove
// it, each under its role: a daemon at a mistyped address (or a man in the middle on an
// open interface) cannot accept a pairing it does not know the code for.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";

// v2: the listener proves the pairing code too. A v1 daemon is told plainly to update.
export const FED_VERSION = 2;
const LABEL = "henry-fed-v2";
const NONCE_LEN = 16;
const KEY_LEN = 32;

export type Role = "client" | "server";

/** Stored identity: raw public key and the private scalar, both base64url (JWK "x" / "d"). */
export interface IdentityKeys {
  publicKey: string;
  privateKey: string;
}

export function newIdentity(): IdentityKeys {
  const kp = generateKeyPairSync("ed25519");
  const jwk = kp.privateKey.export({ format: "jwk" }) as { x: string; d: string };
  return { publicKey: jwk.x, privateKey: jwk.d };
}

function ed25519Public(publicKey: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
}

function ed25519Private(id: IdentityKeys): KeyObject {
  return createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: id.publicKey, d: id.privateKey }, format: "jwk" });
}

/** SHA-256 of the raw public key, first 16 hex chars in groups of four: enough to compare by eye. */
export function fingerprint(publicKey: string): string {
  const hex = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 16);
  return hex.match(/.{4}/g)!.join(" ");
}

export function validPublicKey(publicKey: unknown): publicKey is string {
  if (typeof publicKey !== "string") return false;
  try {
    return Buffer.from(publicKey, "base64url").length === 32 && !!ed25519Public(publicKey);
  } catch {
    return false;
  }
}

/** The clear-text opening frame of a link, sent by both sides. */
export interface Hello {
  t: "hello";
  v: number;
  name: string;
  /** Ed25519 public key, base64url. */
  id: string;
  /** X25519 ephemeral public key, base64url. */
  eph: string;
  /** 16 random bytes, base64url. */
  nonce: string;
}

export function isHello(m: unknown): m is Hello {
  const h = m as Hello;
  return (
    !!h &&
    h.t === "hello" &&
    typeof h.v === "number" &&
    typeof h.name === "string" &&
    validPublicKey(h.id) &&
    typeof h.eph === "string" &&
    Buffer.from(h.eph, "base64url").length === 32 &&
    typeof h.nonce === "string" &&
    Buffer.from(h.nonce, "base64url").length === NONCE_LEN
  );
}

/** What a finished key exchange yields; `transcript` is what the identity signatures cover. */
export interface Derived {
  transcript: Buffer;
  channel: Channel;
  /** Keyed by the shared secret: proves a pairing code without exposing it. Each side
   * proves under its own role, so the joiner's proof cannot be echoed back as the listener's. */
  pairProof: (code: string, role: Role) => Buffer;
}

/** One side's ephemeral state for one connection. Make a fresh one per connection, never reuse. */
export class Handshake {
  private readonly eph = generateKeyPairSync("x25519");
  private readonly nonce = randomBytes(NONCE_LEN);
  private used = false;

  constructor(
    private readonly role: Role,
    private readonly identity: IdentityKeys,
    private readonly name: string,
  ) {}

  hello(): Hello {
    const jwk = this.eph.publicKey.export({ format: "jwk" }) as { x: string };
    return { t: "hello", v: FED_VERSION, name: this.name, id: this.identity.publicKey, eph: jwk.x, nonce: this.nonce.toString("base64url") };
  }

  /** Combine with the other side's hello. Throws on a malformed key; usable once. */
  derive(peer: Hello): Derived {
    if (this.used) throw new Error("handshake already used");
    this.used = true;
    const peerEph = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: peer.eph }, format: "jwk" });
    const secret = diffieHellman({ privateKey: this.eph.privateKey, publicKey: peerEph });
    const mine = this.hello();
    // Fixed-width fields in a fixed order (client first), so the two sides build the same bytes.
    const [c, s] = this.role === "client" ? [mine, peer] : [peer, mine];
    const transcript = Buffer.concat([
      Buffer.from(LABEL),
      Buffer.from(c.nonce, "base64url"),
      Buffer.from(s.nonce, "base64url"),
      Buffer.from(c.eph, "base64url"),
      Buffer.from(s.eph, "base64url"),
      Buffer.from(c.id, "base64url"),
      Buffer.from(s.id, "base64url"),
    ]);
    const salt = createHash("sha256").update(transcript).digest();
    const key = (info: string) => Buffer.from(hkdfSync("sha256", secret, salt, `${LABEL} ${info}`, KEY_LEN));
    const c2s = key("c2s");
    const s2c = key("s2c");
    const pairKey = key("pair");
    return {
      transcript,
      channel: this.role === "client" ? new Channel(c2s, s2c) : new Channel(s2c, c2s),
      pairProof: (code, role) => createHmac("sha256", pairKey).update(`${role}\0${normalizeCode(code)}`).digest(),
    };
  }
}

/** Sign the transcript as `role`; the other side verifies with the same role name. */
export function signTranscript(identity: IdentityKeys, role: Role, transcript: Buffer): string {
  return sign(null, Buffer.concat([Buffer.from(`${LABEL} ${role}\0`), transcript]), ed25519Private(identity)).toString("base64url");
}

export function verifyTranscript(publicKey: string, role: Role, transcript: Buffer, signature: unknown): boolean {
  if (typeof signature !== "string") return false;
  try {
    const sig = Buffer.from(signature, "base64url");
    if (sig.length !== 64) return false;
    return verify(null, Buffer.concat([Buffer.from(`${LABEL} ${role}\0`), transcript]), ed25519Public(publicKey), sig);
  } catch {
    return false;
  }
}

export function proofsEqual(a: Buffer, b: unknown): boolean {
  if (typeof b !== "string") return false;
  const bb = Buffer.from(b, "base64url");
  return bb.length === a.length && timingSafeEqual(a, bb);
}

/**
 * AES-256-GCM in both directions. Frame = 12-byte nonce (4 zero bytes + 8-byte counter) ||
 * ciphertext || 16-byte tag. The counter must arrive in order: a skipped or repeated frame
 * is an error and the caller drops the link.
 */
export class Channel {
  private sendCounter = 0n;
  private recvCounter = 0n;

  constructor(
    private readonly sendKey: Buffer,
    private readonly recvKey: Buffer,
  ) {}

  private static nonce(counter: bigint): Buffer {
    const n = Buffer.alloc(12);
    n.writeBigUInt64BE(counter, 4);
    return n;
  }

  seal(msg: unknown): Uint8Array {
    const nonce = Channel.nonce(this.sendCounter++);
    const c = createCipheriv("aes-256-gcm", this.sendKey, nonce);
    const body = Buffer.concat([c.update(JSON.stringify(msg), "utf8"), c.final()]);
    return Buffer.concat([nonce, body, c.getAuthTag()]);
  }

  open(frame: Uint8Array): unknown {
    const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    if (buf.length < 12 + 16) throw new Error("short frame");
    const nonce = buf.subarray(0, 12);
    if (nonce.readUInt32BE(0) !== 0 || nonce.readBigUInt64BE(4) !== this.recvCounter) throw new Error("frame out of order");
    const d = createDecipheriv("aes-256-gcm", this.recvKey, nonce);
    d.setAuthTag(buf.subarray(buf.length - 16));
    const plain = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
    this.recvCounter++;
    return JSON.parse(plain.toString("utf8"));
  }
}

// Pairing codes: 12 chars from a 32-letter alphabet without 0/O/1/I (60 bits), shown as
// three groups of four. Compared after normalizeCode, so case and separators do not matter.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 12;

export function newPairingCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let code = "";
  for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return code.match(/.{4}/g)!.join("-");
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-9]/g, "");
}
