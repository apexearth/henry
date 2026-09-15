# Git and pull requests

Per-session baselines, repo state, and the one place Henry reaches past the machine.

- **Open PRs come from `gh`, and only from `gh`.** The count on a repo card and the topbar
  chip are `gh pr list` for the checkout's github.com remote: no GitHub token of Henry's own,
  no new dependency, nothing stored. It is the one place the daemon reaches past the machine,
  so it is cached 5 min per checkout (15 min after a failure), capped at 100 PRs, killed after
  15s, and silent when `gh` is missing or the repo is invisible to the user's auth — a repo
  card simply has no PR badge then. Read-only: Henry never opens, merges or comments.

Baseline: when a session first touches a repo (first hook event whose cwd or file
path resolves into it), record `HEAD` as that session's baseline for that repo.
"Commits since" and the diff are against that ref.
