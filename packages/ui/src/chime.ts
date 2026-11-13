// The sound of a notice, played by the window. It replaces a global `afplay` hook: Henry
// already decides what is news (daemon/notify.ts), so the chime says the same things the OS
// notification does, with a different sound per kind so you can tell "needs you" from
// "finished" without looking. Separate from the notification toggle because it needs no
// browser permission, only a click on the page first (autoplay), which a Henry window gets.
// On by default; per browser.
import type { Notice } from "@henry/shared";
import { useSyncExternalStore } from "react";
import { getState } from "./ws";

const KEY = "henry.chime";
/** The last notice chimed by any window in this browser, so two windows ring once. */
const LAST = "henry.chime.last";

export function chimeWanted(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();
export function useChimeWanted(): boolean {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), chimeWanted);
}

export function setChimeWanted(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private window: the toggle just does not stick */
  }
  listeners.forEach((l) => l());
  if (on) play("waiting");
}

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}
// A context made before any gesture starts suspended; the first click or key wakes it.
if (typeof window !== "undefined") {
  const wake = () => audio();
  addEventListener("pointerdown", wake, { once: true, capture: true });
  addEventListener("keydown", wake, { once: true, capture: true });
}

/** Notes in Hz, each a soft bell: needs you rises, finished falls, a reminder is one note. */
const TUNES: Record<Notice["kind"], number[]> = {
  needsInput: [660, 880],
  ask: [660, 880, 1100],
  waiting: [880, 660],
  remind: [740],
};

function play(kind: Notice["kind"]): void {
  const a = audio();
  if (!a || a.state !== "running") return;
  const t0 = a.currentTime + 0.02;
  TUNES[kind].forEach((hz, i) => {
    const t = t0 + i * 0.14;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = "sine";
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + 0.65);
  });
}

/** Same rule as the OS notification: quiet for the session you are looking at. */
export function onNoticeChime(n: Notice): void {
  if (!chimeWanted()) return;
  if (document.visibilityState === "visible" && document.hasFocus() && getState().activeSessionId === n.sessionId) return;
  // The same notice comes back with `said` once the line is ready (daemon/announce.ts): the
  // chime rang for the first, the voice is the second.
  const key = n.said ? `${n.id}:said` : n.id;
  try {
    if (localStorage.getItem(LAST) === key) return;
    localStorage.setItem(LAST, key);
  } catch {
    /* no storage: every window rings */
  }
  if (!n.said) play(n.kind);
  else if (n.audio) void speak(n.audio);
}

/** One spoken line at a time: a second waits for the first rather than talking over it. */
let speaking: Promise<void> = Promise.resolve();
function speak(base64: string): Promise<void> {
  speaking = speaking.then(async () => {
    const a = audio();
    if (!a || a.state !== "running") return;
    try {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const buffer = await a.decodeAudioData(bytes.buffer);
      const src = a.createBufferSource();
      src.buffer = buffer;
      src.connect(a.destination);
      await new Promise<void>((done) => {
        src.onended = () => done();
        src.start();
      });
    } catch {
      /* undecodable audio: the line is still in the notification */
    }
  });
  return speaking;
}
