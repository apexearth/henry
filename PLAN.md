# Henry — plan

Henry hosts my Claude Code sessions and shows me what is happening across repos,
branches, worktrees, and usage, so I am not in the dark. Terminal center stage,
sessions as tabs on the left, state on the right. Multiple windows may be open at
once, all attached to one daemon.

Written 2026-09-02. This file is the contract the build follows. Update it when
the design changes; do not let it drift into a changelog.

## Decisions already made

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
- **TypeScript end to end.** Bun runtime for the daemon, Vite + React + xterm.js for
  the UI. Agentic-first: the stack Claude writes and tests fastest.
- **Browser or native, same page.** The daemon serves the UI at `http://127.0.0.1:4711`.
  `packages/shell` is a Tauri window on that URL and nothing else: no IPC, no state, no
  bundled frontend. It exists for the macOS menu, since a browser tab never sees ⌘N or
  ⌘1..9. Menu items reach the page as `henry:menu` CustomEvents. Both front ends run at
  once against the one daemon.
- **Observe and flag, never block.** Henry's safeguard rules classify tool calls and
  git events as `info`, `notable`, or `alarm`. They never return a hook deny.
- **3–4 top-level sessions** is the design point. Subagents show under their parent.
- **Usage = % toward subscription limits.** Source: the statusline JSON Claude Code
  hands to a status command carries `rate_limits.five_hour` / `seven_day`
  utilization (verified in build 2.1.259). Henry's installed status command posts
  that JSON to the daemon. Token/cost totals per session come from the transcript
  JSONL `usage` fields as a secondary view.
- **Overseer runs at my altitude.** It reads Henry's event DB, git summaries, and the
  repo's `ACTIVE-WORK.md`. It never reads code. Two backends: Anthropic API with
  `claude-opus-5` when `ANTHROPIC_API_KEY` is present; otherwise headless
  `claude -p` on the subscription. Config picks; default is whichever works.
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
- **Henry never edits `~/.claude/settings.json` on its own.** `henry install`
  merges hooks + statusLine idempotently and preserves everything else.
  `henry uninstall` removes only what it added.
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
- **The rail is one line per session, titled by the terminal.** The daemon watches each
  PTY for OSC 0/2 title sequences and stores the latest as the session title, so `/rename`
  in Claude Code (which retitles the terminal) renames the rail entry; the transcript's
  `custom-title` line does the same for external sessions. A leading status glyph is
  dropped. The repo name shows dimmed beside the title when they differ; cwd, host and
  shortcut live in the tooltip. Running sessions come first (oldest first); exited ones
  are hidden until the footer's "N closed" is opened, then listed below, newest exit
  first. The exited session you are looking at stays listed. Closing an exited session
  (×) sets `dismissed_at` in the DB: it never returns after a daemon restart, but its
  events, flags and playbook stay. `⌘1..9` (or `Ctrl`) and `⌘↑/↓` follow the rail order;
  `⌃N` (⌘N where the browser frees it) opens the "+ new" picker; `⌘D` duplicates the active
  tab, a new session of the same kind in its cwd, skipping the picker. No `⌃D`: that is EOF
  in the terminal.
- **Grouping is a rail-footer choice, persisted per browser.** Off by default; "by folder"
  buckets sessions on `cwd`, "by repo" on the repos the git watcher has seen the session
  touch, so a session working across two repos is listed under both (one that has touched
  none falls into a last "no repo" bucket). Order within a group, and the keyboard order,
  stay the running-then-exited rail order. The active *row* is the one you picked (session
  plus group): it alone gets the full highlight, the same session's rows under other repos
  get a half-strength bar, and `⌘↑/↓` step from the picked row, not its first echo.
  A repo name is coloured by a hash of the name wherever it appears (group headers, row
  sub-labels, the Repos panel, the Files section, the new-session picker), so one repo is one
  colour across grouping modes, restarts and machines; "no repo" and the attention groups stay grey.
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
  time-in-state while working and time since I last typed otherwise (see engagement).
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
  "by attention" grouping: my move first, longest since I typed at the top, then working,
  then terminals and closed rows. Looking at a session without typing is not engagement.
