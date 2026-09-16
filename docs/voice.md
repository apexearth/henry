# Talking to Henry

The first slice of "Henry as an interlocutor" (PLAN.md), done by voice: hold a key in the Voice
panel, ask a question, hear an answer. `daemon/src/voice.ts` owns the round trip; the panel
records and plays.

- **Push-to-talk, not a wake word.** The key release ends the utterance, so there is no voice
  activity detection to tune, and the microphone is live only while a key is down. A tool that
  already watches every repo you touch does not get a permanently open mic by default.
- **Its own system prompt, not the overseer's.** The overseer writes to be *read*: backticks
  around every name, `HEADLINE:`/`CHANGED:` labels, bullets. All of that is unspeakable. Voice
  shares the overseer's per-session description (`sessionDetail`: summary, latest entries,
  flags, repos), its global history and its backend (`askBackend`), and brings its own output
  contract: a few sentences, no markup, no file paths spoken aloud, answer first. One picture
  of the world, two ways of saying it.
- **Voice sees every machine, and each machine describes itself.** A link mirrors a peer's
  sessions, repos, flags and playbook, but not its events or transcripts, so until 2026-09-15
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
- **Silence never reaches whisper.** Given nothing to hear, whisper does not say so: it invents
  a sentence, and with a bias prompt it invents one out of the prompt, so a key held and released
  without a word came back as a string of session names. `transcribe` gates on the clip's own
  energy first (`hasSpeech`: 120 ms of frames above -40 dBFS RMS) and returns nothing when the
  gate fails, which the panel and the phone already show as "nothing heard". The browser's noise
  suppression puts a silent room well under the line; a quiet word still clears it.
- **The UI resamples, so the daemon needs no ffmpeg.** MediaRecorder gives webm/opus and
  whisper.cpp wants 16 kHz mono PCM; the browser already has an AudioContext, so the conversion
  happens there rather than adding a media dependency on two platforms.
- **Speech is the nice-to-have.** A failed voice still answers in the panel. The platform voice
  (`say`, SAPI) is the zero-install default; `voice.tts` points at any command that reads text
  on stdin and writes a WAV on stdout, which is how a better local model gets wired in. One
  process per answer, on purpose: nothing resident, nothing to babysit. `scripts/kokoro-tts.py`
  is that command for Kokoro; measured 2026-09-14 on a Ryzen 5800X3D, the process costs about
  two seconds before it renders a word (interpreter, then a 326 MB model), which is the price
  of the no-daemon rule and the reason Piper is documented beside it.
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
- **Voice sees the conversation; the overseer still does not.** Decided 2026-09-14, deliberately
  and not by accident: the tail of the live session's actual transcript rides in the voice
  context, word for word, because "what did it just tell me" and "read me the end of that
  answer" are the questions a voice is for, and an event summary cannot answer either — a
  summary of a turn is not the turn. That text carries code, paths and diffs, so voice is no
  longer blindfolded and its prompt says so, with the standing instruction to *describe* code
  rather than read symbols and paths aloud, which is useless in speech. The overseer's own
  blindfold is untouched: it writes a durable log for later, where the temptation to guess at
  implementation detail is the thing that rule protects against. Only the session at the top of
  the activity order, across every machine, gets a tail — it is the most expensive thing in the
  context by an order of magnitude, and "the last response" almost always means the one in
  front of you.
- **Off by default** (`voice.enabled`), like the overseer: it costs an LLM call per question.

- **A phone records too, and that is what `phone.tls` is for.** A browser gives no microphone to
  an insecure origin — `navigator.mediaDevices` is not merely blocked, it is undefined — so the
  phone listener serving plain HTTP made voice on a phone unwritable rather than unwired. On a
  tailnet the certificate is free and real: `tailscale cert <machine>.<tailnet>.ts.net`, the two
  files in `phone.tls`, and Bun.serve does the rest. The QR then carries the certificate's name
  rather than an address, because an address is exactly the mismatch a certificate objects to.
  Without it the listener still comes up, says so on the console, and reports `secure: false` so
  the panel can explain the missing microphone instead of failing at a bare TypeError.
- **On a phone the gesture is the button.** There is no modifier to hold, so the composer's mic
  is press-and-hold, and the press doubles as the gesture iOS requires before audio will play.
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
