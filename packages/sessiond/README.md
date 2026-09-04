# @henry/sessiond

`henry-sessiond` is the process that owns Henry's PTYs. The daemon
(`packages/daemon`) restarts under `bun --watch` on every source edit; sessiond does
not, so a Claude session started through Henry keeps running, with its scrollback,
while the daemon comes and goes. The daemon finds it, connects over loopback TCP, and
re-attaches to whatever is live.

## Why it must stay boring

Anything in this package changing means a restart of the process that holds every
session, so the goal is that it changes twice a year. Rules:

- Node runtime, `node-pty` as the only dependency. node-pty does not deliver data under
  Bun 1.3.3 (the pty master cannot be read through `net.Socket`), which is why this lives
  outside the Bun daemon in the first place. Node 22+ runs the `.ts` sources directly.
- No imports from `packages/daemon` or `packages/shared`. `src/protocol.ts` is its whole
  contract; the daemon imports that file, never the other way round.
- No policy. sessiond knows nothing about Claude, repos, hooks or the DB. It spawns what
  it is told to spawn, buffers output, and reports exits.

## Lifecycle

- Started by the daemon (`packages/daemon/src/sessiond-client.ts`) when nothing answers,
  as `node packages/sessiond/src/main.ts --daemon`: that launcher double-forks (the real
  sessiond is detached, stdio ignored, reparented to launchd/init so a `bun --watch`
  daemon that keeps its pid across reloads never leaves it as a zombie) and exits. Or in
  the foreground for debugging: `bun run sessiond` from the repo root.
- On start it writes `<HENRY_HOME>/sessiond.json` (mode 0600):
  `{ port, token, pid, protocolVersion, startedAt }`. `HENRY_HOME` defaults to
  `~/.henry`; the daemon passes its own value through the environment.
- Only one sessiond per `HENRY_HOME`: if `sessiond.json` names a live pid that answers
  hello, a second start exits 0 quietly. A stale file (dead pid) is overwritten.
- Exited sessions stay in the table, scrollback included, until a client sends `kill`
  for them (which on an exited session means "forget") or 24h pass.
- `SIGHUP` is ignored. `SIGTERM` exits only when no session is running; otherwise it
  logs and stays (SIGKILL is the override). `SIGINT` (foreground only) hangs up every
  session and exits. Uncaught errors go to `<HENRY_HOME>/sessiond.log`, never take the
  process down. A client disconnecting never affects a session.
- On Windows the PTYs are ConPTY (the one built into Windows; node-pty's bundled
  `useConptyDll` was tried and changes nothing that matters here) and node-pty refuses a
  signal name, so `kill` (any signal) terminates the process instead. The launcher is started
  with `--experimental-strip-types` (a no-op on Node ≥ 22.18) and `windowsHide`, so no
  console window appears for the detached process, and on Windows the daemon starts it
  through PowerShell's `Start-Process`: a child made by CreateProcess inherits the daemon's
  listening sockets, so a sessiond started by a daemon that was already serving (a respawn
  after `henry sessiond restart`) kept :14711 open after that daemon exited and every daemon
  after it failed with "Is port 14711 in use?" until sessiond exited. ShellExecute, which
  Start-Process uses, inherits nothing.
- `henry sessiond status` shows the file, whether it answers, and versions.
  `henry sessiond restart` asks it to exit once every session has ended (the daemon
  spawns a fresh one on its next connect); `--now` hangs up every session and exits.

## Protocol (`src/protocol.ts`, `PROTOCOL_VERSION = 1`)

NDJSON over TCP on `127.0.0.1:<port>`: one JSON object per line each way.

The first message on a connection must be `{op:"hello", token, protocolVersion}`;
anything else gets an `error` and the socket is closed. The reply is
`{op:"hello", protocolVersion, pid, sessions:[...]}`.

Client -> server:

| op | fields | effect |
|----|--------|--------|
| `spawn` | `id, command, args, cwd, env, cols, rows` | start a PTY; replies `spawned {id,pid}` or `error {id}` |
| `write` | `id, data` | keyboard input |
| `resize` | `id, cols, rows` | latest wins |
| `kill` | `id, signal?` | running: send signal (default SIGHUP; Windows: terminate); exited: forget it |
| `attach` | `id` | subscribe; server sends `scrollback {id,data}` then live `data` (and `exit` if already exited) |
| `detach` | `id` | unsubscribe |
| `list` | | replies `sessions` |
| `shutdown` | `when: "idle" \| "now"` | idle: exit when nothing runs; now: SIGHUP everything, exit |
| `ping` | | replies `pong` |

Server -> client: `hello`, `spawned`, `data`, `scrollback`, `exit {id, exitCode, signal?}`,
`sessions` (full table after any change), `error {id?, message}`, `pong`.

Session summary: `{ id, command, args, cwd, pid, cols, rows, status: "running"|"exited",
exitCode?, createdAt, endedAt? }`.

Any number of clients may attach to the same session; input from any of them is
written; the last resize wins. Scrollback is a 2 MB ring per session.

## Install note

node-pty's `postinstall` marks its `spawn-helper` binary executable, and bun only runs it
for packages listed in the root `package.json` `trustedDependencies`. sessiond also fixes
the bit at startup in case the postinstall was skipped.
