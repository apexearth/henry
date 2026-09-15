# Config (`~/.henry/config.json`)

- **First run asks for `reposRoot`.** Until config.json has one, every window shows a
  modal (no dismiss) explaining that Henry expects a single folder holding all repos as
  subfolders, with a live count of what it finds at the typed path. `POST /api/config
  {reposRoot}` validates the folder, writes it (and `defaultRepo`, unless already set) and
  broadcasts state with `firstRun: false`. Changing it later moves the outside-root
  boundary for running sessions.

- **Settings (⌘, or the topbar) is the editor for the rest.** The same `POST /api/config`
  takes a patch of any settable keys; only the keys present change, so two windows editing
  different sections do not clobber each other, and unknown keys are dropped. `port` is not
  settable from the UI — it would strand the window that asked. config.json stays
  hand-editable: the daemon watches it, hot-reloads, and broadcasts state either way.

- **History is swept to `retentionDays` (30).** Events, flags, playbook entries and usage
  snapshots older than the window go at startup and every 6h, and immediately when the
  setting shrinks; `0` keeps everything. Sessions are never swept — the rail owns their
  lifetime. The newest usage snapshot survives at any age, since it is the live 5h/7d bars.
- **The daemon can say what it is holding.** A process that runs for days is measured, not
  guessed at: `GET /api/debug/memory` (loopback only, never proxied, refused to peers and
  phones) reports RSS, the JSC heap, the top object types and the size of every long-lived
  collection a module keeps — screens, transcript tails, git watchers, links, asks — after a
  full collection when asked (`?gc=1`); `POST /api/debug/heap-snapshot` writes a
  Chrome-loadable snapshot into `~/.henry`; `henry status` prints the one-line summary.
  What it found first: Bun 1.2.19 on Windows kept ~1 KB of native memory (JS heap flat) for
  every `/hook` and `/statusline` request, 3.4 GB in a day of nine sessions; 1.4.2 holds
  flat over the same load, so 1.4.2 is the floor and the daemon warns at start when it is
  running on less. The transcript, PTY, git, federation and MCP paths all plateau.

```json
{
  "port": 14711,
  "host": "mbp",
  "reposRoot": "~/code",
  "defaultRepo": "~/code",
  "retentionDays": 30,
  "overseer": { "backend": "auto", "model": "claude-opus-5", "onStop": false, "onFlag": false, "stopMinIntervalSec": 60 },
  "mcp": { "enabled": true, "sessions": true },
  "federation": { "listen": "tailscale", "port": 14712 },
  "phone": { "listen": "tailscale", "port": 14714 },
  "files": { "roots": [] },
  "rules": {
    "protectedBranches": ["main", "master"],
    "alarm": ["git push --force", "git push -f", "git reset --hard", "rm -rf", "git branch -D", "git checkout -- ."],
    "notable": ["git push", "git rebase", "git merge", "git checkout", "git switch", "git worktree", "git stash", "gh pr"],
    "crossRepoWrite": "notable",
    "commitOnProtected": "alarm",
    "repos": { "~/code/off-chain": { "crossRepoWrite": "info" } }
  }
}
```
