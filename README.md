# Henry

Hosts Claude Code sessions in PTYs owned by a local daemon and shows what they do:
sessions as tabs, terminal in the middle, repos / flags / playbook / usage on the right.
`PLAN.md` is the contract.

## Run

```sh
bun install
bun run dev        # daemon (bun --watch) on :4711 + Vite on :5173
```

Open http://127.0.0.1:5173 in dev. For a production-style run:

```sh
bun run build      # typechecks every package, builds packages/ui/dist
bun run start      # daemon serves ui/dist at http://127.0.0.1:4711
```

Several browser windows can open the same URL; they all attach to the one daemon and
see the same sessions with live output. `Cmd+1..9` (or `Ctrl+1..9`, since Chrome on macOS reserves Cmd+digit) switches tabs.

Smoke test (boots a throwaway daemon, drives it over WebSocket with `/bin/sh` in place
of `claude`):

```sh
bun run smoke
```

Config lives in `~/.henry/config.json` (defaults in `packages/shared/src/types.ts`);
the database is `~/.henry/henry.db`. `HENRY_HOME` and `HENRY_PORT` override both for tests.

CLI: `henry start | install | uninstall | status` (`packages/daemon/src/index.ts`).

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

Tests (`bun test` in `packages/daemon`) exercise all of this against a throwaway daemon and
a scratch `CLAUDE_CONFIG_DIR`; they never touch `~/.claude` or `~/.henry`.

## Requirements

- bun ≥ 1.3 (daemon runtime, `bun:sqlite`, `Bun.serve` WebSockets)
- node ≥ 22 on `PATH` (PTY host, see below)
- `claude` on `PATH`

## node-pty and Bun

The daemon runs on Bun, but node-pty does not work under Bun 1.3.3: the PTY spawns, but
Bun cannot read the pty master through `net.Socket`, so no data or exit ever arrives
(verified with a direct probe). Bun's own `Bun.Terminal` / `Bun.spawn({ terminal })`
exists in newer bun-types but is not in 1.3.3.

Choice: keep the daemon on Bun (so the DB, HTTP and WS contracts stay as planned) and
run node-pty in a small Node child process, `packages/daemon/src/pty-host.ts`, which
speaks newline-delimited JSON over stdin/stdout. `sessions.ts` is the only module that
knows about it. When the project moves to a Bun with `Bun.Terminal`, replace the host
with `Bun.spawn({ terminal })` inside `sessions.ts` and delete `pty-host.ts`.

Two install details: node-pty's `postinstall` is what marks its `spawn-helper` binary
executable, and bun only runs it for `trustedDependencies` (set in the root
`package.json`). The pty host also fixes the bit at startup in case it was skipped.
