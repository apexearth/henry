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
bun run dev        # daemon (bun --watch) on :14711 + Vite on :14713 + the native window
```

`bun run dev` also builds the shell (debug `cargo build`, skipped without a Rust
toolchain or with `--no-shell`) and opens it on the Vite page once Vite answers, so the
window hot-reloads too; an edit under `src-tauri` rebuilds and reopens it. Each of the
three is restarted if it dies, after a delay that doubles while it keeps dying; closing
the window is a clean exit and leaves it closed. Or open http://127.0.0.1:14713 in a browser. The window is a dockable workspace: drag a tool tab
(Sessions, Repos, Flags, ...) to split, stack, edge-dock or float it; the arrangement is
saved per browser and "reset layout" in the top bar restores rail | terminal | tools. The
terminal in the centre has no tabs: the rail picks which session is shown. To point
the dev page at a private daemon, run Vite with `HENRY_PORT=<port>`. For a
production-style run:

```sh
bun run build      # typechecks every package, builds packages/ui/dist
bun run start      # daemon serves ui/dist at http://127.0.0.1:14711
```

Several browser windows can open the same URL; they all attach to the one daemon and
see the same sessions with live output. Only the Vite page hot-reloads on source edits;
windows on :14711 show `ui/dist` and reload themselves as soon as `bun run build` writes a
new one (the daemon polls `dist/index.html` and tells every window). Editing daemon source under `bun run dev` restarts
only the daemon: sessions keep running in sessiond and the windows reconnect. `bun run
sessiond` runs sessiond in the foreground for debugging (the daemon then attaches to it
instead of starting its own). `Cmd+1..9` (or `Ctrl+1..9`, since Chrome on macOS reserves Cmd+digit) switches tabs in
rail order; `Cmd+↑/↓` steps through them; `Ctrl+N` (Cmd+N is Chrome's new window) opens "+ new";
`Cmd+D` duplicates the current tab: a new session of the same kind in the same folder.
The `keys` button in the top bar (or `Cmd+/`) lists every shortcut.
`bun run app` opens the same UI in a native window instead, where the Cmd keys are yours:
`Cmd+N` is File > New Session, `Cmd+D` File > Duplicate Session, and `Cmd+1..9` reach the page. It needs a Rust toolchain and
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

Smoke test (boots a throwaway daemon, drives it over WebSocket with `/bin/sh`, or PowerShell
on Windows, in place of `claude`):

```sh
bun run smoke
```

Config lives in `~/.henry/config.json` (defaults in `packages/shared/src/types.ts`);
the database is `~/.henry/henry.db`; sessiond writes `~/.henry/sessiond.json` (port, token,
pid) and `~/.henry/sessiond.log`. `HENRY_HOME` and `HENRY_PORT` override all of it for tests.
`config.host` (default: short `os.hostname()`) is stamped on every session the daemon
creates, groundwork for running daemons on several machines.

CLI (`packages/daemon/src/index.ts`): `henry start | install | uninstall | status | pair | peers`, plus

- `henry sessiond status` — prints `sessiond.json`, whether that process answers a ping,
  its protocol version against the daemon's, and how many sessions it holds.
- `henry sessiond restart [--now]` — asks sessiond to exit once every session has ended
  (the daemon starts a fresh one on its next connect), or with `--now` hangs up every
  session and exits immediately. This is how a new sessiond version gets picked up; the
  daemon warns at startup when the two protocol versions differ.

## Sessions on other machines

Run Henry on each machine (they share nothing; every daemon has its own DB and sessiond),
then pair them once and each window shows both. The daemon listens for peers on the
machine's Tailscale address, port 14712, and nowhere else (`federation.listen` in
`~/.henry/config.json`: `"tailscale"`, `"off"`, or an address). To pair: on machine A open
**remotes** in the top bar and click "show a pairing code" (or run `henry pair`); on machine
B open remotes → join, enter A's address and the code. That is all: A stores B's key and
dials B back, B stores A's key and dials A, and sessions from the other machine appear in
the rail with a dotted chip naming it. Compare the fingerprints the menu shows on both
sides. Pairing codes live ten minutes and work once; every connection after that is
mutually authenticated by the stored keys and encrypted end to end (details in
`PLAN.md`, "Federation"). `henry peers` lists what is paired; `henry peers forget <name>` or
the menu's × drops a machine. If a paired machine's address or port changes, the menu's
"address" button (or `henry peers url <name> <host[:port]>`) re-points it without pairing
again: the stored key still has to match.

A paired machine can do to your sessions what a window can, typing included. Pair only over
your own tailnet, with machines you own.

## Install hooks

Henry learns what a session does from Claude Code's own hooks and status line. Nothing is
wired up until you run:

```sh
bun packages/daemon/src/index.ts install
```

That merges into `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`):

- one `{ matcher: "", hooks: [{ type: "command", command: "<repo>/packages/daemon/hooks/henry-hook.sh <Event>" }] }`
  entry for each of PreToolUse, PostToolUse, Stop, SubagentStop, UserPromptSubmit,
  SessionStart, SessionEnd, PreCompact, Notification, PermissionRequest, unless an entry for that event
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

- bun ≥ 1.2 (daemon runtime, `bun:sqlite`, `Bun.serve` WebSockets)
- node ≥ 22.6 on `PATH` (runs sessiond, see below; also the hook scripts on Windows)
- `claude` on `PATH`
- git on `PATH`

## Windows

Henry runs natively on Windows (no WSL): the same daemon, sessiond on ConPTY, the same UI.
`bun run dev`, `bun run build`, `bun run test` and `bun run smoke` work from PowerShell or
Git Bash. What is different:

- A plain terminal is PowerShell (`pwsh` if installed, else Windows PowerShell; cmd.exe only
  when neither exists), not `$SHELL -l`. Typing `claude` in it still goes through Henry's shim
  (`~/.henry/bin/claude.cmd`; a Git Bash terminal uses the sh shim next to it).
- `henry install` writes `node <repo>/packages/daemon/hooks/henry-hook.mjs <Event>` (and the
  statusline twin) into settings.json, since Claude Code on Windows runs hooks under Git Bash
  or PowerShell and neither is guaranteed curl. Paths are written with forward slashes on
  purpose: Git Bash strips unquoted backslashes.
- Shortcuts in a browser tab: `Ctrl+1..9` pick a tab, `Alt+↑/↓` step through the rail, `Alt+←/→`
  walk the stage, `Alt+N` opens "+ new" (Chrome reserves `Ctrl+N`), `Ctrl+Shift+D` duplicates,
  `Ctrl+K` finds a file (outside the terminal), `Ctrl+/` lists every shortcut. In the native window `Ctrl+N` is File > New Session.
- Closing a session terminates it (ConPTY has no SIGHUP to send); `henry sessiond restart
  --now` does the same to every session.
- `bun run app` needs a Rust toolchain and WebView2 (preinstalled on Windows 10/11);
  `bun run app:bundle` writes an NSIS installer and an MSI.
- `federation.listen: "tailscale"` finds the Tailscale adapter the same way; Windows Firewall
  may ask once about port 14712.

## sessiond, node-pty and Bun

The daemon runs on Bun, but node-pty does not work under Bun 1.3.3: the PTY spawns, but
Bun cannot read the pty master through `net.Socket`, so no data or exit ever arrives
(verified with a direct probe). Bun's own `Bun.Terminal` / `Bun.spawn({ terminal })`
exists in newer bun-types but is not in 1.3.3.

So the PTYs live in `henry-sessiond` (`packages/sessiond`, Node, node-pty is its only
dependency), which doubles as the thing that keeps sessions alive across daemon restarts.
The daemon (`packages/daemon/src/sessiond-client.ts`, driven by `sessions.ts`) reads
`sessiond.json`, connects with the token, and on a missing, stale or unresponsive file
starts `node --experimental-strip-types packages/sessiond/src/main.ts --daemon` (the flag is
a no-op on Node ≥ 22.18, where types are stripped by default) and waits for a fresh file. On start
the daemon reconciles: sessions sessiond still holds are running in the rail (attached, with
scrollback fetched from sessiond on every window attach); sessions from the last 24h that
sessiond does not have come back as exited with a note. Stopping the daemon never stops
sessiond; `henry sessiond restart` does. sessiond ignores SIGHUP and refuses SIGTERM while
a session runs. Protocol and lifecycle: `packages/sessiond/README.md`.

Install detail: node-pty's `postinstall` is what marks its `spawn-helper` binary
executable, and bun only runs it for `trustedDependencies` (set in the root
`package.json`). sessiond also fixes the bit at startup in case it was skipped.
