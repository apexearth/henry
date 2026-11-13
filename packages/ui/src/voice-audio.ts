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

/**
 * A browser audio call that has not answered by `ms` is taken as never going to. Chromium's
 * getUserMedia, AudioContext.resume and worklet loading can each hang for good after an audio
 * device comes or goes, and an await on one of them left voice stuck until the app restarted.
 */
export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

/** How long the microphone gets to open: long enough to answer a permission prompt. */
export const MIC_OPEN_MS = 15_000;

/** The capture device, given up on after MIC_OPEN_MS. One that opens after that is closed again
 * as it arrives, so a late answer does not leave the microphone live with nobody holding it. */
export async function openMic(): Promise<MediaStream> {
  const opening = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  try {
    return await within(opening, MIC_OPEN_MS, "the microphone");
  } catch (e) {
    void opening.then(
      (s) => s.getTracks().forEach((t) => t.stop()),
      () => {},
    );
    throw e;
  }
}

/** A node that calls `onBlock` with every block of what is connected to it. */
export async function tapNode(ctx: AudioContext, onBlock: (block: Float32Array) => void): Promise<AudioWorkletNode> {
  if (!tapLoaded.has(ctx)) {
    const url = URL.createObjectURL(new Blob([TAP_SOURCE], { type: "application/javascript" }));
    try {
      await within(ctx.audioWorklet.addModule(url), 5_000, "the audio worklet");
    } finally {
      URL.revokeObjectURL(url);
    }
    tapLoaded.add(ctx);
  }
  // One silent output, routed through a muted gain to the speakers: Safari renders only what
  // leads to the destination, and a node with no way there never sees a sample.
  const node = new AudioWorkletNode(ctx, "henry-tap", { numberOfInputs: 1, numberOfOutputs: 1 });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
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

/**
 * Whisper ends every clip with a full stop, whether the sentence ended or the segmenter cut at a
 * breath. So the stop is held back and the next clip settles it: one starting in lower case
 * carries the sentence on, and the stop was only the cut.
 */
export function splitStop(text: string): { body: string; stop: string } {
  return /[^.]\.$/.test(text) ? { body: text.slice(0, -1), stop: "." } : { body: text, stop: "" };
}
export const carriesOn = (text: string): boolean => /^[a-z]/.test(text);

/** Waits before each retry of a transcription. A daemon restarting under `bun run dev` is back
 * within a few seconds; a whisper that failed because the machine was busy may need longer. */
const RETRY_WAITS_MS = [1_000, 3_000, 8_000];

/**
 * A clip through the daemon's whisper, retried while the failure is one that passes: the daemon
 * restarting, a dropped connection, whisper failing or timing out. Not retried when voice is off
 * or the clip itself was refused. `session` biases toward that session's vocabulary; `after` is
 * what the same dictation typed just before, so the clip continues it.
 */
export async function transcribeWav(wav: ArrayBuffer, session?: string, after?: string): Promise<string> {
  const query = new URLSearchParams();
  if (session) query.set("session", session);
  if (after?.trim()) query.set("after", after.slice(-200));
  const qs = query.toString();
  const url = `/api/voice/transcribe${qs ? `?${qs}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    let error: Error;
    let passing = true;
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
      const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (res.ok) return body.text?.trim() ?? "";
      error = new Error(body.error ?? `transcribe failed (${res.status})`);
      passing = res.status >= 500 && res.status !== 503;
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    const wait = RETRY_WAITS_MS[attempt];
    if (!passing || wait === undefined) throw error;
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** Whether this page can record at all. A phone reaching Henry over plain http is not a secure
 * origin, and an insecure origin has no `mediaDevices` — serve the phone listener with
 * `phone.tls` (a `tailscale cert` pair) to give it one. */
export const canRecord = (): boolean => !!navigator.mediaDevices?.getUserMedia;


/**
 * The phone's microphone, held or latched by a tap. Raw audio cut at each pause, like the
 * strip's continuous dictation, so the words arrive while you talk and a long thought is a run
 * of short clips: a busy machine that fails one costs one phrase, not everything you said. The
 * press that starts it is also the gesture iOS wants before audio will run.
 *
 * Each clip comes out as a 16 kHz WAV, in order; transcribing it is the caller's, so the words
 * go in the composer for the user to read and send, the way typed ones do.
 */
export function liveMic(onState: (state: "idle" | "arming" | "recording") => void, onClip: (wav: ArrayBuffer) => void) {
  let run: { ctx: AudioContext; stream: MediaStream; src: MediaStreamAudioSourceNode; node: AudioWorkletNode; seg: Segmenter } | undefined;
  /** False once the press that opened the mic has let go, so an open that lands late shuts. */
  let wanted = false;
  let opening = false;
  let order = Promise.resolve();

  const stop = () => {
    wanted = false;
    const r = run;
    run = undefined;
    if (!r) return;
    r.seg.flush();
    r.node.port.onmessage = null;
    r.src.disconnect();
    r.node.disconnect();
    for (const t of r.stream.getTracks()) t.stop();
    // On iOS a live AudioContext holds the audio session in playback, and the next getUserMedia
    // waits on it with the button saying "opening mic".
    void r.ctx.close().catch(() => {});
    onState("idle");
  };

  return {
    /** Rejects when the microphone will not open, so the caller can say why. */
    async start(): Promise<void> {
      if (run || !canRecord()) return;
      wanted = true;
      onState("arming");
      if (opening) return;
      opening = true;
      // Made before any await, while the press is still a user gesture: iOS starts audio from one.
      const ctx = new AudioContext();
      void ctx.resume().catch(() => {});
      let stream: MediaStream | undefined;
      try {
        stream = await openMic();
        const src = ctx.createMediaStreamSource(stream);
        const rate = ctx.sampleRate;
        const seg = new Segmenter(rate, (clip) => {
          order = order.then(() => pcmToWav16k(clip, rate).then(onClip)).catch(() => {});
        });
        const node = await tapNode(ctx, (block) => seg.push(block));
        src.connect(node);
        opening = false;
        run = { ctx, stream, src, node, seg };
        if (!wanted) return stop();
        onState("recording");
      } catch (e) {
        opening = false;
        for (const t of stream?.getTracks() ?? []) t.stop();
        void ctx.close().catch(() => {});
        onState("idle");
        if (wanted) throw e;
      }
    },
    /** Stop listening. What was said since the last pause still comes out as a clip. */
    stop,
  };
}
