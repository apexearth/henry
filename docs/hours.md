# Your hours

Time you spent in Henry, counted in whole minutes.

**Your hours are counted in whole minutes, and reading counts.** A minute is yours if there
is evidence you were there for it, and there are three kinds of evidence (`SRC` in
`shared/human.ts`): a **prompt**, a **keystroke into a terminal**, or **reading** — a Henry
window that is visible, focused and touched within the idle window, beating `POST /api/presence`
every 30 s (`ui/presence.ts`). Sitting with a diff open, walking a repo tree, watching a turn
run: all of it is time spent, and none of it produces a prompt, so the beat is the only way it
can count. Prompts also *imply* minutes — every minute between two prompts less than 15 apart
(`IDLE_MS`) — which back-fills days from before any of this existed and sessions driven from a
terminal Henry never sees. The two sets are unioned per minute, so nothing double-counts, and
a minute knows which kinds it had: "3h 12m here, 1h 40m of it reading." Implied minutes are
waiting, not typing, and prompts Claude Code sends itself (task notifications, subagent
hand-backs) are not evidence of you at all.
  The row in the `presence` table is `(minute, mask)` and nothing else — never the panel, the
file, the repo or the keystroke. Beats bridge at most two minutes of silence since the last
one, so a missed beat is not a hole but an hour away is not credited. `daemon/human.ts` groups
minutes and prompts into local days for `GET /api/human`, which also ships today's minutes
packed as 1440 hex digits; the UI re-runs the same shared functions with the minute you are
currently in added, which is what keeps the clock moving without a round trip. Retention
sweeps presence with everything else. Honest limits, all stated in the popover: an untouched
window stops counting after 15 minutes, work outside Henry never counts, and a stretch across
midnight is split by the day line.
