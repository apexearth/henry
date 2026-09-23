# Henry's tools: what one session may know about another

Henry hosts 3–4 sessions that share repos, which makes it a multi-agent system whether or not
it is described as one. The question is the shape. Henry stays a **star with the user at the
centre**: sessions may *read* what their neighbours are doing, and they may *call the user*,
and nothing more. A session cannot type into another session, message it, or change Henry's
config. The user is the only router, and the rail stays a truthful record of who did what.

- **The tools are an MCP server on the daemon** (`daemon/src/mcp.ts`), `POST /mcp`, JSON-RPC
  2.0, no SDK: one endpoint answering initialize / ping / tools/list / tools/call is not worth
  a dependency. Loopback only, like `/hook`.
- **MCP reaches a session through `--mcp-config`, never `--settings`.** Claude Code does not
  read `mcpServers` out of a settings file: verified 2026-09-04 by pointing each flag at its
  own port, where the settings one drew no connection at all and `--mcp-config` drew the full
  handshake. So `~/.henry/launch-mcp.json` is its own file beside `launch-settings.json`, and
  every hosted session gets both flags (the PATH shim too, guarded on the file existing).
  Never `--strict-mcp-config`: Henry's server is added to the user's own, not put in their place.
- **A tool definition is a tax on every request of every session**, since it rides in the
  system prompt all day (measured: 127 tokens for `henry_activity`). So the server serves
  **two tool lists**. `?as=session` (what `launch-mcp.json` points at) is the narrow one:
  today `henry_activity` and `henry_attention`, under 2.2 KB of schema together, and adding a
  third has to be worth the same cost in all four sessions. A client that connects without it
  gets the wide list, where one process pays once; that is where the overseer's own tools go.
- **A call names its own session** through `session=${HENRY_SESSION:-}` in the `launch-mcp.json`
  url: Claude Code expands `${VAR}` in an mcp config (verified 2026-09-04 against the CLI, both
  set and unset), so one shared file still tells the daemon which tab is calling. An unexpanded
  or unknown value means "no session" — except where exactly one Claude session is live, which
  is then the only session it can be.
- **`henry_activity(repo?)`** answers "who else is in this repo and what are they holding".
  Per checkout: branch, ahead/behind, uncommitted count; each live session with its `activity`
  (a session `waiting on the human 45m` is parked, so its dirty files are not in flight) and
  the uncommitted files it is on record as writing; the last 3 commits, so a session can see
  one landed under it; and the rest of the dirty tree as *not traced to a live session*.
  `repo` takes a name or a path and is optional. A bare name matches every checkout with it,
  worktrees included: that is exactly when two sessions think they are alone.
- **`henry_attention(message, minutes?, wait?, done?)`** is the one tool that writes, and what it
  writes is a message addressed to the user: *come to this session*. It exists for the thing that
  goes stale — an expiring code, a deploy window, a destructive step worth confirming first —
  which is why an ask carries a **deadline** (default 30 min) and Henry drops it when the deadline
  passes. A session that merely wants the user *eventually* already has the rail, where a finished
  turn reads as "your move"; the tool's description says so, because the failure mode is a session
  that asks for every question.
  It never blocks the session: `wait` (seconds) is the caller's own choice to hold the call open
  until the user arrives, and it comes back either way, saying which happened. It is capped at 55
  seconds because Claude Code gives up on an MCP tool call at 60 (verified 2026-09-04: a tool that
  sleeps 70s reaches the model as "The operation timed out"), so the answer is always Henry's
  rather than a timeout's; the same call again waits on the same ask instead of raising a second. The
  answer also says how many windows are open, since an ask nobody can see is worth knowing about.
  Three open asks per session is the cap, the same words twice is one ask, and `done` withdraws
  one — a session that stops needing the user says so rather than leaving noise in the topbar.
- **An ask is answered by showing up, and only the user can answer it.** Typing into the session
  (`engagement.ts`, prompt or keystroke) clears it, and so does clicking it in the rail or the
  topbar — the message is right there in what you clicked, so reading it *is* the answer. That is
  the one place looking counts as engagement. A session that exits takes its asks with it, and
  `attention:answered` over the WS is what releases a `wait`. Asks live in memory, mirrored to
  SQLite, so a daemon restart brings back the ones whose deadlines have not passed; a finished ask
  stays as history until the retention sweep. Asks from a paired machine relay like flags do, and
  answering one from here answers it there.
- **In the UI an ask is the loudest thing Henry says**: an alarm-coloured chip in the topbar
  carrying the sentence itself (the only chip that carries one), a lit edge and a ❗ on the rail
  row, its own "asking for you" group at the top of "by attention", the window title, which is
  the one thing readable from another app, and — once you have turned them on — an OS
  notification (see [activity.md](activity.md)).
- **Attribution comes from the hook stream, not from git.** `git.changedFiles` diffs the repo,
  so in a shared checkout it hands every dirty path to every session there. `mcp.ts` reads the
  `file_path` of each `Write`/`Edit`/`NotebookEdit` event instead. A Bash `sed -i` or `>` names
  no path, so an untraced file means "nobody claimed it", never "nobody touched it", and the
  wording says so.
- **The answer is a dozen lines of text**, not JSON: it is read by a model mid-task. Caps on
  repos, files and commits, `~` for the home prefix, and one 5s cache so an agent checking
  several files in a row costs one set of git spawns.
- **`mcp.sessions: false` takes it out of the sessions** and leaves the endpoint up; `mcp.enabled:
  false` turns the whole thing off. Off *deletes* `launch-mcp.json` rather than just skipping the
  write, since the PATH shim decides by whether the file is there. `henry install` does not add
  the server to the user's own config: that would put Henry's tools in every Claude on the
  machine, Henry's or not.
