// Topbar "phone" popover: the QR that lets a phone in, and the phones that are already in.
// Everything here talks to the local daemon over loopback — the phone listener refuses these
// endpoints, so a phone cannot hand out access to more phones.
import { useEffect, useState } from "react";
import type { PhoneStatus } from "@henry/shared";
import { Qr } from "./Qr";

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `request failed (${r.status})`);
  return data;
}

function ago(ts: number | undefined, now: number): string {
  if (!ts) return "never";
  const m = Math.floor((now - ts) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
}

export function PhoneMenu() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<PhoneStatus | null>(null);

  // Not in the WS stream (it is machine setup, not session state): poll the daemon while open.
  useEffect(() => {
    if (!open) return;
    let on = true;
    const load = () =>
      fetch("/api/phone/status")
        .then((r) => r.json())
        .then((s: PhoneStatus) => on && setStatus(s))
        .catch(() => {});
    void load();
    const t = setInterval(load, 2000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [open]);

  return (
    <>
      <button className="topbar-btn" onClick={() => setOpen((o) => !o)} title="open Henry on your phone">
        phone
      </button>
      {open && (
        <>
          <div className="pop-bg" onClick={() => setOpen(false)} />
          <div className="pop phone-pop">
            <Phone status={status} setStatus={setStatus} />
          </div>
        </>
      )}
    </>
  );
}

function Phone({ status, setStatus }: { status: PhoneStatus | null; setStatus: (s: PhoneStatus) => void }) {
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setStatus(await (await fetch("/api/phone/status")).json());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const invite = status?.invite && status.invite.expiresAt > now ? status.invite : undefined;
  const left = invite ? Math.max(0, Math.ceil((invite.expiresAt - now) / 60000)) : 0;

  return (
    <>
      <h4>henry on your phone</h4>
      {!status ? (
        <div className="dim">…</div>
      ) : !status.listening ? (
        <div className="dim">
          <span className="err">not listening</span>. {status.listenError}. Set <code>phone.listen</code> in ~/.henry/config.json to
          "tailscale" or an address, and put the phone on the same tailnet.
        </div>
      ) : invite ? (
        <div className="phone-invite">
          <Qr text={invite.url} />
          <div className="dim">
            Scan it with the phone's camera. Valid {left} more minute{left === 1 ? "" : "s"}, one use.
          </div>
          <code className="phone-url">{invite.url}</code>
          <button className="small" disabled={busy} onClick={() => act(() => post("/api/phone/invite/stop"))}>cancel</button>
        </div>
      ) : (
        <div className="phone-invite">
          <button disabled={busy} onClick={() => act(() => post("/api/phone/invite"))}>show a QR code</button>
          <div className="dim">
            Serving on <code>{status.url}</code>. The phone needs to be on the same tailnet; scanning grants it a token that lasts
            until you revoke it.
          </div>
        </div>
      )}

      <h4>phones with access</h4>
      {!status?.devices.length && <div className="dim">none yet</div>}
      {status?.devices.map((d) => (
        <div key={d.id} className="peer-row" title={`granted ${new Date(d.grantedAt).toLocaleString()}`}>
          <span className="name">{d.name}</span>
          <span className="grow dim">seen {ago(d.lastSeenAt, now)}</span>
          <button className="small" disabled={busy} title="revoke this device: it has to scan a new code"
            onClick={() => act(() => post("/api/phone/forget", { id: d.id }))}>
            ×
          </button>
        </div>
      ))}
      {err && <div className="err">{err}</div>}
      <div className="dim" style={{ marginTop: 6 }}>
        A phone with access sees these sessions and can type into them, the same as a window here.
      </div>
    </>
  );
}
