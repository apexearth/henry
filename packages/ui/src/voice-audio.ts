// Turning what a browser records into what whisper.cpp reads, shared by the Voice panel and the
// phone composer. MediaRecorder gives whatever the platform likes — webm/opus in Chrome, mp4/aac
// on iOS — and whisper wants 16 kHz mono PCM, so the conversion happens here rather than adding
// a media dependency to the daemon on two platforms.

const SAMPLE_RATE = 16_000;

/** Whatever MediaRecorder produced → 16 kHz mono 16-bit WAV, which is what whisper.cpp reads. */
export async function toWav16k(input: ArrayBuffer, ctx: AudioContext): Promise<ArrayBuffer> {
  // The panel's own context, not a new one: browsers cap concurrent AudioContexts at about six,
  // and one per utterance bricked the panel after a handful of holds.
  const decoded = await ctx.decodeAudioData(input.slice(0));
  const frames = Math.ceil((decoded.duration * SAMPLE_RATE) | 0) || 1;
  const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const out = await offline.startRendering();
  return encodeWav(out.getChannelData(0), SAMPLE_RATE);
}

/** Raw samples at the capture rate → 16 kHz mono 16-bit WAV. */
export async function pcmToWav16k(samples: Float32Array, rate: number): Promise<ArrayBuffer> {
  const frames = Math.max(1, Math.ceil((samples.length * SAMPLE_RATE) / rate));
  const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const buffer = offline.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  const out = await offline.startRendering();
  return encodeWav(out.getChannelData(0), SAMPLE_RATE);
}

/** The daemon's speech gate (-40 dBFS RMS), so a cut here is a clip it will not throw away. */
const VOICED_RMS = 0.01;
/** A pause this long ends a thought. Shorter cuts mid-sentence on a breath. */
const PAUSE_MS = 700;
/** Past this, any short pause will do: a clip that keeps growing keeps the words from arriving. */
const SOFT_MAX_MS = 15_000;
const SOFT_PAUSE_MS = 250;
/** And past this it is cut wherever it is, pause or not. */
const HARD_MAX_MS = 25_000;
/** Less speech than this is a click or a cough, not words. */
const MIN_VOICED_MS = 250;
/** Kept from before the first loud block, so a soft first syllable is not clipped. */
const PREROLL_MS = 300;

/**
 * Continuous dictation's ear: raw blocks in, one clip out per thought. A clip ends at a pause,
 * so whisper gets whole phrases rather than words cut in half, and silence between thoughts is
 * dropped here rather than sent to be gated away.
 */
export class Segmenter {
  private blocks: Float32Array[] = [];
  private samples = 0;
  private voicedMs = 0;
  private quietMs = 0;

  constructor(private rate: number, private emit: (clip: Float32Array) => void) {}

  push(block: Float32Array): void {
    const ms = (block.length / this.rate) * 1000;
    this.blocks.push(block);
    this.samples += block.length;
    if (rms(block) > VOICED_RMS) {
      this.voicedMs += ms;
      this.quietMs = 0;
    } else {
      this.quietMs += ms;
    }
    if (this.voicedMs === 0) return this.trimToPreroll();
    const total = (this.samples / this.rate) * 1000;
    const pause = total >= SOFT_MAX_MS ? SOFT_PAUSE_MS : PAUSE_MS;
    if (this.quietMs >= pause) {
      if (this.voicedMs >= MIN_VOICED_MS) this.cut();
      else this.voicedMs = 0;
      this.trimToPreroll();
    } else if (total >= HARD_MAX_MS) {
      this.cut();
    }
  }

  /** What is left when listening stops, if it holds any words. */
  flush(): void {
    if (this.voicedMs >= MIN_VOICED_MS) this.cut();
  }

  private cut(): void {
    const clip = new Float32Array(this.samples);
    let at = 0;
    for (const b of this.blocks) {
      clip.set(b, at);
      at += b.length;
    }
    this.blocks = [];
    this.samples = 0;
    this.voicedMs = 0;
    this.quietMs = 0;
    this.emit(clip);
  }

