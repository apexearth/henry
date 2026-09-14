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
  const chunks: Blob[] = [];

  const cleanup = () => {
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = undefined;
    recorder = undefined;
  };

  return {
    async start(): Promise<void> {
      if (recorder || !canRecord()) return;
      held = true;
      onState("arming");
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
        if (!held) return cleanup();
        const rec = new MediaRecorder(stream);
        chunks.length = 0;
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        recorder = rec;
        rec.start();
        onState("recording");
      } catch {
        cleanup();
        onState("idle");
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
      try {
        const wav = await toWav16k(await new Blob(chunks, { type }).arrayBuffer(), new AudioContext());
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
