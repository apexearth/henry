// henry pair | peers [forget <name> | url <name> <address>]: talks to the running daemon over loopback, which owns
// the identity and the peer list (the file is not edited behind its back).
import type { FederationStatus, PeerStatus } from "@henry/shared";
import { config } from "./config";

const base = () => `http://127.0.0.1:${config.port}`;

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base() + path, body ? { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } } : undefined);
  } catch {
    throw new Error(`no daemon on ${base()} (is henry running?)`);
  }
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

const ago = (ts?: number) => (ts ? `${Math.max(0, Math.round((Date.now() - ts) / 60000))}m ago` : "never");

/** Open a ten-minute pairing window and print what to type on the other machine. */
export async function pair(): Promise<void> {
  const st = await call<FederationStatus>("/api/federation/status");
  if (!st.listening) {
    console.error(`this daemon is not listening for peers: ${st.listenError ?? "unknown reason"}`);
    process.exit(1);
  }
  const { code, expiresAt } = await call<{ code: string; expiresAt: number }>("/api/federation/pairing/start", {});
  console.log(`this machine: ${st.name}  fingerprint ${st.fingerprint}`);
  console.log(`address:      ${st.listening.address}:${st.listening.port}`);
  console.log(`code:         ${code}   (valid ${Math.round((expiresAt - Date.now()) / 60000)} min, one use)`);
  console.log("\nOn the other machine: remotes → connect, enter the address and code.");
}

export async function peers(): Promise<void> {
  const st = await call<FederationStatus>("/api/federation/status");
  console.log(`${st.name}  ${st.fingerprint}  ${st.listening ? `listening on ${st.listening.address}:${st.listening.port}` : `not listening (${st.listenError})`}`);
  if (!st.peers.length) return console.log("no peers; run `henry pair` here or connect from the remotes menu");
  for (const p of st.peers) console.log(`  ${line(p)}`);
}

function line(p: PeerStatus): string {
  const link = p.url ? `${p.link} → ${p.url}` : "no url";
  return `${p.name.padEnd(16)} ${p.fingerprint}  ${p.enabled ? link : "disabled"}${p.inbound ? "  ⇐ inbound" : ""}  ${p.sessions} sessions  seen ${ago(p.lastSeenAt)}${p.error ? `  (${p.error})` : ""}`;
}

export async function forget(name: string): Promise<void> {
  await call("/api/federation/peer/forget", { name });
  console.log(`forgot ${name}`);
}

/** Point a paired machine at a new address (host[:port]); "-" stops dialing it. */
export async function setUrl(name: string, address: string): Promise<void> {
  await call("/api/federation/peer/url", { name, address: address === "-" ? "" : address });
  const st = await call<FederationStatus>("/api/federation/status");
  const p = st.peers.find((x) => x.name === name);
  console.log(p ? line(p) : `updated ${name}`);
}
