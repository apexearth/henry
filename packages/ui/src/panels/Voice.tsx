// Talking to Henry. Hold right option to dictate into the session you are in, or shift with it
// to ask Henry instead; the button does the same as the latter. On release the clip goes to
// /api/voice/transcribe, and an ask follows it with /api/voice/answer for the spoken reply.
//
// Two calls rather than one so the words appear as soon as the ear is done (about a second)
// instead of after the model has finished several seconds later.
//
// The browser does the resampling. MediaRecorder gives whatever the platform likes (webm/opus
// in Chrome) and whisper.cpp wants 16 kHz mono PCM, so the clip is decoded and rendered through
// an OfflineAudioContext here rather than shelling out to ffmpeg on the daemon's two platforms.
//
// The canvas shows whichever side is making sound — the microphone while recording, Henry's
// own output while speaking — off one AnalyserNode wired to whichever source is live.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { VocabTerm, VoiceReply, VoiceVocabulary } from "@henry/shared";
import { showSession } from "../dock";
import { focusTerminal } from "../Terminal";
import { isMac } from "../platform";
import { cssVar, onTheme } from "../theme";
import { toWav16k } from "../voice-audio";
import { createSession, getState, send, useStore, whenSession } from "../ws";

const SAMPLE_RATE = 16_000;
/** A held key that never comes back up should not record forever. */
const MAX_MS = 60_000;
/**
 * How long the microphone stream is kept after a hold ends.
 *
 * Opening a device costs a few hundred milliseconds, which is exactly the window in which you
 * have already started talking, so the first words of every hold were being cut off. Holding
 * the stream open across a conversation makes every hold after the first one instant. Its
 * tracks are disabled the moment a hold ends — no audio is captured in between — and the
 * stream is dropped entirely once you stop for a minute, so the mic does not stay open on a
 * window left alone.
 */
const WARM_MS = 60_000;

/** Kept in localStorage rather than the daemon: this is what *this window* heard and said, and
 * it should survive a reload the way the rest of the layout does. Capped so it cannot grow
 * without bound in a window left open for days. */
const STORAGE_KEY = "henry.voice.v1";
const MAX_TURNS = 50;

/** One exchange, as the panel shows it: what you said, what came back, where it took you. */
interface Turn {
  id: string;
  at: number;
  kind: Mode;
  /** What whisper heard — written as soon as it is known, before the answer exists. */
  said: string;
  /** Henry's answer; absent while it is still thinking. */
  heard?: string;
  /** The session it switched to, or dictated into. */
  went?: string;
  /** The message Henry put in another session's prompt on your behalf. */
  relayed?: string;
  note?: string;
}

function loadTurns(): Turn[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Turn[]) : [];
    return Array.isArray(parsed) ? parsed.slice(-MAX_TURNS) : [];
  } catch {
    return [];
  }
}

type Phase = "idle" | "arming" | "recording" | "thinking" | "speaking";
/** Who the held key is talking to: Henry, or the session you are looking at. */
type Mode = "ask" | "dictate";

/** One physical key for both, and a bare modifier at that: it types nothing, so it collides with
 * nothing — not a system chord, not a password manager, not a TUI. Shift aims the same hold. */
const ASK_KEY = isMac ? "⇧ right ⌥" : "shift + right alt";
const DICTATE_KEY = isMac ? "right ⌥" : "right alt";

