// The phone's way into a session. A phone keyboard cannot send Esc, Tab or ⌃C, and xterm's
// hidden textarea fights autocorrect, so the terminal on a phone is a screen you read and this
// is the thing you type at: compose a line, send it, and reach the handful of keys Claude Code
// actually wants from a row of buttons.
//
// Talking is a different posture, not a button on the typing one: a thumb-sized mic wedged next
// to the keys is a thing you miss and long-press into a text selection. So the composer has two
// modes and 🎙/⌨ swaps the whole bottom of the screen between them — keys and a text box for
// typing, one slab and the words it heard for talking. The slab is tapped or held: a tap keeps
// the mic open until the next tap, so a thumb that drifts, or a browser that takes the touch for
// a swipe, never cuts a sentence off.
//
// 📎 is the phone's paste for images: a photo goes to the daemon, which keeps it on the session's
// machine, and the line sent carries its path, which Claude Code reads like any other image.
import { useEffect, useRef, useState } from "react";
import { isClaudeSession, type Session } from "@henry/shared";
import { send, useStore } from "../ws";
import { attachImage } from "./attach";
import { dictationSupported, listen, type Dictation } from "./dictation";
import { canRecord, holdToTalk } from "../voice-audio";

/** The keys a phone keyboard has no way to send, and the answers a permission prompt wants. */
interface Key {
  label: string;
  /** Sent to the PTY as it is: no Enter after it, since Claude Code's prompt reads a bare
   * digit as the answer and a stray Enter would then be the next prompt's. */
  data: string;
  title: string;
}

// What a permission prompt or a menu wants comes first, so it is on screen without scrolling the
// row; ⌃C is last, where a thumb does not land on it by accident.
const KEYS: Key[] = [
  { label: "esc", data: "\x1b", title: "Escape — interrupt Claude, or leave a prompt" },
  { label: "1", data: "1", title: "answer a prompt with 1" },
  { label: "2", data: "2", title: "answer a prompt with 2" },
  { label: "3", data: "3", title: "answer a prompt with 3" },
  { label: "⏎", data: "\r", title: "Enter on its own" },
  { label: "↑", data: "\x1b[A", title: "up — previous command, or move in a menu" },
  { label: "↓", data: "\x1b[B", title: "down" },
  { label: "tab", data: "\t", title: "Tab" },
  { label: "←", data: "\x1b[D", title: "left — move the cursor, or step back in a menu" },
  { label: "→", data: "\x1b[C", title: "right" },
];

/** A press shorter than this is a tap: the mic stays open until the next one. So is any press
 * let go before the mic has opened, which on a phone can take longer than this. */
const TAP_MS = 350;

/** Which half of the composer is on screen. Remembered: a phone used by voice stays that way. */
type Mode = "type" | "talk";
const MODE_KEY = "henry.mobile.composer";

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "talk" ? "talk" : "type";
  } catch {
    return "type";
  }
}

/** An image picked for the next line: its thumbnail now, its path once the upload lands. */
interface Attached {
  key: number;
  thumb: string;
  path?: string;
}
let attachKey = 0;

