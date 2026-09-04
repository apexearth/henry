// Topbar "remotes" popover: which machines this daemon is paired with and how each link is
// doing, a pairing window for another machine to join, and a form to join one. Everything
// here talks to the local daemon only; the daemon does the dialing and holds the keys.
import { useEffect, useState } from "react";
import type { FederationStatus, PeerStatus } from "@henry/shared";
import { hueText, nameHue } from "./theme";
import { useStore } from "./ws";

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

const LINK_TEXT: Record<PeerStatus["link"], string> = {
  connected: "connected",
  connecting: "connecting…",
  offline: "offline",
  off: "not dialing",
};

export function RemotesMenu() {
  const [open, setOpen] = useState(false);
  const peers = useStore((s) => s.peers);
  const connected = peers.filter((p) => p.link === "connected").length;
  const down = peers.filter((p) => p.enabled && p.url && p.link !== "connected").length;
  return (
    <>
      <button className="topbar-btn remotes-btn" onClick={() => setOpen((o) => !o)} title="machines paired with this one">
        remotes
        {peers.length > 0 && <span className={"n " + (down ? "off" : "on")}>{connected}/{peers.length}</span>}
      </button>
      {open && (
        <>
          <div className="pop-bg" onClick={() => setOpen(false)} />
          <div className="pop remotes-pop">
            <Remotes peers={peers} />
          </div>
        </>
      )}
    </>
  );
}

function Remotes({ peers }: { peers: PeerStatus[] }) {
  const [status, setStatus] = useState<FederationStatus | null>(null);
  const [now, setNow] = useState(Date.now);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok?: string; err?: string } | null>(null);

  // Listener and pairing state are not in the WS stream; poll while the menu is open.
  useEffect(() => {
    let on = true;
    const load = () =>
      fetch("/api/federation/status")
        .then((r) => r.json())
        .then((s: FederationStatus) => on && setStatus(s))
        .catch(() => {});
    void load();
    const t = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 2000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [peers]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      if (ok) setNote({ ok });
      setStatus(await (await fetch("/api/federation/status")).json());
    } catch (e) {
      setNote({ err: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const pairing = status?.pairing && status.pairing.expiresAt > now ? status.pairing : undefined;
  const list = status?.peers ?? peers;

  return (
    <>
      <h4>this machine</h4>
      <div className="me">
        <span className="name">{status?.name ?? "…"}</span>
        <span className="fp" title="fingerprint of this daemon's identity key">{status?.fingerprint}</span>
        <span className="grow" />
        {status?.listening ? (
          <span className="dim" title="where paired machines reach this daemon">{status.listening.address}:{status.listening.port}</span>
        ) : (
          <span className="err" title={status?.listenError}>not listening</span>
        )}
      </div>
      {status && !status.listening && (
        <div className="dim">{status.listenError}. Set <code>federation.listen</code> in ~/.henry/config.json to "tailscale" or an address.</div>
      )}

      <h4>paired machines</h4>
      {!list.length && <div className="dim">none yet</div>}
      {list.map((p) => (
        <div key={p.name} className="peer-row" title={`identity ${p.fingerprint}\npaired ${new Date(p.pairedAt).toLocaleString()}\nlast seen ${ago(p.lastSeenAt, now)}${p.error ? `\n${p.error}` : ""}`}>
          <span className={"dot " + (p.enabled ? p.link : "off")} />
          <span className="name" style={{ color: hueText(nameHue(p.name)) }}>{p.name}</span>
          <span className="grow dim">
            {!p.enabled ? "disabled" : p.url ? `${LINK_TEXT[p.link]} · ${p.url.replace(/^ws:\/\//, "").replace(/\/fed$/, "")}` : "reaches us only"}
            {p.inbound ? " · sees us" : ""}
            {p.link === "connected" ? ` · ${p.sessions} session${p.sessions === 1 ? "" : "s"}` : ""}
          </span>
          <button className="small" disabled={busy} title={p.enabled ? "stop dialing and refuse this machine" : "dial and accept this machine again"}
            onClick={() => act(() => post("/api/federation/peer/enable", { name: p.name, enabled: !p.enabled }))}>
            {p.enabled ? "pause" : "resume"}
          </button>
          <button className="small" disabled={busy} title="forget this machine: it must pair again to connect"
            onClick={() => act(() => post("/api/federation/peer/forget", { name: p.name }), `forgot ${p.name}`)}>
            ×
          </button>
        </div>
      ))}

      <h4>let another machine join</h4>
      {pairing ? (
        <div>
          <div className="code">{pairing.code}</div>
          <div className="dim">
            On the other machine: remotes → join, enter <b>{status?.listening ? `${status.listening.address}:${status.listening.port}` : "this address"}</b> and this code.
            Expires in {Math.max(0, Math.ceil((pairing.expiresAt - now) / 60000))} min; one use.
            <button className="small" onClick={() => act(() => post("/api/federation/pairing/stop"))}>cancel</button>
          </div>
        </div>
      ) : (
        <div className="me">
          <button disabled={busy || !status?.listening} onClick={() => act(() => post("/api/federation/pairing/start"))}
            title={status?.listening ? "show a one-time code for 10 minutes" : "this daemon is not listening"}>
            show a pairing code
          </button>
          <span className="dim">then compare fingerprints on both sides</span>
        </div>
      )}

      <h4>join a machine</h4>
      <form onSubmit={(e) => { e.preventDefault(); void act(() => post<{ peer: PeerStatus }>("/api/federation/pair", { address, code }).then((r) => { setAddress(""); setCode(""); return r; }), "paired"); }}>
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="100.x.y.z:14712" spellCheck={false} autoCapitalize="off" />
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX" spellCheck={false} autoCapitalize="characters" style={{ maxWidth: 140 }} />
        <button type="submit" disabled={busy || !address.trim() || !code.trim()}>join</button>
      </form>
      {note?.err && <div className="err">{note.err}</div>}
      {note?.ok && <div className="ok">{note.ok}</div>}
      <div className="dim" style={{ marginTop: 6 }}>
        A paired machine sees this daemon's sessions and can type into them. Pair only over your tailnet.
      </div>
    </>
  );
}
