# How Henry works

One file per area, present tense, each short enough to read before touching that area.
A changed decision edits the sentence that is now wrong; nothing here is a history.
`PLAN.md` is what is ahead; `changelog/<day>.md` is what shipped.

- [sessions.md](sessions.md) — the daemon owns sessions, sessiond owns PTYs, what a spawned `claude` gets
- [platform.md](platform.md) — Bun/Vite/xterm, the Tauri shell, ports, the Windows switches
- [rail.md](rail.md) — one line per session: titles, order, grouping, hiding, shortcuts
- [activity.md](activity.md) — working / needsInput / waiting / idle, and your engagement with a session
- [hooks.md](hooks.md) — hooks, statusline, transcript tailer, data flow, session identity
- [git.md](git.md) — per-session baselines and open PRs via `gh`
- [flags.md](flags.md) — safeguard rules (observe, never block), per-repo overrides, the Flags tab
- [usage.md](usage.md) — 5h/7d windows, per-session tokens and context, the status strip
- [overseer.md](overseer.md) — the playbook writer: altitude, backends, cadence, off by default
- [tools.md](tools.md) — the MCP server: `henry_activity`, `henry_attention`, and why nothing more
- [federation.md](federation.md) — daemon-to-daemon links over the tailnet, pairing, keys, trust
- [phone.md](phone.md) — the phone listener, invites, the mobile shape, touch and the composer
- [voice.md](voice.md) — push-to-talk questions, directives, TTS, what voice may and may not do
- [layout.md](layout.md) — the dock, the stage, the topbar, the theme and the context wall
- [files.md](files.md) — peeks, diffs, the folder tree, ⌘K, ⌘F and search
- [history.md](history.md) — a session's conversation, read from its transcript
- [hours.md](hours.md) — your time in Henry, in whole minutes
- [cost.md](cost.md) — ceilings on every recurring cost
- [config.md](config.md) — `~/.henry/config.json`, first run, settings, retention, memory debug
- [repo-layout.md](repo-layout.md) — what each file in the repo is for
