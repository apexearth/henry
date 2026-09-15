# Staying cheap

The daemon watches and polls continuously, so every recurring cost has a ceiling and every
unbounded input is trimmed at the door.

- **Watchers cover `.git`, never the working tree**, and only for repos with a live session.
  A refresh is ~5 git processes behind a 300ms debounce, coalesced per common dir;
  `GIT_OPTIONAL_LOCKS=0` keeps our own `status` from rewriting the index and waking the
  watcher we just fired.
- **The 10s poll is a floor, not a promise.** A common dir whose refresh takes ≥250ms drops
  to 30s and ≥1s to 60s (`git.pollIntervalFor`): `status --untracked-files=all` is
  proportional to the untracked tree, and a big un-ignored build dir must not hold the whole
  daemon to a 10s cadence. fs.watch still reports those repos immediately.
- **A window hears about a repo when something moved.** A refresh that read the same
  branch, head, counts and dirty total as last time is no `repos:update`, and the ones that
  are due are coalesced per session over 300ms. A hook re-reads its repo at most every 5s;
  the `.git` watchers and the poll carry the rest. Before this, nine sessions hooking in one
  repo was several messages a second to every window, each a rail re-render, for nothing.
- **Hook payloads are capped at 32KB before storage and broadcast**, strings head-first at
  4KB each with the shape intact. Rules classify the whole payload first, so nothing is
  missed; what a 300KB screenshot response leaves behind is a readable head. Uncapped, this
  was ~19MB of SQLite for two days of use, all of it also crossing the WS to every window.
- **PR lists are read at most every 5 minutes per checkout** (15 after a failure), only for
  repos a live session is in, and never on the git refresh path: `git.ts` marks the cached
  list stale, the `gh` call runs on its own and re-broadcasts the cards if the count moved.
  The explorer's sweep of every repo under the root deliberately gets no PR counts — that
  would be one `gh` per repo. Worktrees of one repo are folded by remote before any total,
  so the same PR is never counted twice.
- **The transcript tailer reads 1MB per pass** and comes back through the event loop.
  A cold start begins at byte 0 and transcripts reach tens of MB; one synchronous pass would
  stall hooks and the WS for the length of the file.
