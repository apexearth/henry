// The phone's way into a session. A phone keyboard cannot send Esc, Tab or ⌃C, and xterm's
// hidden textarea fights autocorrect, so the terminal on a phone is a screen you read and this
// is the thing you type at: compose a line, send it, and reach the handful of keys Claude Code
// actually wants from a row of buttons.
import { useEffect, useRef, useState } from "react";
import { isClaudeSession, type Session } from "@henry/shared";
import { send } from "../ws";
import { dictationSupported, listen, type Dictation } from "./dictation";

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
  { label: "⏎", data: "\r", title: "Enter on its own" },
  { label: "⌃C", data: "\x03", title: "Ctrl+C — stop what is running" },
];

export function Composer({ session }: { session: Session }) {
  const [text, setText] = useState("");
  const [dictating, setDictating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const speech = useRef<Dictation | undefined>(undefined);
  // What was in the box when the microphone opened; recognised words are appended to it.
  const before = useRef("");
  const claude = isClaudeSession(session);

  // Leaving the session (or the page) with the microphone open would keep listening.
  useEffect(() => () => speech.current?.stop(), []);
  useEffect(() => {
    speech.current?.stop();
    setText("");
  }, [session.id]);

  // Grow with what is typed (or dictated), up to a few lines, so a long prompt is readable
  // without taking the terminal's half of the screen.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

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
          placeholder={dictating ? "listening…" : claude ? "tell Claude what to do" : "type a command"}
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
        {dictationSupported() && (
          <button className={"m-mic" + (dictating ? " on" : "")} onClick={toggleMic}
            title={dictating ? "stop dictating" : "dictate — hands-free, words appear as you speak"} aria-label="dictate">
            ●
          </button>
        )}
        <button className="m-send" onClick={() => submit(false)} disabled={!text.trim()} title="send this line to the session">
          send
        </button>
      </div>
    </div>
  );
}
