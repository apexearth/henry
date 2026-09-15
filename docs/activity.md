# Activity and engagement

What Claude is doing in a session, and whether you have been showing up to it.

- **Activity is derived, never polled.** Every Claude session carries `activity`:
  `working` (a turn is running), `needsInput` (blocked on a permission prompt), `waiting`
  (the turn ended, the next move is mine) or `idle` (waiting >10 min, or silent >15 min
  mid-turn). It falls out of the hook stream Henry already ingests — `UserPromptSubmit` /
  `Pre|PostToolUse` mean working, a plain `Stop` means waiting, a `Notification` says which
  kind — so it costs one switch per event plus a 10 s tick, with the statusline POST as the
  heartbeat that keeps a long tool call from ageing out. `SubagentStop` and `PreCompact` are
  heartbeats only: Claude Code fires SubagentStop for background agents that finish minutes
  after the turn ended (its "away summary"), and reading that as working pinned finished
  sessions to orange. A permission prompt blocks on the tool call that opened it, not on
  the next `PostToolUse`: Claude issues several calls per message and Claude Code prompts for
  them one at a time, so the first approval must not read as working while the second prompt
  is up. Calls are tracked by `tool_use_id` from `PreToolUse` to `PostToolUse`.
  `PermissionRequest` fires the moment a prompt opens, once per prompt, without a
  `tool_use_id`, so the call is matched by tool name and input; the `permission_prompt`
  `Notification` fires once per batch after ~6 s of silence, so it blocks on every call in
  flight from the thread (main or subagent) that made the latest call. A denied call, mine or
  the auto-mode classifier's, fires no hook: the transcript tailer prunes it from its
  `tool_result`, and a thread's next `PreToolUse` releases what it was blocked on. It is not
  persisted: a restarted daemon replays each running session's last hook events in order,
  because a session waiting for me sends nothing until I type. The rail says it on Clawd: orange pulsing =
  working, amber = wants an answer, green = my move, dim = idle. The time beside it is
  time-in-state while working and time since I last typed otherwise (see the engagement bullet).
- **Engagement is my side of the same coin.** `activity` says what Claude is doing;
  `lastInputAt` and `prompts` (daemon/engagement.ts) say whether I have been showing up,
  which is what tells a session I parked from one I forgot. Prompts come from the
  `UserPromptSubmit` hook, so the last 4 h of them survive a restart via the event log;
  keystrokes relayed to the PTY move `lastInputAt` too (throttled to one update per 30 s,
  terminal replies filtered out, never persisted). The rail draws the prompts as a 16-bar
  sparkline across the whole row's background (15 min per bar, centred on the row's midline, faint ink under the text,
  current bar in the accent; flags there are a bare icon + count so they do not cover it)
  so a busy morning with a flat tail reads as "dropped", fades a row that is waiting on me the longer I leave it (5 min /
  15 min / 1 h steps; a working session never fades, it does not need me), and offers
  "by attention" grouping: sessions that asked for me by name first, then my move, longest
  since I typed at the top, then working, then terminals and closed rows. Looking at a session
  without typing is not engagement — answering an ask is the single exception.