export function Composer({ session }: { session: Session }) {
  const [mode, setMode] = useState<Mode>(readMode);
  const [text, setText] = useState("");
  const [dictating, setDictating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** Henry's own ear, when this page can record and the daemon has whisper. Preferred over the
   * browser's recogniser because it knows what your sessions, repos and files are called. */
  const [holdState, setHoldState] = useState<"idle" | "arming" | "recording" | "working">("idle");
  const [whisper, setWhisper] = useState(false);
  /** "held" while a finger is on the button; "latched" once it was a tap, or once the browser
   * took the touch away. A latched mic stays open until the next tap. */
  const phase = useRef<"idle" | "held" | "latched">("idle");
  const [latched, setLatched] = useState(false);
  const pressedAt = useRef(0);
  const recording = useRef(false);
  const hold = useRef(
    holdToTalk((state) => {
      recording.current = state === "recording";
      // The recorder gave up (no permission, no device) under a finger or a latch.
      if (state === "idle" && phase.current !== "idle") {
        phase.current = "idle";
        setLatched(false);
      }
      setHoldState(state);
    }),
  );
  /** Set when the swap to type mode was a request to edit, so the keyboard comes up with it. */
  const wantsBox = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const speech = useRef<Dictation | undefined>(undefined);
  // What was in the box when the microphone opened; recognised words are appended to it.
  const before = useRef("");
  const claude = isClaudeSession(session);
  const [attached, setAttached] = useState<Attached[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const uploading = attached.some((a) => !a.path);

  // Leaving the session (or the page) with the microphone open would keep listening.
  useEffect(() => () => speech.current?.stop(), []);

  // Asked again on every reconnect: on iPhone Chrome whisper is the only ear, so one status call
  // lost to a daemon restart or a waking tailnet would otherwise hide the mic until a reload.
  const connectionId = useStore((s) => s.connectionId);
  useEffect(() => {
    if (!canRecord() || !connectionId) return;
    fetch("/api/voice/status")
      .then((r) => r.json())
      .then((s: { ready?: boolean }) => setWhisper(!!s.ready))
      .catch(() => setWhisper(false));
  }, [connectionId]);
  useEffect(() => {
    speech.current?.stop();
    setText("");
    setAttached((list) => {
      for (const a of list) URL.revokeObjectURL(a.thumb);
      return [];
    });
  }, [session.id]);

  // Grow with what is typed (or dictated), up to a few lines, so a long prompt is readable
  // without taking the terminal's half of the screen. Also on the way back from talk mode, where
  // the box was unmounted while the words piled up in it.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    if (wantsBox.current) {
      wantsBox.current = false;
      el.focus();
    }
  }, [text, mode]);

  const write = (data: string) => send({ type: "pty:input", sessionId: session.id, data });

  const submit = (newline: boolean) => {
    if (uploading) return;
    // Quoted, because a home folder can have a space in it.
    const body = [text.replace(/\s+$/, ""), ...attached.map((a) => `"${a.path}"`)].filter(Boolean).join(" ");
    if (!body && !newline) return;
    setText("");
    for (const a of attached) URL.revokeObjectURL(a.thumb);
    setAttached([]);
    // Shift+Enter is a newline inside Claude Code's prompt (ESC CR, what /terminal-setup binds);
    // a plain shell gets a normal Enter.
    // The Enter goes on its own a beat later: Claude Code reads a long burst of input as a paste
    // and keeps a CR inside it as a newline, so a line carrying an image's path never sent.
    const enter = newline && claude ? "\x1b\r" : "\r";
    if (!body) write(enter);
    else {
      write(body);
      setTimeout(() => write(enter), 150);
    }
    box.current?.focus();
  };

  const attach = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const item: Attached = { key: ++attachKey, thumb: URL.createObjectURL(file) };
      setAttached((list) => [...list, item]);
      const sessionId = session.id;
      attachImage(sessionId, file).then(
        (path) => setAttached((list) => list.map((a) => (a.key === item.key ? { ...a, path } : a))),
        (e) => {
          URL.revokeObjectURL(item.thumb);
          setAttached((list) => list.filter((a) => a.key !== item.key));
          setNote(e instanceof Error ? e.message : "could not send that image");
        },
      );
    }
  };

  const unattach = (key: number) =>
    setAttached((list) => {
      const gone = list.find((a) => a.key === key);
      if (gone) URL.revokeObjectURL(gone.thumb);
      return list.filter((a) => a.key !== key);
    });

  const chips = attached.length > 0 && (
    <div className="m-chips">
      {attached.map((a) => (
        <span key={a.key} className={"m-chip" + (a.path ? "" : " busy")} title={a.path ?? "sending…"}>
          <img src={a.thumb} alt="" />
          <button onClick={() => unattach(a.key)} aria-label="remove this image">&times;</button>
        </span>
      ))}
    </div>
  );
  const canSend = (!!text.trim() || attached.length > 0) && !uploading;

  const swap = (to: Mode, edit = false) => {
    speech.current?.stop();
    // A latched mic has no button in type mode to stop it: what it heard so far goes in the box.
    void finishHold();
    wantsBox.current = to === "type" && edit;
    setMode(to);
    try {
      localStorage.setItem(MODE_KEY, to);
    } catch {}
  };

  const toggleMic = () => {
    if (speech.current) {
      speech.current.stop();
      return;
    }
    setNote(null);
    before.current = text ? text.replace(/\s*$/, "") + " " : "";
    const started = listen(
      (heard) => setText(before.current + heard),
      (error) => {
        speech.current = undefined;
        setDictating(false);
        if (error) setNote(error === "not-allowed" ? "microphone permission refused" : `dictation stopped (${error})`);
      },
    );
    if (!started) return setNote("this browser will not start dictation");
    speech.current = started;
    setDictating(true);
  };

  /** Stop: transcribe and put the words in the box, never straight into the session. */
  async function finishHold() {
    // A release, a second tap and the page going away can all land on one recording; a second
    // stop() would wait on an `onstop` that has already fired.
    if (phase.current === "idle") return;
    phase.current = "idle";
    setLatched(false);
    try {
      const said = await hold.current.stop(session.id);
      if (!said) return;
      setText((t) => (t.trim() ? `${t.replace(/\s+$/, "")} ${said}` : said));
      box.current?.focus();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "could not transcribe that");
    }
  }

  // A phone that locks, or a swipe home, ends the recording: keep what was said rather than
  // leave a mic open behind the lock screen.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) void finishHold();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  });

  const pressMic = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (phase.current === "latched") return void finishHold();
    if (phase.current !== "idle") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    phase.current = "held";
    pressedAt.current = Date.now();
    setNote(null);
    hold.current.start().catch((err: unknown) => {
      const name = err instanceof Error ? err.name : "";
      setNote(name === "NotAllowedError" ? "microphone permission refused" : `the microphone would not open${name ? ` (${name})` : ""}`);
    });
  };
  const releaseMic = () => {
    if (phase.current !== "held") return;
    if (!recording.current || Date.now() - pressedAt.current < TAP_MS) {
      phase.current = "latched";
      setLatched(true);
    } else void finishHold();
  };
  // The browser took the touch for a gesture of its own. That is not the user letting go, so the
  // mic stays open, latched, and the next tap stops it.
  const cancelMic = () => {
    if (phase.current !== "held") return;
    phase.current = "latched";
    setLatched(true);
  };

  // Henry's own ear when the daemon has whisper, else the browser's recogniser, else no mic.
  const canTalk = whisper || dictationSupported();

  if (mode === "talk" && canTalk) {
    const label =
      holdState === "arming"
        ? "opening mic…"
        : holdState === "recording"
          ? latched ? "listening — tap to stop" : "listening — release to stop"
          : holdState === "working"
            ? "writing it down…"
            : "tap or hold to talk";
    return (
      <div className="m-composer">
        {note && <div className="m-note" onClick={() => setNote(null)}>{note}</div>}
        {chips}
        {/* What it heard, still yours: tap to fix a word, send when it says what you meant. */}
        <div className="m-heard-row">
          <button className={"m-heard" + (text ? "" : " hint")} onClick={() => swap("type", true)} title="tap to edit before sending">
            {text || `${whisper ? "tap or hold" : "tap"} the button and ${claude ? "tell Claude what to do" : "say a command"}`}
          </button>
          {text && (
            <button className="m-clear" onClick={() => setText("")} aria-label="clear what it heard">&times;</button>
          )}
        </div>
        <div className="m-input">
          <button className="m-mode" onClick={() => swap("type")} title="back to the keyboard and the keys" aria-label="keyboard">
            abc
          </button>
          {whisper ? (
            <button
              className={"m-hold" + (holdState === "recording" || latched ? " on" : "")}
              // Pointer events, not click: the press and the release are the whole gesture. The
              // capture keeps the release ours when the thumb drifts off the button mid-sentence.
              onPointerDown={pressMic}
              onPointerUp={releaseMic}
              onPointerCancel={cancelMic}
              onContextMenu={(e) => e.preventDefault()}
              disabled={holdState === "working"}
              aria-label="hold to talk"
            >
              {label}
            </button>
          ) : (
            <button className={"m-hold" + (dictating ? " on" : "")} onClick={toggleMic} aria-label="dictate">
              {dictating ? "listening — tap to stop" : "tap to talk"}
            </button>
          )}
          <button className="m-send" onClick={() => submit(false)} disabled={!canSend} title="send this line to the session">
            send
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="m-composer">
      <div className="m-keys">
        {KEYS.map((k) => (
          <button key={k.label} className="m-key" title={k.title} onClick={() => write(k.data)}>
            {k.label}
          </button>
        ))}
        {claude && (
          <button className="m-key" title="Shift+Enter — a newline inside Claude's prompt" onClick={() => write("\x1b\r")}>
            ⇧⏎
          </button>
        )}
        <button className="m-key m-key-stop" title="Ctrl+C — stop what is running" onClick={() => write("\x03")}>
          ⌃C
        </button>
      </div>
      {note && <div className="m-note" onClick={() => setNote(null)}>{note}</div>}
      {chips}
      <div className="m-input">
        {claude && (
          <>
            <button className="m-attach" onClick={() => picker.current?.click()} title="send an image: a photo, the camera or a file" aria-label="attach an image">
              📎
            </button>
            <input
              ref={picker}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                attach(e.target.files);
                e.target.value = "";
              }}
            />
          </>
        )}
        <textarea
          ref={box}
          className="m-text"
          value={text}
          rows={1}
          placeholder={claude ? "tell Claude what to do" : "type a command"}
          enterKeyHint="send"
          autoCapitalize="sentences"
          autoCorrect="on"
          spellCheck
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            submit(e.shiftKey);
          }}
        />
        {/* One tap, not a hold: holding a button this size is what talk mode is for. */}
        {canTalk && (
          <button className="m-mic" onClick={() => swap("talk")} title="talk instead — the whole bottom becomes the mic" aria-label="talk">
            🎙
          </button>
        )}
        <button className="m-send" onClick={() => submit(false)} disabled={!canSend} title="send this line to the session">
          send
        </button>
      </div>
    </div>
  );
}
