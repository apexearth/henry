# Sessions and the terminal host

Where a session lives, how a window sees it, and what Henry spawns it with.

- **Daemon owns the sessions, windows are clients.** PTYs live server-side (like
  tmux). Closing a window never kills a session. Several windows can attach to the
  same daemon and see the same tabs.
- **PTYs live in `henry-sessiond`, not in the daemon.** A separate, long-lived Node
  process (`packages/sessiond`, node-pty its only dependency, no imports from the rest
  of the repo) owns the terminals and a 2 MB scrollback per session. The daemon finds it
  through `~/.henry/sessiond.json` (loopback TCP port + random token, NDJSON, one
  sessiond per `HENRY_HOME`), starts one when none answers, and reconnects after every
  restart. Kept boring on purpose: it changes twice a year; a protocol version in the
  hello lets the daemon warn, and `henry sessiond restart` drains it (exit once no
  session runs) or `--now` hangs everything up. Stopping the daemon never stops it.
- **A window attaching gets the screen, not the bytes that made it.** The ring is raw PTY
  output, and replaying it into a fresh xterm is only right for a program that printed
  lines. A full-screen app repaints with absolute cursor addressing at whatever geometry
  the PTY had then, so every stale frame lands again in the wrong rows at the window's
  current size, and the ring's 2 MB cut falls mid escape sequence: scrolling back through
  a Claude session found interleaved old frames. The daemon therefore keeps a headless
  xterm per session (`daemon/src/screen.ts`, `@xterm/headless` + the serialize addon),
  feeds it the same stream windows get, and answers `attach` with a serialised buffer —
  cells, cursor, scrollback and modes, plus the mouse encoding the serializer omits and
  the bytes still in its parser. Frames collapse into state, so this is far more real
  history than 2 MB of repaints ever held. It lives in the daemon because sessiond takes
  no dependencies; a daemon restart re-seeds each emulator from the ring, which costs one
  imperfect reconstruction and is exact from the next byte on. `pty:scrollback` did not
  change shape, so windows and peers need to know none of this.

- **3–4 top-level sessions** is the design point. Subagents show under their parent.

- **Henry-launched sessions carry their own hooks.** Every `claude` Henry spawns gets
  `--session-id <henry id>` (so Claude's session id equals Henry's, no binding
  round-trip) and `--settings ~/.henry/launch-settings.json`, which layers Henry's
  hooks and statusline over the user's settings for that process only. `henry install`
  is only needed for sessions started elsewhere (a terminal, Zed).
- **Nothing Henry spawns inherits `CLAUDE_CODE_*` / `CLAUDECODE` env**: not sessiond,
  not the sessions it starts on the daemon's behalf (`sessions.ts` strips the
  environment for both). A daemon started from inside a Claude Code session would
  otherwise pass the child-session marker through, which turns transcript saving off
  and breaks transcript-based plugin hooks (verified 2026-09-02: claude-mem's Stop hook
  looped on it).

- **New tab is a typed picker.** One text box filters rows; ↑↓ picks, Enter opens. Rows
  are every repo under `~/code/*` (and worktrees, and plain folders holding no repo, marked
  "folder") as a Claude session, then the same rows
  and `~` as a plain terminal; a typed path offers both. `defaultRepo` sorts first.
- **Plain terminals are sessions too.** `kind: "shell"` runs `$SHELL -l` in the same PTY
  host with the same rail entry. The rail shows Clawd (orange, solid while running,
  outline once exited) for Claude Code and `>_` (green, dim once exited) for a terminal,
  decided by the session, not the user: a shell whose PATH-shimmed `claude`
  (`~/.henry/bin/claude`, which adds the launch settings) posts hooks flips to Clawd for as
  long as that Claude runs (`claudeActive`, set on the first hook with `HENRY_SESSION`,
  cleared on SessionEnd), and its `claudeSessionId` stays for ↻ resume.

- **Shift+Enter is a newline in Claude Code.** The terminal sends ESC CR (what
  `/terminal-setup` binds) when the session is running Claude; a plain shell gets Enter.
- **Sessions outlive the daemon, terminal included.** After a daemon restart the
  sessions sessiond still holds are running in the rail with their scrollback; only
  sessions from before the last sessiond (last 24h) come back as exited with their
  repos, flags and playbook and no output. An exited Claude session has a ↻ button that
  opens a new tab with `claude --resume <id>`. Every session carries `host` (config
  `host`, default short hostname), groundwork for daemons on several machines.