- **Shift+Enter is a newline in Claude Code.** The terminal sends ESC CR (what
  `/terminal-setup` binds) when the session is running Claude; a plain shell gets Enter.
- **Sessions outlive the daemon, terminal included.** After a daemon restart the
  sessions sessiond still holds are running in the rail with their scrollback; only
  sessions from before the last sessiond (last 24h) come back as exited with their
  repos, flags and playbook and no output. An exited Claude session has a ↻ button that
  opens a new tab with `claude --resume <id>`. Every session carries `host` (config
  `host`, default short hostname), groundwork for daemons on several machines.
- **The overseer runs once per real turn.** Stops with `stop_hook_active` (Claude sent
  back by another Stop hook) are ignored, and Stop-triggered runs for one session are
  at least `overseer.stopMinIntervalSec` (60) apart. Flags still run immediately.

## Federation: sessions on other machines

Every machine runs the full pair (sessiond + daemon): hooks, git and transcripts are local
files, so a daemon cannot be remote. What crosses machines is a **link between daemons**,
never a window talking to a far daemon: the UI keeps its one WebSocket, and no credential
ever reaches a browser. The daemon a window is attached to dials each paired peer, mirrors
the peer's sessions into the state it already serves (tagged `peer`, with their repos,
flags, usage and playbook), and relays terminal traffic, `session:create`, kill, diffs and
the `/api/*` calls those sessions need (`?peer=` or a relayed `sessionId` routes a request
to the peer's copy of the same handler). A dropped link takes its sessions out of the rail
until it is back. Two machines that both listen dial each other, so each window sees both.

- **Listening is tailnet-only by default.** `federation.listen: "tailscale"` binds the
  machine's 100.64/10 address on `federation.port` (4712) and serves nothing but `/fed`:
  no UI, no `/api`, no hooks. `"off"` never listens; an explicit address binds that
  (`0.0.0.0` works, with a warning). Loopback :4711 is unchanged.
- **Identity is a per-machine Ed25519 key** in `~/.henry/federation.json` (0600), next
  to the peer list. Pairing pins the other side's key; from then on every connection is
  mutually authenticated: an X25519 ephemeral exchange, HKDF, AES-256-GCM per direction
  with strict counters (replay = out of order = drop), and both sides sign the full
  transcript (nonces, ephemeral keys, identity keys), so a swapped key fails verification
  and the wire is private even off the tailnet.
- **Pairing is a one-time code.** "Show a pairing code" (remotes menu, or `henry pair`)
  opens a ten-minute window with a 60-bit code; the joiner proves it under the shared
  secret (a passive observer learns nothing; an active one gets five online guesses, then
  the code is revoked). The joiner also advertises its own listen URL, so one pairing
  links both ways. Both sides show fingerprints to compare afterwards. Five failed
  handshakes from one address lock it out for a minute.
- **A paired machine is you.** It can attach, type, start and kill sessions and read files
  in repos there, exactly what a window can. Pause or forget a peer from the remotes menu
  (`henry peers forget <name>`); a forgotten key is refused at the next handshake.
  `/api/federation/*` is never proxied and never served to a peer.
- **In the rail** a relayed session carries a dotted chip with the peer's name (coloured
  like a repo name); "by machine" grouping buckets on it; "+ new" offers the connected
  machines as a place to start the session. File peeks and ⌘K read from the machine of the
  session you are looking at. Global playbook and 5h/7d usage stay per machine (same
  account, same limits).

## Layout

