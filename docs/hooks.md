# Hooks, events and data flow

How Claude Code's hooks, status line and transcript reach the daemon, and what binds them to a session.

- **Henry never edits `~/.claude/settings.json` on its own.** `henry install`
  merges hooks + statusLine idempotently and preserves everything else.
  `henry uninstall` removes only what it added.

## Data flow

```
claude (in PTY) ──hooks──▶ henry-hook.sh ──POST /hook──▶ daemon ──▶ SQLite
                 ──status──▶ henry-statusline.sh ──POST /statusline──▶ daemon
~/.claude/projects/**.jsonl ──tail──▶ daemon (usage, tool detail, subagents)
~/code/*/.git ──watch+poll──▶ daemon (repo state, baseline diffs)
sessiond (owns PTYs) ◀──TCP 127.0.0.1, token──▶ daemon (spawn, write, attach, scrollback)
daemon ──WS──▶ every attached window (pty data, state deltas)
claude (in PTY) ──MCP /mcp?as=session──▶ daemon (henry_activity: what the other sessions hold;
                                                 henry_attention: come here, this one is timed)
daemon ──on Stop / on flag──▶ overseer ──▶ playbook rows ──WS──▶ windows
daemon ◀──ws://<tailscale ip>:14712/fed, mutually authenticated──▶ peer daemon (its sessions, relayed)
phone ──http://<tailscale ip>:14714, granted token in a cookie──▶ daemon (the same UI, /api and /ws)
```

Session identity: the daemon spawns `claude` with env `HENRY_SESSION=<uuid>`. Hook
payloads carry Claude's own `session_id`; the first hook event from a PTY binds the
two. The transcript file is `~/.claude/projects/<slug>/<session_id>.jsonl`.
