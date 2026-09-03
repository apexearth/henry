# Henry — plan

Henry hosts my Claude Code sessions and shows me what is happening across repos,
branches, worktrees, and usage, so I am not in the dark. Terminal center stage,
sessions as tabs on the left, state on the right. Multiple windows may be open at
once, all attached to one daemon.

Written 2026-09-02. This file is the contract the build follows. Update it when
the design changes; do not let it drift into a changelog.

## Decisions already made

- **Daemon owns the sessions, windows are clients.** PTYs live in the daemon (like
  tmux). Closing a window never kills a session. Several windows can attach to the
  same daemon and see the same tabs.
- **TypeScript end to end.** Bun runtime for the daemon, Vite + React + xterm.js for
  the UI. Agentic-first: the stack Claude writes and tests fastest.
- **Browser first, native later.** The daemon serves the UI at `http://127.0.0.1:4711`.
  A Tauri shell that loads that page is a later add, not part of this plan.
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
- **Spawned sessions never inherit `CLAUDE_CODE_*` / `CLAUDECODE` env.** A daemon
  started from inside a Claude Code session would otherwise pass the child-session
  marker through, which turns transcript saving off and breaks transcript-based
  plugin hooks (verified 2026-09-02: claude-mem's Stop hook looped on it).
- **Henry never edits `~/.claude/settings.json` on its own.** `henry install`
  merges hooks + statusLine idempotently and preserves everything else.
  `henry uninstall` removes only what it added.
- **New tab defaults to `~/code/off-chain`** with a picker over `~/code/*` and
  worktrees.

## Layout

```
┌──────────┬──────────────────────────────────────┬──────────────────────┐
│ sessions │                                      │ Repos│Flags│Play│Use │
│ ● off-ch │                                      │                      │
│   3 repos│         xterm.js (WebGL)             │  per-repo cards:     │
│   ⚑ 2    │         one per session              │  branch, ↑↓ upstream │
│ ○ arm    │                                      │  commits since base  │
│ ○ squid  │                                      │  diff viewer         │
│ + new    │                                      │                      │
└──────────┴──────────────────────────────────────┴──────────────────────┘
```

Right panel tabs:
- **Repos** — every repo this session has touched: branch, ahead/behind upstream,
  has-upstream, commits since session baseline, dirty count, worktree path.
  Click a repo → diff vs baseline (unified/split).
- **Flags** — feed of `notable`/`alarm` events with unread badge; each links back
  to the tool call and the rule that fired.
- **Playbook** — the overseer's running log for this session, newest first, plus a
  one-paragraph "right now" summary at the top. A global playbook view across all
  sessions lives on the rail footer.
- **Usage** — 5h and 7d utilization bars with reset times; per-session token and
  cost totals.

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
      src/index.ts             # cli: start | install | uninstall | status
      src/server.ts            # HTTP + WS on 127.0.0.1:4711, serves ui/dist
      src/sessions.ts          # PTY manager (node-pty), scrollback, attach/detach
      src/db.ts                # bun:sqlite schema + queries (~/.henry/henry.db)
      src/hooks.ts             # POST /hook, POST /statusline ingest
      src/transcript.ts        # tail ~/.claude/projects/**/<session>.jsonl
      src/git.ts               # repo discovery, worktrees, status, ahead/behind, diff
      src/rules.ts             # ~/.henry/config.json rules → classify events
      src/overseer.ts          # playbook writer (api | claude-cli backend)
      src/installer.ts         # settings.json merge/unmerge
      hooks/henry-hook.sh      # tiny script installed into settings.json
      hooks/henry-statusline.sh
    ui/
      src/App.tsx              # rail | terminal | panel
      src/ws.ts                # client, reconnect, state store
      src/Terminal.tsx         # xterm + webgl addon
      src/panels/{Repos,Flags,Playbook,Usage}.tsx
      src/DiffView.tsx
```

## Data flow

```
claude (in PTY) ──hooks──▶ henry-hook.sh ──POST /hook──▶ daemon ──▶ SQLite
                 ──status──▶ henry-statusline.sh ──POST /statusline──▶ daemon
~/.claude/projects/**.jsonl ──tail──▶ daemon (usage, tool detail, subagents)
~/code/*/.git ──watch+poll──▶ daemon (repo state, baseline diffs)
daemon ──WS──▶ every attached window (pty data, state deltas)
daemon ──on Stop / on flag──▶ overseer ──▶ playbook rows ──WS──▶ windows
```

Session identity: the daemon spawns `claude` with env `HENRY_SESSION=<uuid>`. Hook
payloads carry Claude's own `session_id`; the first hook event from a PTY binds the
two. The transcript file is `~/.claude/projects/<slug>/<session_id>.jsonl`.

Baseline: when a session first touches a repo (first hook event whose cwd or file
path resolves into it), record `HEAD` as that session's baseline for that repo.
"Commits since" and the diff are against that ref.

## Config (`~/.henry/config.json`)

```json
{
  "port": 4711,
  "reposRoot": "~/code",
  "defaultRepo": "~/code/off-chain",
  "overseer": { "backend": "auto", "model": "claude-opus-5", "onStop": true, "onFlag": true, "stopMinIntervalSec": 60 },
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

- Tauri shell for native windows.
- Git actions from the UI (commit, push, new worktree).
- Blocking rules (PreToolUse deny) once the observe-only picture is trusted.
- Replay of a session's history as a timeline.
