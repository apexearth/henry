# Talking to Henry

The first slice of "Henry as an interlocutor" (PLAN.md), done by voice: hold a key, ask a question,
hear an answer. `daemon/src/voice.ts` owns the round trip; `ui/VoiceStrip.tsx`, in the status
strip, records and plays.

- **Push-to-talk, or a tap that latches dictation on; never a wake word.** A held key ends the
  utterance on release. A tap of the dictation key (under 300 ms), or the strip's "dictate"
  button, keeps the microphone open until the next tap: a worklet hands raw audio to a
  segmenter that cuts a clip at each pause (700 ms, shorter once a clip passes 15 s, and a hard
  cut at 25 s), and each clip is transcribed and typed into the session in view at the moment
  of the pause, in order, unsent, without moving focus. Raw samples rather than MediaRecorder,
  because restarting a recorder to cut a clip loses the audio in between. The mic is open only
  because you turned it on, shown in the warn colour the whole time, and it turns itself off
  after ten minutes without a word. Turning it off by hand (the button or the key) gives the
  keyboard to the session in view, so Enter sends; the ten-minute timeout moves nothing.
- **Clips join into sentences.** Whisper hears each clip as a whole utterance, so a clip cut at a
  breath ends in "..." or a full stop and the next starts with a capital. The last 200
  characters a run typed end the next clip's whisper prompt, without their final full stop
  (taken out of the vocabulary's room, since whisper cuts an overlong prompt from the front):
  given an unfinished sentence, whisper itself starts a continuation in lower case and a new
  sentence with a capital. Every "..." is dropped and the word after it lowercased, except "I"
  and vocabulary names (`smoothDictation`). A clip's final full stop is held back until the next
  clip: a lower-case start drops it, anything else types it first, and stopping types it.
- **A clip is never lost to a busy machine.** Bun closes a connection after 10 s without a byte,
  pending handler or not, so voice routes lift that limit and whisper gets two minutes. The
  window retries a failed transcription three times over about twelve seconds (a daemon
  restarting, whisper timing out); a dictated clip that still fails is kept in memory and the
  strip shows "retry" until it lands or the page reloads.
- **Its own system prompt, and the shared backend.** Voice takes the per-session description
  (`sessionDetail`: flags, repos), your notes (notes.md) and the backend (`askBackend`) from
  `overseer.ts`, and brings its own output contract: a few sentences, no markup, no file paths
  spoken aloud, answer first.
- **Voice sees every machine, and each machine describes itself.** A link mirrors a peer's
  sessions, repos and flags, but not its events or transcripts, so until 2026-09-15
  voice could name a paired machine's sessions in the roster and say nothing about them. Now
  every daemon answers `GET /api/voice/context` with a slice of its own picture — its most
  recently active sessions with their detail and last events, the conversation tail of its top
  one, and the repos a session could open in — built by the same `contextSlice` that serves a
  question asked locally. `answer` asks each connected peer for its slice over the link (4 s,
  then the roster alone stands for that machine), merges the slices by last event time, and the
  detail cap and the single tail apply across machines rather than per machine: the most recent
  session gets the tail whichever machine it is on. The endpoint is not gated on `voice.enabled`,
  because the machine answering is not the one speaking. GO and TELL match against every
  running session everywhere, not the detailed few, since the roster names them all.
- **"Open a session in X" is the third directive.** `OPEN: <repo>` (with ` on <machine>` for a
  paired one) names a repo from the openable list in the context; the lines under it are the
  session's first prompt, in the user's voice. The daemon resolves the repo (`resolveOpen`:
  this machine's copy wins a bare name, a trailing "on" is honoured only when it names a peer)
  and answers with an `open` action; the window creates the session and, once its first hook
  flips `claudeActive`, types the prompt — **unsent**, through `relaySafe` like a relay,
  because it is one. The wait matters: typed before Claude's input exists the words go to
  whatever reads the terminal first. It has an end (20 s) so hooks that never reach Henry do
  not hold the words forever, and it cannot see a workspace-trust dialog: a repo Claude has never
  been trusted in gets its prompt typed at the dialog, where letters do nothing and the text is
  lost. That is the fallback's cost, accepted because the repos you open by voice are the ones
  you already work in.
- **The transcript is treated as lossy.** The prompt tells the model its input is speech-to-text
  and to match near-misses against the session and repo names in the context rather than repeat
  a garbled name back. Henry also feeds those names to whisper as its initial prompt, and
  fuzzy-matches whatever still comes back wrong (`matchSession`: "dune versus squid" finds
  "dune vs squid"). Measured 2026-09-14: the bias prompt helps sometimes and not always; the
  fuzzy match is what makes it reliable.
- **The conversation primes the ear.** A word whisper mishears is usually one already on the
  screen, so the names in the session's last 30 turns of prose (and in what Henry said back in
  the spoken thread) go into the bias list, right after yours: backticked identifiers, camelCase
  and snake_case, letters run into digits, capitals mid-sentence on words never written in
  lower case, and three or more words hyphenated ("speech-to-text") said at least twice. Ordinary English, hashes, paths and the user's side of the thread (whisper's own
  output, mishearings included) stay out, and 24 at most go in. A question to Henry is primed by
  the session in view as well as dictation is.
