// henry phone [invite | forget <name-or-id>]: the QR, from a terminal. The desktop UI's
// "phone" popover does the same thing with a bigger square; this exists so a headless daemon
// is not a daemon you cannot reach from your pocket.
import { qrText, type PhoneStatus } from "@henry/shared";
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

export async function status(): Promise<void> {
  const st = await call<PhoneStatus>("/api/phone/status");
  console.log(st.listening ? `listening on http://${st.listening.address}:${st.listening.port}` : `not listening (${st.listenError})`);
  if (!st.devices.length) console.log("no devices; run `henry phone invite` and scan the code");
  for (const d of st.devices) console.log(`  ${d.name.padEnd(20)} granted ${new Date(d.grantedAt).toLocaleString()}  seen ${ago(d.lastSeenAt)}`);
}

/** Open a ten-minute invite and draw it as a QR the phone's camera can read off the terminal. */
export async function invite(): Promise<void> {
  const st = await call<PhoneStatus>("/api/phone/status");
  if (!st.listening) {
    console.error(`the phone listener is not up: ${st.listenError ?? "unknown reason"}`);
    console.error('Set "phone": { "listen": "tailscale" } in ~/.henry/config.json, or an address.');
    process.exit(1);
  }
  const open = await call<{ code: string; expiresAt: number; url: string }>("/api/phone/invite", {});
  console.log(qrText(open.url));
  console.log(`\n${open.url}`);
  console.log(`valid ${Math.round((open.expiresAt - Date.now()) / 60000)} min, one use. Scan it with the phone's camera.`);
}

export async function forget(which: string): Promise<void> {
  const st = await call<PhoneStatus>("/api/phone/status");
  const d = st.devices.find((x) => x.id === which || x.name === which);
  if (!d) {
    console.error(`no device called ${which}`);
    process.exit(1);
  }
  await call("/api/phone/forget", { id: d.id });
  console.log(`revoked ${d.name}`);
}
