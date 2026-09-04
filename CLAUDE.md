# Henry

Henry hosts the user's Claude Code sessions in a local daemon and visualizes what they do
across repos: git state, safeguard flags, subscription usage, and an overseer "playbook".
Read `PLAN.md` first; it is the design contract. `README.md` covers running and installing.

## Shape

- `packages/sessiond` owns the PTYs. Node + node-pty only, loopback TCP + token. Survives
  daemon restarts. **Keep it boring**: no new deps, no imports from the rest of Henry.
- `packages/daemon` (Bun) is the brain: HTTP/WS on 127.0.0.1:4711, SQLite in `~/.henry`,
  hooks ingest, transcript tailer, git watcher, rules, overseer. Restarts freely.
- `packages/ui` (Vite + React + xterm.js): rail | terminal | panels. Hot-reloads.
- `packages/shared`: types and the WS protocol. Change these first, then both sides.

## Working here

- `bun run dev` runs daemon + UI with reload; sessions keep running across daemon restarts.
- `bun run build` (zero TS errors) and `bun run test` must pass before you're done.
- **Never touch port 4711 or `~/.henry`** for testing: the user runs Henry live with real
  sessions. Use `HENRY_PORT=<free> HENRY_HOME=<scratch>` and stop processes by PID.
  `pkill -f` by pattern has killed the user's session once. Don't.
- Never edit `~/.claude/settings.json`; `henry install` is the user's explicit action.
- Observe and flag, never block. Rules must not return hook denies.
- Henry runs on macOS and Windows. Platform switches go in `packages/daemon/src/platform.ts`
  (and `hangup` in sessiond); everywhere else use `node:path`, never `"/"` string joins, and
  never assume `/bin/sh`, `$HOME`, `$SHELL` or POSIX mode bits.
- The overseer never reads source code or diffs, only summaries.
- Update `PLAN.md` when a design decision changes. It is not a changelog.

## Style

Be concise. Plain TypeScript, no ORMs or state libraries, comments only for non-obvious
decisions. Inline styles in panels; the UI has no design system yet.