```
┌──────────┬──────────────────────────────────────┬──────────────────────┐
│ sessions │                                      │ Repos│Flags│Play│Use │
│ ▣ Rail fi│                                      │                      │
│ ▣ Stealth│         xterm.js (WebGL)             │  per-repo cards:     │
│ >_ henry │         one per session              │  branch, ↑↓ upstream │
│ ▢ arm ⚑2 │                                      │  commits since base  │
│ + new    │                                      │  diff viewer         │
│ 3 running│                                      │                      │
└──────────┴──────────────────────────────────────┴──────────────────────┘
```

That is the default arrangement, not a fixed one. The workspace is a Dockview grid
(`dockview-react`): the rail, every terminal and each tool tab is a panel. Drag a tool tab
to split a group (top/bottom/left/right), stack it as a tab, dock it on a window edge, or
float it. Tabs have no close button and there is no view menu: tools are rearranged, never
dismissed. The arrangement is saved to localStorage
(`henry.layout.v1`) and restored on load; "reset layout" restores the picture above.
The selected session is saved too (`henry.active`, id + cwd), so a refresh reopens where you
were; if that session is gone, Henry falls back to a running session in the same repo.

**The centre is a stage, not a tab strip.** Sessions are processes you glance at, not
documents you curate, so terminal groups hide their header: the rail (and ⌘1..9, ⌘↑/↓) is
the only selector, and one session shows at a time. The centre group is locked: tools dock
around its edges but cannot be dropped into it, and terminals are not dragged. Terminal
panels whose session is gone are dropped; new sessions join the active terminal group (or
the empty centre pane). Drag handles are tab headers only: dragging panel bodies would
fight xterm's mouse handling and text selection.

