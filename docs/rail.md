# The rail

One line per session on the left: titles, order, grouping, hiding.

- **The rail is one line per session, titled by the terminal.** The daemon watches each
  PTY for OSC 0/2 title sequences and stores the latest as the session title, so `/rename`
  in Claude Code (which retitles the terminal) renames the rail entry; the transcript's
  `custom-title` line does the same for external sessions. A leading status glyph is
  dropped. The repo name shows dimmed beside the title when they differ; cwd, host and
  shortcut live in the tooltip. Running sessions come first (oldest first); exited ones
  are hidden until the footer's "N closed" is opened, then listed below, newest exit
  first. The exited session you are looking at stays listed. Closing an exited session
  (×) sets `dismissed_at` in the DB: it never returns after a daemon restart, but its
  events, flags and playbook stay. `⌘1..9` (or `Ctrl`) and `⌘↑/↓` follow the rail order;
  `⌃N` (⌘N where the browser frees it) opens the "+ new" picker; `⌘D` duplicates the active
  tab, a new session of the same kind in its cwd, skipping the picker. No `⌃D`: that is EOF
  in the terminal. `⌘\`` (`⌃\`` in a browser tab, which never sees macOS's window-cycling
  chord) opens a terminal in the active tab's cwd on its machine, whatever kind that tab is.
- **Grouping is a rail-footer choice, persisted per browser.** Off by default; "by folder"
  buckets sessions on `cwd`, "by repo" on the repos the git watcher has seen the session
  touch, so a session working across two repos is listed under both (one that has touched
  none falls into a last "no repo" bucket). Machines are split before any of that: this
  machine's sessions first, then each paired peer's under a delimiter bearing its name, with
  the chosen grouping applied inside each (no delimiters at all while every session is
  local). Order within a group, and the keyboard order,
  stay the running-then-exited rail order. The active *row* is the one you picked (session
  plus group): it alone gets the full highlight, the same session's rows under other repos
  get a half-strength bar, and `⌘↑/↓` step from the picked row, not its first echo.
  A repo name is coloured by a hash of the name wherever it appears (group headers, row
  sub-labels, the Files tool, the new-session picker), so one repo is one
  colour across grouping modes, restarts and machines; "no repo" and the attention groups stay grey.
- **Hiding is by hand, and always reversible.** Hovering a row or a group header shows a ⊘:
  clicking it takes those sessions out of the list and out of the ⌘1..9 order, killing nothing.
  Hiding is per session, not per row, so a session hidden from one repo group leaves the others
  too. A line above the list counts what is hidden and brings it all back ("show all"), so a
  session can never be lost behind it. Persisted per browser, pruned to sessions the daemon
  still knows.
