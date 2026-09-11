// Pi: the extension harness.
//
// Why an extension and not a client + spawned Pi process. Henry hosts the PTY (sessiond) and
// Henry has an API to the emulator. A client that launches Pi can also call Henry's API, but two
// state copies drift (activity, frames, event ordering). So Henry ships a *small extension* that
// lives inside Pi's own process and emits the four streams Henry already consumes for Claude:
// lifecycle events, terminal frames, hook-style payloads, and its own prompt/response channel.
// Pi persists its session as a JSONL file Henry can also read, giving a re-parse backstop when
// the live extension cannot keep up.
//
// Files:
//   index.ts          bootstrap: decide which extension owns this daemon's port; load the
//                     extension and pin the session; forward the extension's events/frames to
//                     ingest.
//   payloads.ts       how a turn maps to Henry: turn_start/turn_end + before/after_tool_call,
//                     prompt submit, session start/settle/stop — with every field the event
//                     switch needs (id, thread, tool_name, tool_input, stop_hook_active...).
//   ingest.ts         the event model. Reads extension events (preferred) and, as a backstop,
//                     the session JSONL via SessionManager. Writes HenryEvents through hooks,
//                     runs rules.classify, nextActivity, the overseer, git.noteSessionPath and
//                     the transcript tailer. Never throws.
//   terminal.ts       frames the PTY output so a window can render it, exposes scrollback.
//   hooks.ts          a shared, harness-agnostic switch: `event -> severity`. Meaning lives in the
//                     one-shot here; both the extension emitter and the file importer agree on the
//                     payload shape.
