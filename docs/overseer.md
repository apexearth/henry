# The model backend

What Henry asks on its own behalf: voice answers, spoken notices, PR summaries and "fill from
sessions" (notes.md). `daemon/src/overseer.ts` holds it.

- **It stays at the user's altitude.** Callers hand it event lines, flags, repo-level git state,
  prompts and replies. Never source code or diffs.
- **Two backends.** The Anthropic API (`claude-opus-5` unless a caller names a cheaper model)
  when `ANTHROPIC_API_KEY` or `overseer.apiKey` is set; otherwise headless `claude -p` on the
  subscription, with every tool, hook, CLAUDE.md and MCP server off, in a neutral temp folder.
  `overseer.backend` picks; `auto` takes whichever works.
- **Nothing calls it on a timer or after every turn.** Each call is something you asked for (a
  question, a fill, a PR card) or something you switched on (`voice.announce`). Henry's cost
  ceilings are in cost.md.
