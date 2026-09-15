# History

The conversation behind a Claude session, read from its transcript.

**The History tab** is the conversation behind a Claude session, scrollable and searchable.
The terminal cannot hold it: Claude Code's TUI takes the alternate screen at startup
(`?1049h`, never released, mouse tracking on) and an alternate screen has no scrollback
by definition, so a resumed session has nothing above the frame to scroll back into.
The turns exist in the transcript the tailer already follows, so `GET /api/history`
reads its tail on demand (`daemon/src/history.ts`: stateless, no cache, ~400 turns) and
the panel renders prose in full, tool calls as one line each, and results folded until
clicked — a result matching the search unfolds itself. Subagent turns are marked and
hidden by default. On a phone, where the terminal is a porthole, this is the readable
view of what a session is doing.