const MODIFIERS = new Set(["ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "ControlLeft", "ControlRight", "MetaLeft", "MetaRight", "CapsLock"]);
const isShift = (code: string) => code === "ShiftLeft" || code === "ShiftRight";

export function VoicePanel() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [turns, setTurns] = useState<Turn[]>(loadTurns);
  const [error, setError] = useState<string | null>(null);
  /** The mic is open and instant. Shown, because a held-open device should never be a secret. */
  const [warm, setWarm] = useState(false);
  const [mode, setModeState] = useState<Mode>("dictate");
  const [ready, setReady] = useState<{ ready: boolean; reason?: string } | null>(null);
  const [showVocab, setShowVocab] = useState(false);
  /** Clicked open: hovering away no longer closes it. */
  const [pinned, setPinned] = useState(false);
  /** Measured when the popover opens: it is rendered in a portal, so it needs the icon's place
   * on screen rather than a position in this tree. */
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const vocabButton = useRef<HTMLButtonElement | null>(null);
  const vocabTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canvas = useRef<HTMLCanvasElement | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Both: the ref is read by the key handlers and by the recorder's stop, which run outside
  // React; the state is what the label renders, so shift joining a hold shows up immediately.
  const modeRef = useRef<Mode>("dictate");
  /** Set when a hold turned out to be a chord: the recorder still stops, the clip is dropped. */
  const discard = useRef(false);
  /** False once the key is up, so a release during the mic handshake does not start a recording. */
  const held = useRef(false);
  const stream = useRef<MediaStream | null>(null);
  const warmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The key handlers are bound once; they read the phase here rather than close over a stale one.
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  useEffect(() => {
    fetch("/api/voice/status")
      .then((r) => r.json())
      .then(setReady)
      .catch(() => setReady({ ready: false, reason: "daemon unreachable" }));
  }, []);

  const context = () => (audioCtx.current ??= new AudioContext());

  // A context binds its output device when it is made, and Chrome can keep rendering to one
  // that has since gone — a dock's speakers after the unplug — so an answer plays into nothing.
  // Any change in the device set throws the context away; the next hold or answer builds one
  // on whatever the system now calls its output. A busy context waits for idle, because the
  // analyser and the nodes feeding it are its own.
  const staleCtx = useRef(false);
  const dropContext = useCallback(() => {
    if (phaseRef.current !== "idle") {
      staleCtx.current = true;
      return;
    }
    staleCtx.current = false;
    void audioCtx.current?.close();
    audioCtx.current = null;
    analyser.current = null;
  }, []);
  useEffect(() => {
    const devices = navigator.mediaDevices;
    if (!devices) return;
    devices.addEventListener("devicechange", dropContext);
    return () => devices.removeEventListener("devicechange", dropContext);
  }, [dropContext]);
  useEffect(() => {
    if (phase === "idle" && staleCtx.current) dropContext();
  }, [phase, dropContext]);

  /**
   * The popover is in a portal, so moving the pointer towards it leaves the icon's element and
   * would close the thing you are reaching for. A short grace period covers the gap between the
   * two, and the popover holds it open once the pointer is inside. Clicking the icon pins it,
   * for reading a long list without keeping the mouse still at all.
   */
  const keepVocab = useCallback(() => {
    if (vocabTimer.current) clearTimeout(vocabTimer.current);
    vocabTimer.current = null;
  }, []);

  const openVocab = useCallback(
    (open: boolean) => {
      keepVocab();
      if (open) {
        setAnchor(vocabButton.current?.getBoundingClientRect() ?? null);
        setShowVocab(true);
        return;
      }
      if (pinned) return;
      vocabTimer.current = setTimeout(() => setShowVocab(false), 160);
    },
    [keepVocab, pinned],
  );

  const toggleVocabPin = useCallback(() => {
    keepVocab();
    setAnchor(vocabButton.current?.getBoundingClientRect() ?? null);
    setPinned(!pinned);
    setShowVocab(!pinned);
  }, [keepVocab, pinned]);

  // Escape closes a pinned list, and an unmount must not leave a timer behind.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPinned(false);
      setShowVocab(false);
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      if (vocabTimer.current) clearTimeout(vocabTimer.current);
    };
  }, []);

  const setMode = useCallback((m: Mode) => {
    modeRef.current = m;
    setModeState(m);
  }, []);

  // Functional updates throughout: these are called from a recorder callback captured by an
  // earlier render, which must not append to the log as it was when that render ran.
  const addTurn = useCallback((t: Turn) => {
    setTurns((prev) => [...prev, t].slice(-MAX_TURNS));
    return t.id;
  }, []);

  const updateTurn = useCallback((id: string, patch: Partial<Turn>) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(turns));
    } catch {
      // quota or private mode: the log just won't survive a reload
    }
  }, [turns]);

  // One analyser, repointed at whatever is currently making sound.
  const listenTo = useCallback((node: AudioNode | null) => {
    const ctx = context();
    analyser.current ??= ctx.createAnalyser();
    analyser.current.fftSize = 1024;
    try {
      analyser.current.disconnect();
    } catch {
      // not connected yet
    }
    if (node) node.connect(analyser.current);
  }, []);

  // The waveform. Runs whenever the panel is mounted; an idle analyser just draws a flat line.
  useEffect(() => {
    let raf = 0;
    // Resolved once per phase (and again when the theme moves) rather than every frame:
    // getComputedStyle at 60fps is a layout read nobody needs.
    let stroke = strokeFor(phase);
    const offTheme = onTheme(() => (stroke = strokeFor(phase)));
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const el = canvas.current;
      const a = analyser.current;
      if (!el) return;
      const ctx2d = el.getContext("2d");
      if (!ctx2d) return;
      const { width, height } = el.getBoundingClientRect();
      if (el.width !== width * devicePixelRatio || el.height !== height * devicePixelRatio) {
        el.width = width * devicePixelRatio;
        el.height = height * devicePixelRatio;
      }
      ctx2d.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      ctx2d.clearRect(0, 0, width, height);
      const mid = height / 2;
      ctx2d.strokeStyle = stroke;
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      if (!a) {
        ctx2d.moveTo(0, mid);
        ctx2d.lineTo(width, mid);
      } else {
        const buf = new Uint8Array(a.fftSize);
        a.getByteTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) {
          const x = (i / (buf.length - 1)) * width;
          const y = mid + ((buf[i]! - 128) / 128) * mid * 0.9;
          i ? ctx2d.lineTo(x, y) : ctx2d.moveTo(x, y);
        }
      }
      ctx2d.stroke();
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      offTheme();
    };
  }, [phase]);

  /** The live capture stream, kept warm between holds. Tracks are off unless a hold is open. */
  const streamOf = useCallback(async (): Promise<MediaStream> => {
    if (warmTimer.current) {
      clearTimeout(warmTimer.current);
      warmTimer.current = null;
    }
    const existing = stream.current;
    if (existing?.active) {
      for (const t of existing.getTracks()) t.enabled = true;
      return existing;
    }
    const fresh = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    stream.current = fresh;
    setWarm(true);
    return fresh;
  }, []);

  /** End a hold's use of the device: capture off, release scheduled. Every path that opened the
   * microphone has to come through here, including the ones that never started a recorder. */
  const idleMic = useCallback((mic: MediaStream) => {
    for (const t of mic.getTracks()) t.enabled = false;
    if (warmTimer.current) clearTimeout(warmTimer.current);
    warmTimer.current = setTimeout(() => release(), WARM_MS);
  }, []);

  const release = useCallback(() => {
    if (warmTimer.current) clearTimeout(warmTimer.current);
    warmTimer.current = null;
    for (const t of stream.current?.getTracks() ?? []) t.stop();
    stream.current = null;
    setWarm(false);
  }, []);

  // A closed panel must not leave a device open behind it — nor deliver what it was holding.
  // Ending the tracks ends the recorder, whose onstop would otherwise run after unmount and type
  // half a second of audio into whatever session was active.
  useEffect(
    () => () => {
      discard.current = true;
      if (stopTimer.current) clearTimeout(stopTimer.current);
      const rec = recorder.current;
      recorder.current = null;
      if (rec && rec.state !== "inactive") rec.stop();
      release();
    },
    [release],
  );

  const start = useCallback(
    async (m: Mode) => {
      if (phase !== "idle" || !ready?.ready) return;
      setError(null);
      setMode(m);
      held.current = true;
      // Set before the await: opening a device is not instant, and the one thing worse than a
      // slow microphone is a slow microphone that looks ready.
      setPhase("arming");
      try {
        // http:// on a tailnet address is not a secure context, so the browser does not define
        // mediaDevices at all and the call below would be a bare TypeError. The phone listener
        // is plain HTTP, so this is the message anyone reaching the panel from a phone gets.
        if (!navigator.mediaDevices?.getUserMedia) {
          setError(isSecureContext ? "this browser has no microphone API" : "the microphone needs a secure origin — Henry is on plain http here");
          setPhase("idle");
          return;
        }
        const mic = await streamOf();
        // Released during the handshake: that was a tap, not a hold. The device is open by now,
        // so it has to be quieted and scheduled for release exactly as a finished hold would be —
        // otherwise a mistimed tap leaves the microphone live for the life of the panel.
        if (!held.current) {
          idleMic(mic);
          setPhase("idle");
          return;
        }
        listenTo(context().createMediaStreamSource(mic));
        const rec = new MediaRecorder(mic);
        chunks.current = [];
        rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
        rec.onstop = () => {
          idleMic(mic);
          listenTo(null);
          if (discard.current) return;
          // Read now, not from the closure: shift may have joined the hold after it started.
          void deliver(new Blob(chunks.current, { type: rec.mimeType }), modeRef.current, getState().activeSessionId);
        };
        recorder.current = rec;
        discard.current = false;
        rec.start();
        setPhase("recording");
        stopTimer.current = setTimeout(() => stop(), MAX_MS);
      } catch (e) {
        // Same reason: the throw may have come from MediaRecorder, after the device was opened.
        if (stream.current) idleMic(stream.current);
        setError(e instanceof Error ? e.message : "microphone unavailable");
        setPhase("idle");
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [phase, ready, listenTo, streamOf, release, setMode],
  );

  const stop = useCallback(() => {
    held.current = false;
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    const rec = recorder.current;
    recorder.current = null;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  /** End the hold and throw the clip away: the key was part of something else. */
  const cancel = useCallback(() => {
    discard.current = true;
    stop();
    setPhase("idle");
  }, [stop]);

  async function deliver(blob: Blob, m: Mode, target: string | null) {
    setPhase("thinking");
    try {
      const wav = await toWav16k(await blob.arrayBuffer(), context());
      if (m === "dictate") return await dictate(wav, target);

      // The question goes into the log as soon as the ear is done; the answer fills in beside it.
      const question = await hear(wav);
      if (!question) return fail("nothing heard");
      const id = addTurn({ id: crypto.randomUUID(), at: Date.now(), kind: "ask", said: question });

      const res = await fetch("/api/voice/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: question }) });
      const body = (await res.json()) as VoiceReply & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `answer failed (${res.status})`);
      const relayed = body.action?.kind === "type" || body.action?.kind === "open" ? body.action.text : undefined;
      updateTurn(id, { heard: body.text, went: body.action?.title, note: body.reason, relayed });
      // Act before speaking: the sentence describes what has already happened.
      if (body.action?.kind === "switch") showSession(body.action.sessionId);
      // Typed, never submitted. A relayed message still needs a person to send it, which is what
      // keeps Henry out of the loop between you and an agent.
      if (body.action?.kind === "type" && body.action.text) typeInto(body.action.sessionId, body.action.text);
      // The session starts now; its first prompt lands once Claude is up, while Henry speaks.
      if (body.action?.kind === "open") void open(body.action.cwd, body.action.peer, body.action.text);
      if (body.audio) await play(body.audio);
      else setPhase("idle");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Typed into the active session, not sent. Whisper mishears names, and the difference between
   * reviewing a line and having it land in an agent's prompt is the difference between a typo
   * and a wrong instruction already being acted on. Press Enter yourself.
   */
  async function dictate(wav: ArrayBuffer, sessionId: string | null) {
    // Captured when the hold ended, not now: whisper takes about a second, and switching tabs
    // while it runs would otherwise land the words in the session you moved to.
    if (!sessionId) return fail("no active session to type into");
    const text = await hear(wav, sessionId);
    if (!text) return fail("nothing heard");
    // Trailing space: two holds in a row are one sentence continuing, and without it the second
    // one arrives welded to the first ("...three.Wow, it's").
    typeInto(sessionId, text + " ");
    const title = getState().sessions.find((s) => s.id === sessionId)?.title;
    addTurn({ id: crypto.randomUUID(), at: Date.now(), kind: "dictate", said: text, went: title, note: "typed in — press Enter to send" });
    setPhase("idle");
  }

  /** A clip through whisper. `sessionId` biases the decode toward that session's own vocabulary. */
  async function hear(wav: ArrayBuffer, sessionId?: string): Promise<string> {
    const url = sessionId ? `/api/voice/transcribe?session=${encodeURIComponent(sessionId)}` : "/api/voice/transcribe";
    const res = await fetch(url, { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
    const body = (await res.json()) as { text?: string; error?: string };
    if (!res.ok) throw new Error(body.error ?? `transcribe failed (${res.status})`);
    return body.text?.trim() ?? "";
  }

  /**
   * Put words in a session's prompt and hand it the keyboard. Never submitted — the Enter is the
   * user's, which is what keeps dictated and relayed text something a person sent.
   *
   * `showSession` only brings a tab forward, and when it is already the active tab that changes
   * nothing, so focus is taken explicitly rather than inferred from the tab moving.
   */
  function typeInto(sessionId: string, data: string) {
    send({ type: "pty:input", sessionId, data });
    showSession(sessionId);
    requestAnimationFrame(() => focusTerminal(sessionId));
  }

  /**
   * A session Henry was asked to open, with its first prompt typed in and left unsent. The
   * words wait for Claude's first hook: typed before its prompt exists they land in whatever
   * reads the terminal first. Hooks that never arrive would wait forever, so after a while the
   * text goes in anyway — a Claude that is up by then takes it, and one that is not was never
   * going to.
   */
  async function open(cwd: string, peer: string | undefined, text: string | undefined) {
    const session = await Promise.race([createSession(cwd, undefined, "claude", peer), new Promise<undefined>((r) => setTimeout(() => r(undefined), 10_000))]);
    if (!session) return setError(`could not open a session in ${cwd}${peer ? ` on ${peer}` : ""}`);
    if (!text) return;
    await whenSession(session.id, (s) => !!s.claudeActive, 20_000);
    // Give the input box a beat to appear after the hook — the hook fires as Claude boots.
    await new Promise((r) => setTimeout(r, 800));
    if (getState().sessions.find((s) => s.id === session.id)?.status === "running") typeInto(session.id, text);
  }

  function fail(message: string) {
    setError(message);
    setPhase("idle");
  }

  /**
   * Decoded whole, then played from a buffer — not streamed through an <audio> element.
   *
   * An element starts as soon as it has *some* data, which is before `resume()` has settled the
   * context and before the analyser is carrying the signal to the destination, so the first
   * word or two went out through a graph that was not connected yet. A buffer source cannot
   * start early: everything is decoded and wired before `start()` is called.
   */
  async function play(base64: string) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const ctx = context();
    try {
      await ctx.resume();
      const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      listenTo(src);
      analyser.current?.connect(ctx.destination);
      setPhase("speaking");
      await new Promise<void>((done) => {
        src.onended = () => done();
        src.start();
      });
    } finally {
      listenTo(null);
      setPhase("idle");
    }
  }

  // Both holds are global and on the capture phase: the point is to speak while a terminal has
  // focus, which means seeing the key before xterm does.
  //
  // Dictation is a *bare right option*, held. A key that types nothing cannot be stolen from
  // anything that types — no chord to collide with an OS or 1Password binding, and plain space
  // stays Claude Code's. Option+letter still works, because this never calls preventDefault and
  // cancels the moment a second key joins the hold. Repeat events fire while held; ignore them.
  //
  // The one exception to "never preventDefault" is the bare Alt itself on Windows: a press and
  // release with nothing in between is how Chrome and Edge focus the browser menu, so every
  // dictation would end with the keyboard taken from the terminal and handed to the toolbar.
  // Cancelling the default on the events the hold consumes stops that; an Alt+letter chord is a
  // different keydown, with its default untouched.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      // ctrlKey rules out AltGr, which Windows synthesizes as ControlLeft+AltRight — otherwise
      // every accented character on an EU layout opens the microphone.
      if (e.code === "AltRight" && !e.ctrlKey && phaseRef.current === "idle") {
        if (!isMac) e.preventDefault();
        void start(e.shiftKey ? "ask" : "dictate");
        return;
      }
      if (phaseRef.current !== "recording" && phaseRef.current !== "arming") return;
      // Shift joining a hold already in progress aims it at Henry instead. Deciding on the way
      // up rather than the way down is what makes the order you press the two keys irrelevant.
      if (isShift(e.code)) {
        setMode("ask");
        return;
      }
      // Any key that actually types is someone writing ø, not talking: drop the clip and let
      // the character through untouched. Modifiers are not that, and must not cancel.
      if (!MODIFIERS.has(e.code)) cancel();
    };
    const up = (e: KeyboardEvent) => {
      // "arming" counts: a release during the mic handshake must still end the hold.
      if (phaseRef.current !== "recording" && phaseRef.current !== "arming") return;
      // The hold is the option key, whichever destination it ended up pointing at.
      if (e.code !== "AltRight") return;
      if (!isMac) e.preventDefault();
      stop();
    };
    // A hold that survives the window losing focus would leave the microphone open.
    const blur = () => (phaseRef.current === "recording" || phaseRef.current === "arming") && cancel();
    addEventListener("keydown", down, true);
    addEventListener("keyup", up, true);
    addEventListener("blur", blur);
    return () => {
      removeEventListener("keydown", down, true);
      removeEventListener("keyup", up, true);
      removeEventListener("blur", blur);
    };
  }, [start, stop, cancel, setMode]);

  const label =
    phase === "arming"
      ? "opening mic…"
      : phase === "recording"
        ? mode === "dictate"
          ? "listening — release to type it in"
          : "listening — release to ask Henry"
        : phase === "thinking"
          ? "thinking…"
          : phase === "speaking"
            ? "speaking"
            : warm
              ? "hold to talk — mic ready"
              : "hold to talk";

  return (
    <div className="voice-panel" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, height: "100%", boxSizing: "border-box" }}>
      <canvas ref={canvas} style={{ width: "100%", height: 48, flex: "0 0 auto" }} />
      <div style={{ display: "flex", gap: 6, alignItems: "stretch", position: "relative" }}>
      <button
        onPointerDown={() => void start("ask")}
        onPointerUp={stop}
        onPointerLeave={() => phase === "recording" && stop()}
        disabled={!ready?.ready || phase === "thinking" || phase === "speaking"}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "8px 12px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: phase === "recording" ? "var(--warn)" : "var(--bg-alt)",
          color: phase === "recording" ? "var(--bg)" : phase === "arming" ? "var(--fg-dim)" : "var(--fg)",
          cursor: ready?.ready ? "pointer" : "not-allowed",
          font: "inherit",
          flex: 1,
        }}
      >
        <span>{label}</span>
        {phase === "idle" && (
          <kbd
            style={{
              font: "inherit",
              fontSize: 11,
              padding: "1px 6px",
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--fg-dim)",
            }}
          >
            {ASK_KEY}
          </kbd>
        )}
      </button>
      {ready?.ready && (
        <div
          onMouseEnter={() => openVocab(true)}
          onMouseLeave={() => openVocab(false)}
          style={{ display: "flex", alignItems: "center" }}
        >
          <button
            ref={vocabButton}
            aria-label="what it listens for"
            title="what it listens for"
            onClick={toggleVocabPin}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              alignSelf: "stretch",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: showVocab ? "var(--accent-soft)" : "var(--bg-alt)",
              color: showVocab ? "var(--accent)" : "var(--fg-dim)",
              borderColor: pinned ? "var(--accent)" : "var(--border)",
              cursor: "pointer",
              font: "inherit",
            }}
          >
            <WordListIcon />
          </button>
          {showVocab && anchor && <Vocabulary anchor={anchor} onEnter={keepVocab} onLeave={() => openVocab(false)} />}
        </div>
      )}
      </div>
      {ready?.ready && <div style={{ color: "var(--fg-dim)", fontSize: 11 }}>{DICTATE_KEY} types into the session instead</div>}
      {ready && !ready.ready && <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>{ready.reason}</div>}
      {error && <div style={{ color: "var(--warn)", fontSize: 12 }}>{error}</div>}
      {/* Newest first. The log is read at a glance mid-task, so the thing just said is at the
          top where the eye already is, and everything behind it fades rather than competing. */}
      <div style={{ overflowY: "auto", fontSize: 13, display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
        {[...turns].reverse().map((t, i) => (
          <div key={t.id} style={{ display: "flex", flexDirection: "column", gap: 3, opacity: Math.max(0.3, 1 - i * 0.18) }}>
            <div style={{ color: "var(--fg-dim)", fontSize: 11 }}>
              {new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {t.kind === "dictate" ? " · dictated" : ""}
              {t.went ? ` · ${t.went}` : ""}
            </div>
            <div style={{ color: "var(--fg-dim)" }}>“{t.said}”</div>
            {t.heard && <div style={{ color: "var(--fg)" }}>{t.heard}</div>}
            {t.relayed && (
              <div style={{ borderLeft: "2px solid var(--accent)", paddingLeft: 6, color: "var(--fg-dim)", fontSize: 12 }}>{t.relayed}</div>
            )}
            {!t.heard && t.kind === "ask" && <div style={{ color: "var(--fg-dim)", fontStyle: "italic" }}>…</div>}
            {t.note && <div style={{ color: "var(--fg-dim)", fontSize: 11 }}>{t.note}</div>}
          </div>
        ))}
      </div>
      {turns.length > 0 && (
        <button
          onClick={() => setTurns([])}
          style={{ alignSelf: "flex-start", font: "inherit", fontSize: 11, padding: "2px 6px", background: "none", border: "none", color: "var(--fg-dim)", cursor: "pointer" }}
        >
          clear
        </button>
      )}
    </div>
  );
}

/**
 * A canvas takes colour strings, not custom properties: `var(--accent)` is not a colour and
 * paints black. Recording is the one state that earns its own colour, because it is the one
 * where you need to know at a glance that the microphone is open.
 */
function WordListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M2 3.5h6M2 7h9M2 10.5h5" />
      <circle cx="11.5" cy="3.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** The words whisper was primed with, grouped by where they came from. The ear is otherwise a
 * black box: you say a word, it comes back wrong, and nothing tells you whether it was even on
 * the list. Read for the session in view, since that is what the next hold will be biased with. */
/**
 * Kept outside the component so a hover does not refetch what it already knows: the popover
 * mounts and unmounts constantly, and a fresh fetch each time showed "reading…" every pass. The
 * list only moves when the session does, so it is cached against that.
 */
let vocabCache: { key: string; value: VoiceVocabulary } | null = null;

function useVocabulary(sessionId: string | null): VoiceVocabulary | null {
  const key = sessionId ?? "";
  const [vocab, setVocab] = useState<VoiceVocabulary | null>(vocabCache?.key === key ? vocabCache.value : null);

  useEffect(() => {
    if (vocabCache?.key === key) {
      setVocab(vocabCache.value);
      return;
    }
    const url = sessionId ? `/api/voice/vocabulary?session=${encodeURIComponent(sessionId)}` : "/api/voice/vocabulary";
    let live = true;
    fetch(url)
      .then((r) => r.json())
      .then((v: VoiceVocabulary) => {
        vocabCache = { key, value: v };
        if (live) setVocab(v);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, sessionId]);

  return vocab;
}

/**
 * A popover in a portal, positioned against the icon.
 *
 * The panel lives inside a dock pane that clips its overflow, so an absolutely positioned child
 * is trapped inside a box a couple of hundred pixels tall — the list was there and unreadable.
 * Rendering into the body escapes the clip; fixed coordinates off the icon's rect keep it
 * anchored, flipping below when there is not enough room above.
 */
function Vocabulary({ anchor, onEnter, onLeave }: { anchor: DOMRect; onEnter: () => void; onLeave: () => void }) {
  const sessionId = useStore((s) => s.activeSessionId);
  const vocab = useVocabulary(sessionId);

  const width = Math.min(420, window.innerWidth - 24);
  const above = anchor.top > 280;
  const style: CSSProperties = {
    position: "fixed",
    left: Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12)),
    [above ? "bottom" : "top"]: above ? window.innerHeight - anchor.top + 6 : anchor.bottom + 6,
    width,
    maxHeight: 260,
    zIndex: 60,
  };

  if (!vocab) return <div style={{ ...style, color: "var(--fg-dim)", fontSize: 11 }} />;
  const groups: [VocabTerm["source"], string][] = [
    ["you", "yours (voice.vocabulary in config.json)"],
    ["session", "open sessions"],
    ["repo", "repos"],
    ["branch", "branches"],
    ["file", "files this session is touching"],
  ];
  const chip = (t: VocabTerm, dim: boolean) => (
    <span
      key={t.source + t.term}
      style={{
        fontSize: 11,
        padding: "1px 5px",
        borderRadius: 4,
        border: "1px solid var(--border)",
        color: dim ? "var(--fg-dim)" : "var(--fg)",
        opacity: dim ? 0.6 : 1,
        textDecoration: dim ? "line-through" : "none",
      }}
    >
      {t.term}
    </span>
  );
  return createPortal(
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        ...style,
        overflowY: "auto",
        padding: 8,
        borderRadius: 6,
        border: "1px solid var(--border)",
        background: "var(--bg)",
        boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
        fontSize: 11,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {groups.map(([source, label]) => {
        const mine = vocab.used.filter((t) => t.source === source);
        if (!mine.length) return null;
        return (
          <div key={source} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ color: "var(--fg-dim)" }}>{label}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{mine.map((t) => chip(t, false))}</div>
          </div>
        );
      })}
      {vocab.dropped.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ color: "var(--warn)" }}>
            {vocab.dropped.length} did not fit whisper's prompt budget and were not listened for:
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{vocab.dropped.map((t) => chip(t, true))}</div>
        </div>
      )}
      <div style={{ color: "var(--fg-dim)" }}>
        A word it keeps mishearing goes in <code>voice.vocabulary</code> in config.json — those come first and are never dropped.
      </div>
    </div>,
    document.body,
  );
}

function strokeFor(phase: Phase): string {
  if (phase === "recording") return cssVar("--warn") || "#d29922";
  if (phase === "arming") return cssVar("--fg-dim") || "#8b949e";
  return cssVar("--accent") || "#6ea8fe";
}