- **Known words are spelled back as written, but not ordinary words.** The bias list is your
  `voice.vocabulary`, the names from the conversation, the open sessions, repos and branches,
  and the basenames of the files the session touched; a transcribed run of up to three words whose letters match one is rewritten
  to that spelling ("sub-squid" → subsquid). A name in capitals (TODO.md, ISSUES.md) is left
  out of the list unless it is yours, and a word that differs from a known one only in case
  keeps whisper's casing, so "to-do" and "issues" stay words instead of coming back as TODO
  and ISSUES. Your own vocabulary overrides both.
- **Silence never reaches whisper.** Given nothing to hear, whisper does not say so: it invents
  a sentence, and with a bias prompt it invents one out of the prompt, so a key held and released
  without a word came back as a string of session names. `transcribe` gates on the clip's own
  energy first (`hasSpeech`: 120 ms of frames above -40 dBFS RMS) and returns nothing when the
  gate fails, which the strip and the phone already show as "nothing heard". The browser's noise
  suppression puts a silent room well under the line; a quiet word still clears it.
- **Noise is not words either.** A fan or a room clears that gate, and whisper, trained on
  subtitled video, decodes it as the line a video ends on: "Thanks for watching", "Please
  subscribe", "(dramatic music)". With `voice.vadModel` set, whisper's own Silero VAD hands it
  only the stretches with speech, and a clip of noise alone comes back empty (checked on
  2026-11-22 against brown noise with a hum). Without it, and behind it, `withoutStockPhrases`
  drops those sign-off sentences and sound captions wherever they appear, and a clip that is
  only "you".
- **The UI resamples, so the daemon needs no ffmpeg.** MediaRecorder gives webm/opus and
  whisper.cpp wants 16 kHz mono PCM; the browser already has an AudioContext, so the conversion
  happens there rather than adding a media dependency on two platforms.
- **Nothing in the strip waits forever.** The shell has no reload key, so a hung promise used to
  hold voice until the app restarted. Opening the microphone gives up after 15 s (and closes a
  device that opens late), a context that will not resume in 2 s is rebuilt once and then
  reported, the worklet gets 5 s to load, and playback ends at the clip's length if `ended`
  never fires. A warm stream whose track went muted is reopened rather than reused. Continuous
  dictation with no audio blocks for 3 s stops and rebuilds the context. Behind all of it, a
  phase that outlives its limit (25 s opening the mic, 15 s past the hold cap recording)
  resets the strip and says which phase it was stuck in.
- **The strip's AudioContext does not outlive the speakers.** One context serves the waveform,
  the mic and playback, but a context binds its output device when it is made and Chrome can
  keep rendering to one that has since been unplugged — a dock's speakers — so an answer played
  into nothing. Any `devicechange` throws the context away (once it is idle) and the next hold
  or answer makes a new one on the current default output.
- **Voice lives in the status strip and keeps no log.** It is driven from the keyboard, so it
  takes no dock pane: the middle of the strip holds "voice" (hold it to ask), "dictate" and the
  vocabulary list, with the key hints in the tooltip, and a small waveform of its own beside
  "voice", animated only while the mic is recording or Henry is speaking. Dictated words are already in
  the session's prompt and an answer is spoken, so a transcript of both would be a second copy.
  The strip shows only an error, or an answer that came back without audio, cut to one line;
  hover for all of it, click to dismiss.
- **Speech is the nice-to-have.** A failed voice still answers in the strip. The platform voice
  (`say`, SAPI) is the zero-install default; `voice.tts` points at any command that reads text
  on stdin and writes a WAV on stdout, which is how a better local model gets wired in. One
  process per answer, on purpose: nothing resident, nothing to babysit. `scripts/kokoro-tts.py`
  is that command for Kokoro; measured 2026-09-14 on a Ryzen 5800X3D, the process costs about
  two seconds before it renders a word (interpreter, then a 326 MB model), which is the price
  of the no-daemon rule and the reason Piper is documented beside it. With an NVIDIA card,
  `scripts/kokoro-tts-cuda.py` renders on the GPU, which shortens long answers and leaves that
  startup as it is. It cannot use the stock model, whose per-phoneme Loop is slower on CUDA than
  the whole model on a CPU, so `--prepare` converts the onnx-community export once, rewriting its
  STFT (which onnxruntime runs only on the CPU) as a Conv. DirectML is not an option: it fails
  on Kokoro's ConvTranspose.
