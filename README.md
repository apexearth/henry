# Henry

<img src="packages/ui/public/henry.svg" alt="" width="72" align="right">

Hosts Claude Code sessions in PTYs and shows what they do: sessions as tabs, terminal
in the middle, repos / flags / playbook / usage on the right. `PLAN.md` is the contract.

Three processes: **henry-sessiond** (`packages/sessiond`, Node) owns the PTYs and their
scrollback and is meant to run for weeks; the **daemon** (`packages/daemon`, Bun) owns
the DB, HTTP/WS, hooks, git and the overseer, and talks to sessiond over loopback TCP;
the **UI** (`packages/ui`) is a browser window attached to the daemon. The daemon can
restart as often as it likes (it does, under `bun --watch`, on every source edit) and
reconnects to the same live sessions with their scrollback intact.

## Run

```sh
bun install
bun run dev        # daemon (bun --watch) on :4711 + Vite on :5173
```

Open http://127.0.0.1:5173 in dev. The window is a dockable workspace: drag a tool tab
(Sessions, Repos, Flags, ...) to split, stack, edge-dock or float it; the arrangement is
saved per browser and "reset layout" in the top bar restores rail | terminal | tools. The
terminal in the centre has no tabs: the rail picks which session is shown. To point
the dev page at a private daemon, run Vite with `HENRY_PORT=<port>`. For a
production-style run:

```sh
bun run build      # typechecks every package, builds packages/ui/dist
bun run start      # daemon serves ui/dist at http://127.0.0.1:4711
```

Several browser windows can open the same URL; they all attach to the one daemon and
see the same sessions with live output. Only the Vite page hot-reloads on source edits;
windows on :4711 show `ui/dist` and reload themselves as soon as `bun run build` writes a
new one (the daemon polls `dist/index.html` and tells every window). Editing daemon source under `bun run dev` restarts
only the daemon: sessions keep running in sessiond and the windows reconnect. `bun run
sessiond` runs sessiond in the foreground for debugging (the daemon then attaches to it
instead of starting its own). `Cmd+1..9` (or `Ctrl+1..9`, since Chrome on macOS reserves Cmd+digit) switches tabs in
rail order; `Cmd+↑/↓` steps through them; `Ctrl+N` (Cmd+N is Chrome's new window) opens "+ new".
`bun run app` opens the same UI in a native window instead, where the Cmd keys are yours:
`Cmd+N` is File > New Session and `Cmd+1..9` reach the page. It needs a Rust toolchain and
attaches to whatever daemon is already running (`HENRY_URL` or `HENRY_PORT` to point it
elsewhere); `bun run app:bundle` writes Henry.app. `Shift+Enter` inserts a newline in Claude Code's
prompt. The rail shows the terminal title (what `/rename` sets); exited sessions are hidden
behind the footer's "N closed" toggle, and × on one drops it for good.

`+ new` opens a picker: type to filter, `↑↓` to choose, Enter to open. Every repo under
`reposRoot` is listed as a Claude session (Clawd) and again as a plain terminal (`>_`, your
`$SHELL -l`); typing `terminal` or `$` narrows to the latter, and an absolute or `~` path
offers both for that directory. The rail marks each session by what is actually running:
a terminal in which you type `claude` shows Clawd while that Claude runs, because the shells
Henry hosts get `~/.henry/bin/claude` first on PATH, a shim that adds Henry's launch
settings (hooks + statusline) so no `henry install` is needed for it. Subcommands such as
`claude mcp ...` pass through the shim untouched.

Smoke test (boots a throwaway daemon, drives it over WebSocket with `/bin/sh` in place
of `claude`):

```sh
bun run smoke
```

Config lives in `~/.henry/config.json` (defaults in `packages/shared/src/types.ts`);
the database is `~/.henry/henry.db`; sessiond writes `~/.henry/sessiond.json` (port, token,
pid) and `~/.henry/sessiond.log`. `HENRY_HOME` and `HENRY_PORT` override all of it for tests.
`config.host` (default: short `os.hostname()`) is stamped on every session the daemon
creates, groundwork for running daemons on several machines.

CLI (`packages/daemon/src/index.ts`): `henry start | install | uninstall | status`, plus

- `henry sessiond status` — prints `sessiond.json`, whether that process answers a ping,
  its protocol version against the daemon's, and how many sessions it holds.
- `henry sessiond restart [--now]` — asks sessiond to exit once every session has ended
  (the daemon starts a fresh one on its next connect), or with `--now` hangs up every
  session and exits immediately. This is how a new sessiond version gets picked up; the
  daemon warns at startup when the two protocol versions differ.

## Install hooks

Henry learns what a session does from Claude Code's own hooks and status line. Nothing is
wired up until you run:

```sh
bun run --cwd packages/daemon start install   # or: bun packages/daemon/src/index.ts install
```

That merges into `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`):

