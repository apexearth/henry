# Usage

Subscription windows, per-session tokens and context, and where they are shown.

- **Usage = % toward subscription limits.** Source: the statusline JSON Claude Code
  hands to a status command carries `rate_limits.five_hour` / `seven_day`
  utilization (verified in build 2.1.259). Henry's installed status command posts
  that JSON to the daemon. Token/cost totals per session come from the transcript
  JSONL `usage` fields as a secondary view. A window is sent a row when that row changes
  (`usage:session`), never the table for one session's numbers: the table (`usage:update`)
  travels only when the 5h/7d windows move, which is a few times an hour, and a snapshot row
  is written on the same occasions plus a five-minute heartbeat rather than per statusline
  post. With dozens of sessions the old way was ~25 KB every two seconds to every window and
  phone, all day, and twenty thousand identical rows a day.

**Usage lives in the status strip**, one line along the bottom of the window, outside the
dock. The gauges are things you watch while working, not a view you switch to, so they get
the place a window's status bar has always been: left, the session you are looking at (model,
context meter, tokens in/out, spend); right, the 5h and 7d windows with their resets, one
pair per paired machine, the machine you are working on first and named when there is more
than one. The session's own numbers give way first when the strip runs out of room. Every
item opens the Usage tab, which keeps the per-session table and the words. Usage used to have
a pane of its own in the bottom-right corner; a pane costs the tool column height for a few
numbers, and a strip costs 22px of everything.

**The Usage tab** shows 5h and 7d utilization bars with reset times, a pair per machine under its
name once a peer is connected; the active session's context bar (occupancy vs. window);
per-session token, context and cost totals. The status strip shows the same numbers for
the active session and the windows, so the tab is for the table and the other sessions.
Context costs nothing extra: it is the last main-chain assistant message's input +
cache tokens, which the transcript tailer already parses (statusline
`context_window` fills in until the first turn and supplies the window size).
