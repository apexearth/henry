// OS notifications, raised from the window. The daemon decides what is news and sends a
// `notify` frame (daemon/notify.ts); this file only decides whether *this* window should say
// it out loud, and shows it. Off until the user turns it on — asking for permission unbidden
// is how a site gets blocked for good — and per browser, since the permission is.
import type { Notice } from "@henry/shared";
import { showSession } from "./dock";
import { useSyncExternalStore } from "react";
import { getState, setActive } from "./ws";

const KEY = "henry.notify";

export const supported = (): boolean => typeof Notification !== "undefined";

/** The user asked for them here; the browser may still have said no. */
export function wanted(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export const permission = (): NotificationPermission | "unsupported" => (supported() ? Notification.permission : "unsupported");

export const enabled = (): boolean => wanted() && permission() === "granted";

const listeners = new Set<() => void>();
/** For the toggle: what the user asked for here, and what the browser said. */
export function useNotifyState(): { wanted: boolean; permission: ReturnType<typeof permission> } {
  const key = useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => `${wanted() ? 1 : 0}:${permission()}`);
  return { wanted: key.startsWith("1"), permission: key.slice(2) as ReturnType<typeof permission> };
}

/** Turning it on is the click that asks the browser; the answer is what the toggle then shows. */
export async function setWanted(on: boolean): Promise<void> {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private window: the toggle just does not stick */
  }
  if (on && supported() && Notification.permission === "default") await Notification.requestPermission();
  listeners.forEach((l) => l());
}

/** A notice is for someone who is not looking. A focused window showing that session is. */
export function onNotice(n: Notice): void {
  if (!enabled()) return;
  if (document.visibilityState === "visible" && document.hasFocus() && getState().activeSessionId === n.sessionId) return;
  const title = n.peer ? `${n.title} · ${n.peer}` : n.title;
  // One per session: a second notice for the same session replaces the first rather than
  // stacking, and two windows on this machine raise one, not two.
  const note = new Notification(title, { body: n.body, tag: `henry:${n.sessionId}`, silent: n.kind === "waiting" });
  note.onclick = () => {
    window.focus();
    setActive(n.sessionId);
    showSession(n.sessionId);
    note.close();
  };
}