- one `{ matcher: "", hooks: [{ type: "command", command: "<repo>/packages/daemon/hooks/henry-hook.sh <Event>" }] }`
  entry for each of PreToolUse, PostToolUse, Stop, SubagentStop, UserPromptSubmit,
  SessionStart, SessionEnd, PreCompact, Notification, unless an entry for that event
  already runs `henry-hook.sh`;
- `statusLine: { type: "command", command: "<repo>/packages/daemon/hooks/henry-statusline.sh" }`,
  but only if you have no `statusLine` yet. If you do, install prints a warning and leaves
  it; `HENRY_FORCE_STATUSLINE=1 henry install` replaces it and keeps the old value under
  `_henryPreviousStatusLine` so `henry uninstall` can put it back.

Everything else in the file is preserved; the first run copies the original to
`settings.json.henry-backup`. `henry install` is idempotent, `henry uninstall` removes only
what Henry added, and `henry status` shows which events are installed, whose status line is
active, and whether the daemon answers.

The hook script POSTs each hook payload to `http://127.0.0.1:$HENRY_PORT/hook` with
`--max-time 1` and always exits 0, so a stopped daemon costs a session nothing. The status
line script POSTs Claude Code's statusline JSON (which carries `rate_limits.five_hour` /
`seven_day`) to `/statusline` and prints the daemon's reply, e.g. `henry · 5h 42% ↻2h10m ·
7d 17% ↻3d · $1.23`; when the daemon is down it prints nothing. Sessions started outside
Henry (Zed, a plain terminal) still post hooks and show up in the rail as "external"
sessions with events and usage but no terminal output. Per-session tokens and cost come from
tailing `~/.claude/projects/<slug>/<session_id>.jsonl`; the cost shown prefers Claude Code's
own `total_cost_usd` from the status line and falls back to a list-price estimate.

Tests (`bun run test`, which runs each file in `packages/daemon/test` in its own process)
exercise all of this against throwaway daemons and a scratch `CLAUDE_CONFIG_DIR`; they never
touch `~/.claude` or `~/.henry`, and every test stops the sessiond it started (by pid, via
`test/sessiond-helper.ts`). `test/survival.test.ts` is the daemon-restart proof: create a
shell, SIGTERM the daemon, start another one, find the same shell running with its scrollback.

## Requirements

- bun ≥ 1.3 (daemon runtime, `bun:sqlite`, `Bun.serve` WebSockets)
- node ≥ 22 on `PATH` (runs sessiond, see below)
- `claude` on `PATH`

## sessiond, node-pty and Bun

The daemon runs on Bun, but node-pty does not work under Bun 1.3.3: the PTY spawns, but
Bun cannot read the pty master through `net.Socket`, so no data or exit ever arrives
(verified with a direct probe). Bun's own `Bun.Terminal` / `Bun.spawn({ terminal })`
exists in newer bun-types but is not in 1.3.3.

So the PTYs live in `henry-sessiond` (`packages/sessiond`, Node, node-pty is its only
dependency), which doubles as the thing that keeps sessions alive across daemon restarts.
The daemon (`packages/daemon/src/sessiond-client.ts`, driven by `sessions.ts`) reads
`sessiond.json`, connects with the token, and on a missing, stale or unresponsive file
starts `node packages/sessiond/src/main.ts --daemon` and waits for a fresh file. On start
the daemon reconciles: sessions sessiond still holds are running in the rail (attached, with
scrollback fetched from sessiond on every window attach); sessions from the last 24h that
sessiond does not have come back as exited with a note. Stopping the daemon never stops
sessiond; `henry sessiond restart` does. sessiond ignores SIGHUP and refuses SIGTERM while
a session runs. Protocol and lifecycle: `packages/sessiond/README.md`.

Install detail: node-pty's `postinstall` is what marks its `spawn-helper` binary
executable, and bun only runs it for `trustedDependencies` (set in the root
`package.json`). sessiond also fixes the bit at startup in case it was skipped.
