# Activity and engagement

What Claude is doing in a session, and whether you have been showing up to it.

- **Activity is derived, never polled.** Every Claude session carries `activity`:
  `working` (a turn is running), `needsInput` (blocked on a permission prompt or a question),
  `background` (the turn ended but work it started is still running), `waiting` (the turn
  ended, the next move is mine) or `idle` (waiting >10 min, or silent >15 min
  mid-turn). It falls out of the hook stream Henry already ingests — `UserPromptSubmit` /
  `Pre|PostToolUse` mean working, a plain `Stop` means waiting, a `Notification` says which
  kind, and an `AskUserQuestion` or `ExitPlanMode` call is a question from its `PreToolUse`
  until its `PostToolUse` — so it costs one switch per event plus a 10 s tick, with the statusline POST as the
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
  working, steady orange = background, amber = wants an answer, green = my move, dim = idle and its row has begun to fade
  (an idle session I was with this past hour is still green). The time beside it is
  time-in-state while working and time since I last typed otherwise (see the engagement bullet).
- **Background is a finished turn that is not my move yet.** Claude backgrounds a build, a test
  run or an agent, ends its turn, and Claude Code wakes it when that work ends. Both ends are in
  the transcript, not the hooks: the tool result carries `backgroundTaskId` (a backgrounded or
  moved-to-background command) or `status: "async_launched"` (an agent, a workflow), and a
  queued `<task-notification>` names the same `tool-use-id` with its final status. The tailer
  reads the transcript up to date before a `Stop` is read, so a task started just before the
  turn ended counts. A `Stop` with such work open is `background`; when the last of it ends,
  the wake-up turn has a minute to send a hook before the session is my move. Work that never
  reports back, a dev server above all, stops holding the session 20 minutes after it started.
  A subagent's own background work is not counted: it wakes the subagent, not the session.
  Background sits with working everywhere: it never fades, groups under "working", and counts
  in the top bar's working chip.
- **Engagement is my side of the same coin.** `activity` says what Claude is doing;
  `lastInputAt` and `prompts` (daemon/engagement.ts) say whether I have been showing up,
  which is what tells a session I parked from one I forgot. Prompts come from the
  `UserPromptSubmit` hook, so the last 4 h of them survive a restart via the event log;
  keystrokes relayed to the PTY move `lastInputAt` too (throttled to one update per 30 s,
  terminal replies filtered out, never persisted). The rail draws the prompts as a 16-bar
  sparkline across the whole row's background (15 min per bar, centred on the row's midline, faint ink under the text,
  current bar in the accent; flags there are a bare icon + count so they do not cover it)
  so a busy morning with a flat tail reads as "dropped", fades a row that is waiting on me the
  longer it has been since I was last with it, typing or looking (`lastSeenAt`, see the unseen
  bullet), in 1 h / 3 h / 8 h steps: the sessions I have been with this past hour are my working
  set, answered or not, and stay bright. A working session never fades, it does not need me, and
  nor does an unseen one, which is what I missed rather than what I parked. It offers
  "by attention" grouping: sessions that asked for me by name first, then not seen yet (longest
  waiting first), then my move, longest since I typed at the top, then working, then terminals
  and closed rows. Beyond the fade, looking at a session without typing is not engagement —
  answering an ask is the single exception.
- **Unseen is whether I have looked at what a session did.** A turn ending after real work (the
  notice's 10 s rule) sets `unseenSince` on the session; the first moment is kept until it clears.
  It clears when a window holds that session in view for 1.5 s while the window is visible,
  focused and touched lately (presence's "here"), or when I type or prompt into it. The window
  repeats the view about once a minute while I stay, which moves `lastSeenAt` to the minute.
  The daemon owning the session keeps both marks and persists them, so looking from the phone clears it on the
  desktop and a restart keeps it. The rail draws an unseen row bold with an accent dot; the
  window title and favicon carry the count; `⌘J` (Alt+J off macOS, where Ctrl+J is the
  terminal's newline) jumps to the longest-waiting unseen session other than the one in view.
  Right-clicking a running row marks it read or unread (marked unread while in view, it stays
  unread until I move off it) or sets a reminder: 15 min, 1 h, 3 h or tomorrow at 9:00. A
  reminder marks the session seen now and, when due, marks it unseen again and sends a notice;
  the row shows ⏰ meanwhile, with the time in its tooltip. An exited session drops both marks.
- **A notice is a session stopping and needing me, said outside the window.** `daemon/notify.ts`
  reads it off the activity transitions and asks the daemon already has, once, so every delivery
  says the same things: a permission prompt or a question opening, always; a turn ending after at least 10 s
  of work (a quicker turn was an answer, not work I walked away from), where a turn that waited on
  its background work and the turn that read the result are one stretch; an ask, in its own words;
  a reminder I set coming due.
  Reaching `waiting` any other way — startup, `/clear`, a resume, an approved prompt — says
  nothing, and nor does a daemon restart: the replayed activity is the baseline, not a
  transition. It goes out as a `notify` frame to every window, and peers relay it like a flag,
  tagged with the machine. The daemon shows nothing itself. **Delivery is the window's**
  (`ui/notify.ts`): an OS notification from the browser, off until ticked in Settings (the ⚙
  tab of the phone's ⋮ sheet), since asking for permission unbidden is how a site gets
  blocked, and per browser, since the permission is. A window that is focused on that session
  stays quiet, because you are looking; one notification per session, replaced rather than
  stacked; clicking it brings the window and the session forward. A phone gets them while a
  Henry tab is open, even in the background. iOS shows nothing from a page at all: true
  background delivery there is Web Push, which is in `PLAN.md`.
