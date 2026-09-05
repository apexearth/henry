// Whether this window is allowed to talk to the daemon at all.
//
// On the machine Henry runs on, it always is: the loopback listener is the boundary and
// /api/phone/me says nobody had to be let in. On the phone listener the answer is a token,
// held in an HttpOnly cookie the browser sends with every request and with the WebSocket
// upgrade, so nothing here ever holds a credential.
//
// A phone arrives with `?i=<code>` in the url — that is what the QR carries. It spends the
// code for a token once, drops it out of the address bar, and from then on just opens the
// page. See daemon/phone.ts.
import type { PhoneIdentity } from "@henry/shared";

export interface Access {
  ok: boolean;
  /** True when this window had to be granted access (it is on the phone listener). */
  granted: boolean;
  device?: string;
  error?: string;
}

/** What this device calls itself when it claims an invite: enough to tell two phones apart. */
function deviceName(): string {
  const ua = navigator.userAgent;
  const platform = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "phone";
  const browser = /CriOS|Chrome/.test(ua) ? "Chrome" : /FxiOS|Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "browser";
  return `${platform} · ${browser}`;
}

async function claim(code: string): Promise<Access> {
  try {
    const res = await fetch("/api/phone/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: deviceName() }),
    });
    const body = (await res.json()) as { device?: { name: string }; error?: string };
    if (!res.ok) return { ok: false, granted: true, error: body.error ?? `could not use that code (${res.status})` };
    return { ok: true, granted: true, device: body.device?.name };
  } catch {
    return { ok: false, granted: true, error: "the daemon did not answer" };
  }
}

/** The invite code in the address bar, if the page was opened from a QR. */
function inviteCode(): string | null {
  const code = new URLSearchParams(location.search).get("i");
  return code && /^[A-Za-z0-9-]{8,32}$/.test(code) ? code : null;
}

/** Take the spent code out of the url, and out of the browser's history, leaving the rest of
 * the address as the user typed or bookmarked it. */
function forgetCode(): void {
  const params = new URLSearchParams(location.search);
  params.delete("i");
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
}

export async function checkAccess(): Promise<Access> {
  const code = inviteCode();
  if (code) {
    const result = await claim(code);
    if (result.ok) forgetCode();
    return result;
  }
  try {
    const res = await fetch("/api/phone/me");
    if (res.status === 401) return { ok: false, granted: true, error: "this device has not been granted access" };
    if (!res.ok) return { ok: true, granted: false }; // an older daemon: loopback, carry on
    const me = (await res.json()) as PhoneIdentity;
    return { ok: true, granted: me.required, device: me.device?.name };
  } catch {
    // The daemon is down rather than refusing us; the reconnecting WS is the right thing to show.
    return { ok: true, granted: false };
  }
}
