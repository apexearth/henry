# Git, pull requests and `#157`

Per-session baselines, repo state, and the places Henry reaches GitHub.

- **GitHub comes through `gh`, and only through `gh`.** No GitHub token of Henry's own, no new
  dependency; every call is cached, killed after a timeout, and silent when `gh` is missing or
  the repo is invisible to the user's auth. Read-only: Henry never opens, merges or comments.
- **Open PRs** on a repo card and the topbar chip are `gh pr list` for the checkout's
  github.com remote, cached 5 min per checkout (15 min after a failure), capped at 100 PRs.
- **`#157` in a terminal is a link to what it means.** Where the session has a GitHub repo, a
  number written `#157` is underlined; hovering it (on a desk) or clicking or tapping it opens a
  card with the item's state, title, project fields (Status, Priority, …), labels, assignees and
  the head of its body. A number is looked for in the session's repos (the one it started in
  first) and in the projects `config.github.repos` lists for them, since a project spans repos
  and most numbers a session names are project items. Henry writes a repo's entry the first time
  a session works there, from the open projects the repo is linked to on GitHub, and never
  rewrites one that exists: edit it, or set `[]`, and it sticks. Boards are read whole (a page
  per 100 items) and cached 5 min.
- **When more than one repo has the number, a small model picks.** The card draws at once with
  the session's own repo first, then asks again with `pick=1`: `config.github.pickModel` (Haiku)
  gets the candidates' titles and fields and the few terminal rows around the mention, through
  the overseer's backend, and answers which one. The others stay listed under the card. Without
  a backend the order stays and the card says so.

Baseline: when a session first touches a repo (first hook event whose cwd or file
path resolves into it), record `HEAD` as that session's baseline for that repo.
"Commits since" is against that ref; the diff is not (it is uncommitted changes, vs HEAD).
