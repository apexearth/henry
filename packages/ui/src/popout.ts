// A session in a window of its own: the page at `/?session=<id>`, showing that one terminal
// (SoloApp). It is a whole Henry client with its own WebSocket, not a dockview popout like a
// peek's, so it survives the main window reloading on a UI build. Two windows drawing one PTY
// at two sizes fight over it, so while a session is out the main window drops its tab, and a
// rail click on it brings the session's window forward instead. Windows of this browser tell
// one another which sessions are out over a BroadcastChannel, so a reloaded main window still
// knows; closing the session's window puts the tab back.
import { useSyncExternalStore } from "react";

/** The session this window is dedicated to, when it is a popped-out session window. */
export const soloSessionId: string | null = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("session");

type Msg = { type: "here"; id: string } | { type: "gone"; id: string } | { type: "who" };

const channel: BroadcastChannel | null = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("henry.popouts");
/** A session window says it is here this often; one silent for three beats crashed or was killed. */
const BEAT_MS = 2000;

const windowName = (id: string) => `henry-session-${id}`;

/** Sessions out in their own window, with when each last said so. */
const out = new Map<string, number>();
/** Windows this window opened, for focusing them without the channel. */
const handles = new Map<string, Window>();
const listeners = new Set<() => void>();
let onBack: ((id: string) => void) | null = null;

function changed(): void {
  snapshot = [...out.keys()];
  listeners.forEach((l) => l());
}
let snapshot: string[] = [];

function drop(id: string): void {
  if (!out.delete(id)) return;
  handles.delete(id);
  changed();
  onBack?.(id);
}

export const isPoppedOut = (id: string): boolean => out.has(id);

export function usePoppedOut(): string[] {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => snapshot);
}

/** The main window: hear the session windows, and give a tab back when one closes. */
export function watchPopouts(back: (id: string) => void): void {
  const started = onBack !== null;
  onBack = back;
  if (!channel || started) return;
  channel.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data;
    if (m.type === "here") {
      const fresh = !out.has(m.id);
      out.set(m.id, Date.now());
      if (fresh) changed();
    } else if (m.type === "gone") drop(m.id);
  };
  channel.postMessage({ type: "who" } satisfies Msg);
  setInterval(() => {
    for (const [id, at] of out) if (Date.now() - at > 3 * BEAT_MS || handles.get(id)?.closed) drop(id);
  }, BEAT_MS);
}

/** A session window: say so now, on every beat and when asked, and say goodbye on the way out. */
let announced = false;
export function announcePopout(id: string): void {
  if (!channel || announced) return;
  announced = true;
  const here = () => channel.postMessage({ type: "here", id } satisfies Msg);
  channel.onmessage = (e: MessageEvent<Msg>) => e.data.type === "who" && here();
  here();
  setInterval(here, BEAT_MS);
  addEventListener("pagehide", () => channel.postMessage({ type: "gone", id } satisfies Msg));
}

/** Open the session in its own window, or bring that window forward if it is already out. */
export function popOut(id: string): void {
  const w = handles.get(id);
  if (w && !w.closed) return void w.focus();
  // Same name, same window: a second call focuses it rather than opening another.
  const opened = window.open(`/?session=${encodeURIComponent(id)}`, windowName(id), "popup,width=960,height=640");
  if (!opened) return;
  handles.set(id, opened);
  out.set(id, Date.now());
  changed();
  opened.focus();
}

/** Bring an out session's window forward. Without a handle (this window reloaded since it
 * opened it) the name still finds it: an empty URL focuses a named window without reloading it. */
export function focusPopout(id: string): void {
  const w = handles.get(id);
  if (w && !w.closed) return void w.focus();
  window.open("", windowName(id))?.focus();
}
