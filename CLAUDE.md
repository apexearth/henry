# Henry

Henry hosts the user's Claude Code sessions in a local daemon and visualizes what they do
across repos: git state, safeguard flags, subscription usage, and an overseer "playbook".
`README.md` covers running and installing.

## Documents

- `PLAN.md` is what is ahead: open items and what is ruled out. Nothing finished lives there.
- `docs/<area>.md` is how each part works today (index in `docs/README.md`). Read the one for
  the area you are touching before you touch it.
- `changelog/<YYYY-MM-DD>.md` is what shipped that day, one line per change.

When work ships: delete its item from `PLAN.md` if it had one, add a line to today's
changelog, and edit the area doc so the sentence that is now wrong says the new rule. Edit,
never append: no "before this…", no numbers from the investigation, no function names the
code already has. A doc that needs a new section is fine; a doc that grows on every change is
a changelog wearing the wrong name.

## Shape

- `packages/sessiond` owns the PTYs. Node + node-pty only, loopback TCP + token. Survives
  daemon restarts. **Keep it boring**: no new deps, no imports from the rest of Henry.
- `packages/daemon` (Bun) is the brain: HTTP/WS on 127.0.0.1:14711, SQLite in `~/.henry`,
  hooks ingest, transcript tailer, git watcher, rules, overseer. Restarts freely.
- `packages/ui` (Vite + React + xterm.js): rail | terminal | panels. Hot-reloads.
- `packages/shared`: types and the WS protocol. Change these first, then both sides.

## Working here

- `bun run dev` runs daemon + UI with reload; sessions keep running across daemon restarts.
- `bun run build` (zero TS errors) and `bun run test` must pass before you're done.
- **Never touch port 14711 or `~/.henry`** for testing: the user runs Henry live with real
  sessions. Use `HENRY_PORT=<free> HENRY_HOME=<scratch>` and stop processes by PID.
  `pkill -f` by pattern has killed the user's session once. Don't.
- Never edit `~/.claude/settings.json`; `henry install` is the user's explicit action.
- Observe and flag, never block. Rules must not return hook denies.
- Henry runs on macOS and Windows. Platform switches go in `packages/daemon/src/platform.ts`
  (and `hangup` in sessiond); everywhere else use `node:path`, never `"/"` string joins, and
  never assume `/bin/sh`, `$HOME`, `$SHELL` or POSIX mode bits.
- The overseer never reads source code or diffs, only summaries.

## Style

Be concise. Plain TypeScript, no ORMs or state libraries, comments only for non-obvious
decisions. Inline styles in panels; the UI has no design system yet.