**File peeks.** Files are things you glance at, not documents you keep open. ⌘-click a
path in terminal output (relative paths resolve against the session's cwd) or a file header
in a diff and the file opens read-only over the session, in the same stage group, with its
own slim header (path, repo, +added −deleted vs baseline, size, ×). A `path:line` reference
scrolls to and tints that line. The stage is a strip: the session at position 0, its peeks
to the right; ⌘←/→ walk it, Esc (or ×) closes the peek in view, and closing the last one
lands on the session that was showing. Peeks are per window, never restored with the
layout, served by `GET /api/file?path=&cwd=` (1 MB cap, binary detection).

**Changes are shown against the session's baseline**, not HEAD: that is the Henry question
("what did this session do"). `GET /api/file/diff?sessionId=&path=` returns the one-file
unified diff (untracked files against /dev/null); the peek tints added lines and shows
deleted lines as struck-through ghosts where they were. A session with no baseline (a plain
terminal) diffs against HEAD, so "changed" means "uncommitted" there.

**Files in the rail.** Under the sessions, the active session's changed files
(`GET /api/session/files?sessionId=`: working tree vs baseline per repo the session touched,
plus the repo its cwd is in; untracked as `?`), newest mtime first, click to peek. Nothing
to open or close: the list is derived from git.

**⌘K finds a file to peek at.** Changed files of the session you are looking at come first,
then recent peeks (per browser, last 40), then, once you type, every file in that session's
repos (the one its cwd is in first) and finally other sessions' repos, fuzzy-matched on the
path with a bias to file-name hits. `GET /api/repo/files?repo=` is `git ls-files` incl.
untracked, cached 10 s. ⌃K works too, except in the terminal where it stays kill-line.

**Appearance.** Three choices in the topbar "theme" popover (tone, highlight, shade) derive
the whole palette in OKLCH; `theme.ts` writes it as CSS variables on `<html>` and the
terminal (background, foreground, cursor, selection, the 16 ANSI colors) reads the same
variables, so the stage and the chrome always match. Nothing else hard-codes a color.
Saved as `henry.theme`. Semantic colors (ok/warn/alarm) and the Claude orange stay fixed
across themes; no light mode yet.

Tool tabs:
- **Repos** — every repo this session has touched: branch, ahead/behind upstream,
  has-upstream, commits since session baseline, dirty count, worktree path, and a ↗
  link to the upstream remote's web page (scp/ssh/https git URLs become https).
  Click a repo → diff vs baseline (unified/split).
- **Flags** — feed of `notable`/`alarm` events with unread badge; each links back
  to the tool call and the rule that fired.
- **Playbook** — the overseer's running log for this session, newest first, plus a
  "right now" summary at the top. Entries are written in a labeled shape (HEADLINE,
  DOING, CHANGED/REPOS, CAREFUL, NEXT; `code` for repo/branch/file names) that
  `parsePlaybookText` in shared turns into a headline, colored sections and bullets;
  older entries collapse to their headline. A global playbook view across all
  sessions lives on the rail footer.
- **Usage** — 5h and 7d utilization bars with reset times; the active session's
  context bar (occupancy vs. window); per-session token, context and cost totals.
  Context costs nothing extra: it is the last main-chain assistant message's input +
  cache tokens, which the transcript tailer already parses (statusline
  `context_window` fills in until the first turn and supplies the window size).

## Repo layout

```
henry/
  PLAN.md
  package.json                 # bun workspaces
  packages/
    shared/                    # protocol + types shared by daemon and ui
      src/protocol.ts          # WS message union, REST shapes
      src/types.ts             # Session, RepoState, Flag, PlaybookEntry, Usage
    daemon/
      src/index.ts             # cli: start | install | uninstall | status | sessiond status|restart
      src/server.ts            # HTTP + WS on 127.0.0.1:4711, serves ui/dist
      src/sessions.ts          # session records, reconciliation with sessiond, attach/detach
      src/sessiond-client.ts   # finds/starts sessiond, NDJSON over loopback TCP, reconnect
      src/sessiond-cli.ts      # henry sessiond status | restart [--now]
      src/federation.ts        # peer store, tailnet listener, pairing, inbound links, state merge
      src/fed-peer.ts          # outbound link: dial, mirror a peer's sessions, relay PTY + /api
      src/fed-crypto.ts        # identity keys, handshake, AES-GCM channel, pairing codes
      src/federation-cli.ts    # henry pair | peers [forget <name>]
      src/db.ts                # bun:sqlite schema + queries (~/.henry/henry.db)
      src/hooks.ts             # POST /hook, POST /statusline ingest
      src/transcript.ts        # tail ~/.claude/projects/**/<session>.jsonl
      src/git.ts               # repo discovery, worktrees, status, ahead/behind, diff
      src/rules.ts             # ~/.henry/config.json rules → classify events
      src/activity.ts          # working | needsInput | waiting | idle, derived from hooks
      src/engagement.ts        # my prompts + keystrokes per session: lastInputAt, prompt sparkline
      src/overseer.ts          # playbook writer (api | claude-cli backend)
      src/installer.ts         # settings.json merge/unmerge
      hooks/henry-hook.sh      # tiny script installed into settings.json
      hooks/henry-statusline.sh
    sessiond/                  # henry-sessiond: owns the PTYs, outlives the daemon (Node, node-pty only)
      src/main.ts              # TCP server, spawn/attach/kill, 2MB scrollback ring, drain/shutdown
      src/protocol.ts          # wire types, PROTOCOL_VERSION; the daemon imports this file
      README.md                # why it stays boring; the protocol
    ui/
      src/App.tsx              # top bar (view buttons, reset) + Layout
      src/Layout.tsx           # Dockview root; wraps rail, terminals and tools as panels
      src/dock.ts              # default layout, localStorage persistence, open/focus helpers
      src/ws.ts                # client, reconnect, state store
      src/Terminal.tsx         # xterm + webgl addon
      src/RepoPicker.tsx       # "+ new": typed picker over repos × {claude, terminal}
      src/panels/{Repos,Flags,Playbook,Usage}.tsx
      src/DiffView.tsx
```

## Data flow

```
claude (in PTY) ──hooks──▶ henry-hook.sh ──POST /hook──▶ daemon ──▶ SQLite
                 ──status──▶ henry-statusline.sh ──POST /statusline──▶ daemon
~/.claude/projects/**.jsonl ──tail──▶ daemon (usage, tool detail, subagents)
~/code/*/.git ──watch+poll──▶ daemon (repo state, baseline diffs)
sessiond (owns PTYs) ◀──TCP 127.0.0.1, token──▶ daemon (spawn, write, attach, scrollback)
daemon ──WS──▶ every attached window (pty data, state deltas)
daemon ──on Stop / on flag──▶ overseer ──▶ playbook rows ──WS──▶ windows
daemon ◀──ws://<tailscale ip>:4712/fed, mutually authenticated──▶ peer daemon (its sessions, relayed)
```

Session identity: the daemon spawns `claude` with env `HENRY_SESSION=<uuid>`. Hook
payloads carry Claude's own `session_id`; the first hook event from a PTY binds the
two. The transcript file is `~/.claude/projects/<slug>/<session_id>.jsonl`.

Baseline: when a session first touches a repo (first hook event whose cwd or file
path resolves into it), record `HEAD` as that session's baseline for that repo.
"Commits since" and the diff are against that ref.

## Config (`~/.henry/config.json`)

- **First run asks for `reposRoot`.** Until config.json has one, every window shows a
  modal (no dismiss) explaining that Henry expects a single folder holding all repos as
  subfolders, with a live count of what it finds at the typed path. `POST /api/config
  {reposRoot}` validates the folder, writes it (and `defaultRepo`, unless already set) and
  broadcasts state with `firstRun: false`. The same modal reopens from the topbar
  (`repos <path>`) to change the folder later, with Cancel; the daemon never writes
  config.json otherwise. Changing it moves the outside-root boundary for running sessions.

```json
{
  "port": 4711,
  "host": "mbp",
  "reposRoot": "~/code",
  "defaultRepo": "~/code",
  "overseer": { "backend": "auto", "model": "claude-opus-5", "onStop": true, "onFlag": true, "stopMinIntervalSec": 60 },
  "federation": { "listen": "tailscale", "port": 4712 },
  "rules": {
    "protectedBranches": ["main", "master"],
    "alarm": ["git push --force", "git push -f", "git reset --hard", "rm -rf", "git branch -D", "git checkout -- ."],
    "notable": ["git push", "git rebase", "git merge", "git checkout", "git switch", "git worktree", "git stash", "gh pr"],
    "crossRepoWrite": "notable",
    "commitOnProtected": "alarm"
  }
}
```

## Milestones

1. **Terminal host.** Daemon with PTY sessions, WS attach, scrollback replay, UI with
   rail + terminal, new-tab repo picker, multiple windows attach. `bun run dev` works.
2. **Events + usage.** Hook + statusline scripts, `henry install`/`uninstall`,
   `/hook` and `/statusline` ingest, transcript tailer, Usage tab, raw event feed.
3. **Git.** Repo discovery incl. worktrees, per-session baselines, Repos tab, diff
   viewer, ahead/behind, push state.
4. **Flags.** Rules engine over hook + git events, Flags tab with unread badges,
   cross-repo write detection, commit-on-protected detection.
5. **Overseer.** Playbook writer with both backends, per-session and global
   playbook, Playbook tab.

Definition of done for this plan: all five milestones exist, `bun run dev` brings up
the daemon and UI, a real `claude` session runs inside it, and each panel shows live
data from that session. **Met 2026-09-02**: verified in Chrome against a live
Fable 5.1 session in this repo (hooks, usage 5h/7d, repo card, playbook entries).

## Later (not in this plan)

- Git actions from the UI (commit, push, new worktree).
- Blocking rules (PreToolUse deny) once the observe-only picture is trusted.
- Replay of a session's history as a timeline.