- **Henry may type into a session; only you may send.** Dictation (hold right ⌥) and a relayed
  message ("tell the indexer session to stop the backfill", which the model answers with a
  `TELL:` directive) both put text in a session's prompt and stop there. Nothing is submitted:
  the Enter is yours. This is not the cross-session write ruled out in PLAN.md — the words originate
  with the user and reach the agent only when a person presses a key — but it is the closest
  Henry comes to that line, and it holds precisely because the keystroke is never automated.
  **That is enforced, not trusted** (`relaySafe`): `pty:input` is a raw write, so one CR or LF
  in a relayed message *is* the Enter. Newlines become spaces, every C0 control is dropped
  (escape sequences with them) and the message is capped. The enforcement matters because voice
  now reads the live transcript, and a transcript carries tool results — file contents, command
  output, fetched pages — so anything Henry can read can try to say "TELL:". Sanitised and
  unsent, the worst case is a strange sentence sitting in your prompt where you can see it.
- **Voice sees the conversation; summaries elsewhere still do not.** Decided 2026-09-14, deliberately
  and not by accident: the tail of the live session's actual transcript rides in the voice
  context, word for word, because "what did it just tell me" and "read me the end of that
  answer" are the questions a voice is for, and an event summary cannot answer either — a
  summary of a turn is not the turn. That text carries code, paths and diffs, so voice is no
  longer blindfolded and its prompt says so, with the standing instruction to *describe* code
  rather than read symbols and paths aloud, which is useless in speech. Coordinators and notes
  filling keep the blindfold: what they write lasts, where the temptation to guess at
  implementation detail is the thing that rule protects against. Only the session at the top of
  the activity order, across every machine, gets a tail — it is the most expensive thing in the
  context by an order of magnitude, and "the last response" almost always means the one in
  front of you.
- **It is a conversation, and Henry remembers his side of it.** Both backends are single-turn
  (`claude -p`, one API message), so the thread rides in the context text: the last ten
  exchanges, each side flattened to a line, pasted just above the new utterance and named for
  what it is, with the prompt told to read "why", "and the other one" and a thought being
  bounced around against it. What is recorded is what was *spoken* — the confirmation for a
  relay, not the `TELL:` the model wrote — because that is what the user heard and will refer
  to. It lives in memory on the daemon that answered, and thirty minutes of silence empties it:
  a conversation that outlives a restart or a lunch break is a stale answer waiting to be given.
  Dictation never lands in it; that is the user talking to a session, not to Henry. The rest of
  the context is fetched fresh for every question, and the prompt says which wins when the two
  disagree.
- **Off by default** (`voice.enabled`): it costs an LLM call per question.
- **Henry says what finished, unprompted, when asked to** (`voice.announce`, a tick under
  Settings → notifications; `daemon/announce.ts`). Each local notice except a reminder waits
  1.5 s for the transcript to land, hands the same conversation tail to a small model
  (`voice.announceModel`, Haiku by default, on the shared backend) with why it stopped,
  and gets one sentence back: what it needs from you, or the result. The notice goes out again
  with that line and its audio; windows with the sound on speak it once, one line at a time,
  under the chime's quiet rule, and the OS notification swaps its text for the line. A newer
  notice for the same session cancels a line still being written. It needs the speaker and the
  backend, not `voice.enabled` or whisper. Peers relay the line like any notice.

- **A phone records too, and that is what `phone.tls` is for.** A browser gives no microphone to
  an insecure origin — `navigator.mediaDevices` is not merely blocked, it is undefined — so the
  phone listener serving plain HTTP made voice on a phone unwritable rather than unwired. On a
  tailnet the certificate is free and real: `tailscale cert <machine>.<tailnet>.ts.net`, the two
  files in `phone.tls`, and Bun.serve does the rest. The QR then carries the certificate's name
  rather than an address, because an address is exactly the mismatch a certificate objects to.
  Without it the listener still comes up, says so on the console, and reports `secure: false` so
  the panel can explain the missing microphone instead of failing at a bare TypeError.
- **On a phone the gesture is the button.** There is no modifier to hold, so the composer's mic
  is tapped or held, and the press doubles as the gesture iOS requires before audio will play.
  It transcribes into the composer, never into the session: the same rule the desktop holds to,
  for the same reason. Henry's ear is preferred over the browser's recogniser when the daemon
  has whisper, because only Henry's knows what your sessions, repos and files are called; the
  Web Speech button stays as the fallback when it does not.
- **Talking is a mode, not a button.** A mic wedged between the text box and send is a thumb-sized
  target you have to hold, and a long press on a small button is how a phone decides you meant to
  select its label. So the composer has two modes and one toggle swaps the whole bottom of the
  screen: keys and a text box for typing, or a slab across the width you hold, with the words it
  heard above it. The mode is remembered, because a phone used by voice is used that way twice.
  The heard line is still a draft — tap it to fix a word, send when it says what you meant.
- **Talk mode keeps the screen on, and a lock costs one take, not the app.** A phone that dims
  and locks between sentences ends the recording, so talk mode holds a screen wake lock (asked
  for again whenever the page comes back; typing mode never holds one). After a lock iOS can
  hand back a microphone that is dead without saying so (an audio context that never runs, a
  track muted or ended), and a transcription request left open across the lock that nothing
  will answer, which held every later clip behind it. So a live mic that sends no audio, or
  stays muted, for three seconds lets go of everything and says to tap again, and a request
  open while the page was hidden is cut on return and retried.
