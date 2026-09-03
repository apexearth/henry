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
`install`/`uninstall`/`status` are milestone 2.

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
