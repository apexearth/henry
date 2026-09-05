// Talking to a session instead of typing at it.
//
// Two kinds of dictation reach the input bar and both matter. The phone keyboard's own
// microphone works in the composer with no code at all, because the composer is an ordinary
// textarea — that is the one that always works, including on the phones where the Web Speech
// API is missing. The mic button here is the other kind: hands-free, continuous, with the
// words appearing as they are recognised, which is what you want when the phone is on the desk
// and you are looking at the terminal rather than the keyboard.
//
// Recognition runs in the browser's own service; nothing about it goes through Henry.

interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechAlternative;
}
interface SpeechResultList {
  readonly length: number;
  [index: number]: SpeechResult;
}
interface SpeechEvent {
  resultIndex: number;
  results: SpeechResultList;
}
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const dictationSupported = (): boolean => !!ctor();

export interface Dictation {
  stop(): void;
}

/**
 * Start listening. `onText` gets the whole utterance so far on every update — final phrases
 * plus whatever is still being guessed — so the caller can just replace the composer's text
 * with it. `onEnd` fires when recognition stops, whether the caller asked or the browser gave
 * up (a pause, a permission refusal, a page that lost focus).
 */
export function listen(onText: (text: string, final: boolean) => void, onEnd: (error?: string) => void): Dictation | undefined {
  const Ctor = ctor();
  if (!Ctor) return undefined;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || "en-US";
  let settled = "";
  let stopped = false;
  let error: string | undefined;
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i]!;
      const text = result[0]?.transcript ?? "";
      if (result.isFinal) settled += (settled && !/\s$/.test(settled) ? " " : "") + text.trim();
      else interim += text;
    }
    const whole = (settled + (interim ? (settled ? " " : "") + interim.trim() : "")).trim();
    onText(whole, !interim);
  };
  rec.onerror = (e) => {
    // "no-speech" and "aborted" are how a quiet pause and our own stop() report themselves.
    if (e.error && e.error !== "no-speech" && e.error !== "aborted") error = e.error;
  };
  rec.onend = () => {
    if (stopped) return;
    stopped = true;
    onEnd(error);
  };
  try {
    rec.start();
  } catch {
    return undefined;
  }
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        rec.stop();
      } catch {}
      onEnd(error);
    },
  };
}