  private trimToPreroll(): void {
    const keep = (PREROLL_MS / 1000) * this.rate;
    while (this.blocks.length > 1 && this.samples - this.blocks[0]!.length >= keep) this.samples -= this.blocks.shift()!.length;
  }
}

function rms(block: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i]! * block[i]!;
  return Math.sqrt(sum / (block.length || 1));
}

/** An AudioWorklet that hands the main thread raw samples in ~40 ms blocks. A Blob module so
 * there is no file to serve; MediaRecorder cannot do this job, since stopping one to cut a clip
 * loses the audio while the next one starts. */
const TAP_SOURCE = `registerProcessor("henry-tap", class extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(2048); this.n = 0; }
    }
    return true;
  }
});`;
const tapLoaded = new WeakSet<BaseAudioContext>();

/** A node that calls `onBlock` with every block of what is connected to it. */
export async function tapNode(ctx: AudioContext, onBlock: (block: Float32Array) => void): Promise<AudioWorkletNode> {
  if (!tapLoaded.has(ctx)) {
    const url = URL.createObjectURL(new Blob([TAP_SOURCE], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    tapLoaded.add(ctx);
  }
  const node = new AudioWorkletNode(ctx, "henry-tap", { numberOfInputs: 1, numberOfOutputs: 0 });
  node.port.onmessage = (e: MessageEvent<Float32Array>) => onBlock(e.data);
  return node;
}

function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Whether this page can record at all. A phone reaching Henry over plain http is not a secure
 * origin, and an insecure origin has no `mediaDevices` — serve the phone listener with
 * `phone.tls` (a `tailscale cert` pair) to give it one. */
export const canRecord = (): boolean => !!navigator.mediaDevices?.getUserMedia;

/**
 * Hold to record, release to get text back. The phone's half of push-to-talk: no keyboard, so
 * the gesture is the button itself, and the touch that starts it is also what unlocks audio
 * playback on iOS.
 *
 * Transcription only — what comes back goes in the composer for the user to read and send.
 * Dictated words are the user's, and they reach the session the same way typed ones do.
 */
export function holdToTalk(onState: (state: "idle" | "arming" | "recording" | "working") => void) {
  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  let held = false;
  /** A getUserMedia still in flight. A press while it is pending rides on it rather than
   * opening a second microphone that nothing would ever stop. */
  let opening = false;
  const chunks: Blob[] = [];

  const cleanup = () => {
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = undefined;
    recorder = undefined;
  };

  return {
    /** Rejects when the microphone will not open, so the caller can say why. */
    async start(): Promise<void> {
      if (recorder || !canRecord()) return;
      held = true;
      onState("arming");
      if (opening) return;
      opening = true;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
        opening = false;
        if (!held) return cleanup();
        const rec = new MediaRecorder(stream);
        chunks.length = 0;
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        recorder = rec;
        rec.start();
        onState("recording");
      } catch (e) {
        opening = false;
        cleanup();
        onState("idle");
        if (held) throw e;
      }
    },
    /** The clip, as text. Empty when nothing was said or the hold never really started. */
    async stop(sessionId?: string): Promise<string> {
      held = false;
      const rec = recorder;
      if (!rec) {
        cleanup();
        onState("idle");
        return "";
      }
      const type = rec.mimeType;
      const done = new Promise<void>((r) => {
        rec.onstop = () => r();
      });
      if (rec.state !== "inactive") rec.stop();
      await done;
      cleanup();
      onState("working");
      // Closed as soon as the clip is decoded: on iOS a live AudioContext keeps the audio session
      // in playback, and the next getUserMedia waits on it with the button saying "opening mic".
      const ctx = new AudioContext();
      try {
        const wav = await toWav16k(await new Blob(chunks, { type }).arrayBuffer(), ctx).finally(() => void ctx.close().catch(() => {}));
        const url = sessionId ? `/api/voice/transcribe?session=${encodeURIComponent(sessionId)}` : "/api/voice/transcribe";
        const res = await fetch(url, { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
        const body = (await res.json()) as { text?: string; error?: string };
        if (!res.ok) throw new Error(body.error ?? "transcribe failed");
        return body.text?.trim() ?? "";
      } finally {
        onState("idle");
      }
    },
  };
}
