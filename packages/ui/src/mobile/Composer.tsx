// The phone's way into a session. A phone keyboard cannot send Esc, Tab or ⌃C, and xterm's
// hidden textarea fights autocorrect, so the terminal on a phone is a screen you read and this
// is the thing you type at: compose a line, send it, and reach the handful of keys Claude Code
// actually wants from a row of buttons.
//
// Talking is a different posture, not a button on the typing one: a thumb-sized mic wedged next
// to the keys is a thing you miss and long-press into a text selection. So the composer has two
// modes and 🎙/⌨ swaps the whole bottom of the screen between them — keys and a text box for
// typing, one slab you hold and the words it heard for talking.
import { useEffect, useRef, useState } from "react";
import { isClaudeSession, type Session } from "@henry/shared";
import { send, useStore } from "../ws";
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

const KEYS: Key[] = [
  { label: "esc", data: "\x1b", title: "Escape — interrupt Claude, or leave a prompt" },
  { label: "tab", data: "\t", title: "Tab" },
  { label: "1", data: "1", title: "answer a prompt with 1" },
  { label: "2", data: "2", title: "answer a prompt with 2" },
  { label: "3", data: "3", title: "answer a prompt with 3" },
  { label: "↑", data: "\x1b[A", title: "up — previous command, or move in a menu" },
  { label: "↓", data: "\x1b[B", title: "down" },
  { label: "←", data: "\x1b[D", title: "left — move the cursor, or step back in a menu" },
  { label: "→", data: "\x1b[C", title: "right" },
  { label: "⏎", data: "\r", title: "Enter on its own" },
  { label: "⌃C", data: "\x03", title: "Ctrl+C — stop what is running" },
];

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

export function Composer({ session }: { session: Session }) {
  const [mode, setMode] = useState<Mode>(readMode);
  const [text, setText] = useState("");
  const [dictating, setDictating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** Henry's own ear, when this page can record and the daemon has whisper. Preferred over the
   * browser's recogniser because it knows what your sessions, repos and files are called. */
  const [holdState, setHoldState] = useState<"idle" | "arming" | "recording" | "working">("idle");
  const [whisper, setWhisper] = useState(false);
  const hold = useRef(holdToTalk(setHoldState));
  const holding = useRef(false);
  /** Set when the swap to type mode was a request to edit, so the keyboard comes up with it. */
  const wantsBox = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const speech = useRef<Dictation | undefined>(undefined);
  // What was in the box when the microphone opened; recognised words are appended to it.
  const before = useRef("");
  const claude = isClaudeSession(session);

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
    const body = text;
    if (!body && !newline) return;
    setText("");
    // Shift+Enter is a newline inside Claude Code's prompt (ESC CR, what /terminal-setup binds);
    // a plain shell gets a normal Enter.
    write(body + (newline && claude ? "\x1b\r" : "\r"));
    box.current?.focus();
  };

  const swap = (to: Mode, edit = false) => {
    speech.current?.stop();
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

  /** Release: transcribe and put the words in the box, never straight into the session. */
  async function finishHold() {
    // pointerup and pointercancel can both land on one hold; the second stop() would wait on an
    // `onstop` that has already fired.
    if (!holding.current) return;
    holding.current = false;
    try {
      const said = await hold.current.stop(session.id);
      if (!said) return;
      setText((t) => (t.trim() ? `${t.replace(/\s+$/, "")} ${said}` : said));
      box.current?.focus();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "could not transcribe that");
    }
  }

  // Henry's own ear when the daemon has whisper, else the browser's recogniser, else no mic.
  const canTalk = whisper || dictationSupported();

  if (mode === "talk" && canTalk) {
    const label =
      holdState === "arming"
        ? "opening mic…"
        : holdState === "recording"
          ? "listening — release to stop"
          : holdState === "working"
            ? "writing it down…"
            : "hold to talk";
    return (
      <div className="m-composer">
        {note && <div className="m-note" onClick={() => setNote(null)}>{note}</div>}
        {/* What it heard, still yours: tap to fix a word, send when it says what you meant. */}
        <button className={"m-heard" + (text ? "" : " hint")} onClick={() => swap("type", true)} title="tap to edit before sending">
          {text || `${whisper ? "hold" : "tap"} the button and ${claude ? "tell Claude what to do" : "say a command"}`}
        </button>
        <div className="m-input">
          <button className="m-mode" onClick={() => swap("type")} title="back to the keyboard and the keys" aria-label="keyboard">
            abc
          </button>
          {whisper ? (
            <button
              className={"m-hold" + (holdState === "recording" ? " on" : "")}
              // Pointer events, not click: the press and the release are the whole gesture. The
              // capture keeps the release ours when the thumb drifts off the button mid-sentence.
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                holding.current = true;
                void hold.current.start();
              }}
              onPointerUp={() => void finishHold()}
              onPointerCancel={() => void finishHold()}
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
          <button className="m-send" onClick={() => submit(false)} disabled={!text.trim()} title="send this line to the session">
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
      </div>
      {note && <div className="m-note" onClick={() => setNote(null)}>{note}</div>}
      <div className="m-input">
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
        <button className="m-send" onClick={() => submit(false)} disabled={!text.trim()} title="send this line to the session">
          send
        </button>
      </div>
    </div>
  );
}
