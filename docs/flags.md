# Rules and flags

Safeguard rules classify hook and git events; the Flags tab shows what fired.

- **Observe and flag, never block.** Henry's safeguard rules classify tool calls and
  git events as `info`, `notable`, or `alarm`. They never return a hook deny.

**The Flags tab** is the feed of `notable`/`alarm` events with an unread badge; each links back
to the tool call and the rule that fired.

**`rules.repos`** (config.md) is the per-repo override: keyed by repo path, matched against the **session's home
repo** (worktrees of it count), and laid on top of the global keys for events from that session.
A key that is set replaces the global value outright, so `"notable": []` mutes the list. The
off-chain repo is the reason it exists: work there routinely writes into sibling repos, and a
flag that fires on every session teaches you to ignore the badge.
