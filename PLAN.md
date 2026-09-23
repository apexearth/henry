# Henry — plan

Henry hosts my Claude Code sessions and shows me what is happening across repos,
branches, worktrees, and usage, so I am not in the dark. Terminal center stage,
sessions as tabs on the left, state on the right. Multiple windows may be open at
once, all attached to one daemon.

This file is what is *ahead*. How each part works today is in `docs/` (one file per area,
see `docs/README.md`); what shipped, and when, is in `changelog/` (one file per day). When
an item here is built it leaves this file, gets a line in that day's changelog, and the
area's doc is edited to say the new rule — edited, not appended to.

## Open

- **Henry as an interlocutor**: the overseer given the wide tool list and a conversation thread,
  so "what did I forget", "what is most urgent" and "which session was I doing xyz in" are
  asked rather than inferred from a panel. The voice slice of this is built, thread included
  (`docs/voice.md`); what remains is the tools and the index. Needs an FTS index over event
  summaries, prompts and playbook text (prompts are the highest-signal text), and a cheap
  daily digest, since a day's raw events answer "what did I focus on yesterday" neither in a
  prompt nor after the retention sweep. The chat runs only when asked, so unlike the playbook
  it can default on.
- **Voice, still to do**: word-level highlighting as Henry speaks (needs per-word timings,
  which no stock Kokoro ONNX export emits), and speaking Stop-hook answers unprompted.
- Git actions from the UI (commit, push, new worktree).
- Blocking rules (PreToolUse deny) once the observe-only picture is trusted.
- Replay of a session's history as a timeline.

## Ruled out

- **Cross-session writes.** A session leaving an advisory note for whoever comes next
  ("churning `packages/shared` for the next hour") is data and stays on the table. A session
  typing into another session's PTY, or steering it, is not: it would make the rail's
  attribution meaningless and put the daemon in the loop where the user is. Voice's `TELL:`
  and `OPEN:` stop at the prompt, unsent, for this reason (`docs/voice.md`).
