# Topics and their coordinators

Several sessions on one subject, kept aware of each other by a session that sits above them.
`daemon/src/topics.ts` holds the rules, `daemon/src/coordinator.ts` the coordinator's tools.

- **A topic is a named set of sessions you make.** It has a brief (goal, decisions, who owns
  what, what is off-limits) and notes: single lines that can expire ("churning
  `packages/shared` for the next hour"). A session is in at most one topic; shells and
  one-offs are usually in none, and "no topic" is a normal place to be. Brief, notes and
  membership live in SQLite and survive restarts. Closing a topic
  stops its coordinator, leaves its running sessions in no topic, and keeps the row.
- **A topic runs on one machine**, which you pick when you make it: its coordinator runs there
  and its members are that machine's sessions, since the coordinator reads summaries only that
  daemon holds. A paired machine's topics are relayed like its sessions (tagged `peer`), so
  every window sees every connected machine's topics and drives them through the link: make,
  rename, brief, join, start a coordinator, close. Names are unique per machine. Trust stays
  non-transitive: a peer cannot reach a third machine's topics through this one.
- **Every topic has a coordinator**, a Claude session Henry starts when the topic is made. It
  runs in `<henry home>/coordinator`, one folder for all of them so Claude Code asks to trust
  it once, with `--append-system-prompt-file` (its standing instructions, `COORDINATOR_PROMPT`)
  and `--disallowed-tools` for every file, shell and subagent tool. It works from summaries,
  like voice and notes filling: prompts, activity, files written, git state, commits, last replies. Never
  source or diffs. Resuming an exited coordinator makes it the coordinator again, flags and
  all, unless the topic already has one running; a fork of one is not a coordinator. The rail
  names a coordinator after its topic, since Claude Code retitles the terminal as it likes.
- **Its tools are served to coordinators only.** Every hosted session shares one
  `launch-mcp.json`, so `mcp.ts` decides by who is calling: a coordinator gets the session list
  plus `henry_topic` (the topic, its members, sessions in no topic, other topics' briefs),
  `henry_session` (one session's recent prompts and last reply), `henry_brief`,
  `henry_membership` and `henry_prompt`. Ordinary sessions pay nothing for them.
- **Members learn of the topic without a tool.** When the brief, the notes or the member list
  changed since a member's last prompt, the `UserPromptSubmit` hook answers with
  `additionalContext`: the topic's name, the brief, the notes and who else is in it, labelled
  as background rather than a request. Other members' activity is in the text but does not
  count as a change, or every prompt would carry it. The hook scripts print the daemon's answer
  only when it is hook output, so an older daemon's `{"ok":true}` never reaches Claude Code.
- **A coordinator's prompt is a draft unless you said to send it.** `henry_prompt` types into a
  member's input, prefixed `[from the "<topic>" coordinator; your reply goes back to it]`, so the
  member's transcript says where it came from. `send` submits it; its description, and the coordinator's instructions,
  say to set it only when your message asked for it. Either way it goes in only between turns
  (`waiting` or `idle`): typing into a running turn or a permission prompt would answer
  something nobody meant to. Until then it queues, three at most, for 30 minutes. It goes
  through `relaySafe` like a voice relay, so it can never carry its own Enter, and members only:
  a coordinator cannot reach another topic's sessions.
- **A turn the coordinator started answers back.** When a member's prompt starts with that
  prefix (sent by the coordinator, or a draft you sent with Enter) and the turn ends, the
  member's last reply goes into the coordinator's input as `[reply from "<member>" [<id>] to your
  prompt] …`, between the coordinator's turns like any prompt, eight at most waiting. It is
  submitted, since the coordinator asked; the coordinator's instructions say a reply is the
  member's answer, never the user's word to send anything on. A topic's replies past twelve in
  an hour go in as drafts instead, so a coordinator and a member cannot drive each other all
  night. A turn you start in a member is yours and sends nothing back.
- **Membership changes only when you ask.** A coordinator adds or removes a session when your
  message says to; otherwise it suggests, and the rail shows `→ <topic>?` on that row until you
  accept (it joins) or dismiss it (that suggestion never comes back). Only running Claude
  sessions in no topic can be suggested.
- **In the rail**, "by topic" lists each machine's open topics under that machine, coordinator
  first (◆), then its "no topic".
  Empty topics still show, so one whose coordinator exited can be opened. The header opens the
  topic: rename it, edit the brief, see the notes and members, start a coordinator, close it.
  A row's right-click menu adds it to a topic, moves it, takes it out, or starts a new topic
  with it, offering only topics on the row's own machine; "+ topic" sits beside "+ new session"
  in that grouping and, like "+ new", offers the connected machines to make it on.
