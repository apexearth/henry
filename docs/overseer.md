# The overseer and the playbook

A summariser at the user's altitude that never reads code.

- **Overseer runs at my altitude.** It reads Henry's event DB, git summaries, and the
  repo's `ACTIVE-WORK.md`. It never reads code. Two backends: Anthropic API with
  `claude-opus-5` when `ANTHROPIC_API_KEY` is present; otherwise headless
  `claude -p` on the subscription. Config picks; default is whichever works.

- **The overseer runs once per real turn, when it is turned on at all.** Stops with
  `stop_hook_active` (Claude sent back by another Stop hook) are ignored, and Stop-triggered
  runs for one session are at least `overseer.stopMinIntervalSec` (60) apart. Flags still
  run immediately. Both triggers default off; see config.md.

**The Playbook tab** is the overseer's running log for this session, newest first, plus a
"right now" summary at the top. Entries are written in a labeled shape (HEADLINE,
DOING, CHANGED/REPOS, CAREFUL, NEXT; `code` for repo/branch/file names) that
`parsePlaybookText` in shared turns into a headline, colored sections and bullets;
older entries collapse to their headline. A global playbook view across all
sessions lives on the rail footer.

- **The playbook ships off** (`overseer.onStop`/`onFlag` default `false`). Every entry is an
  LLM call after every turn, which is not worth paying for a panel the user may never open.
  The panel says so and offers the switch; asking the overseer a question works regardless.
