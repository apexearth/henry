# Files: peeks, the tree, ⌘K and ⌘F

Looking at files without opening an editor.

**File peeks.** Files are things you glance at, not documents you keep open. ⌘-click a
path in terminal output (relative paths resolve against the session's cwd) or a file header
in a diff and the file opens read-only over the session, in the same stage group, with its
own slim header (path, repo, +added −deleted vs baseline, size, ×). A `path:line` reference
scrolls to and tints that line. The stage is a strip: the session at position 0, its peeks
to the right; ⌘←/→ walk it, Esc (or ×) closes the peek in view, and closing the last one
lands on the session that was showing. Peeks are per window, never restored with the
layout, served by `GET /api/file?path=&cwd=` (1 MB cap, binary detection).

**Changes are shown against the session's baseline**, not HEAD: that is the Henry question
("what did this session do"). `GET /api/file/diff?sessionId=&path=` returns the one-file
unified diff (untracked files against /dev/null); the peek tints added lines and shows
deleted lines as struck-through ghosts where they were. A session with no baseline (a plain
terminal) diffs against HEAD, so "changed" means "uncommitted" there.

**Markdown opens as a page.** A `.md` peek renders (`ui/Markdown.tsx`: marked, sanitized by
DOMPurify, code fences coloured by the same highlighter as the source view) with
```` ```mermaid ```` fences drawn as diagrams in the app's own colours; mermaid is loaded only
when a file has one. A diagram that will not parse shows mermaid's message over its source. A
relative link opens that file as another peek, a `#heading` link scrolls, anything else opens
in the browser, and a relative image is fetched through `/api/file` like the file itself, so a
relayed session's README shows its screenshots. A `page | split | source` switch in the header
picks the page, the line view, or both side by side scrolling on their own, remembered per
browser; a `path:line` reference opens as source, and ⌘F (find works on lines) shows the
source when the page was showing alone.

The tree's marks are the exception: they are `git status`, against HEAD, so every session in
a folder sees the same marks and a clean repo shows none. Before this they were vs baseline
too, and a commit never cleared them: the tree said "uncommitted" next to a root card saying
`±0`, and each session in a shared repo showed a different wall of marks, because "changed
since my baseline" in a repo several sessions work in is everyone's commits since this one
began, not what this one did. The files answer still carries those (flagged `committed`) so
⌘K can list them first, with a muted mark; the tree ignores them.

**Files is the first tool tab, and it is the repo view.** The tree follows the session you are
in, so it belongs with the other per-session tools on the right rather than in the rail: it
took the Repos tab's slot, and each repo's root row carries what that tab's card said (branch,
↑↓, dirty, diff / tree / remote — see the Files tab at the end of this page). For a while the tree shared the left pane
with the session list behind a `Sessions | Files` switch; that spent the rail's 220px on a
tree that wants 360, and hid the list while you read. Esc in the filter puts the keyboard back
in the terminal.

**⌘K finds a file to peek at.** Changed files of the session you are looking at come first,
then recent peeks (per browser, last 40), then, once you type, every file in that session's
repos (the one its cwd is in first) and finally other sessions' repos, fuzzy-matched on the
path with a bias to file-name hits. `GET /api/repo/files?repo=` is `git ls-files` incl.
untracked, cached 10 s. ⌃K works too, except in the terminal where it stays kill-line.

**⌘F is a folder tree, so Zed stays closed.** ⌘K is for a file you can name; ⌘F is for
looking around, and looking around means seeing the shape of the thing. The pane's **roots**
are the repos of the session you are in — read from `GET /api/session/files`, not the git
watcher's session→repo map, because that map is built from hook events and a plain terminal
fires none, so a shell sitting in a repo would otherwise show an empty tree; that endpoint
falls back to the repo the cwd is in and returns each file's status in the same answer.
Under each root, `GET /api/repo/files` (`git ls-files`, .gitignore for free) is nested into a
tree client-side (`ui/tree.ts`), with single-child directory chains collapsed onto one row —
`packages/ui/src` as one line is the difference between a readable tree and eight rows of
scaffolding in a 360px column. Uncommitted files carry their status letter in place; a `●`
toggle prunes to them, which is what the old changed-files list became. Only expanded
directories render, so no virtualization is needed. Local repos and a peer's alike: every
request carries the machine of the session you are looking at.

**The filter narrows the tree, not into a list.** Matching files keep their ancestor folders
and the tree opens itself onto them, because *where* a match sits is half of what you asked.
Tab flips the filter between file names (fuzzy, client-side, `ui/match.ts` — shared with ⌘K
rather than copied into it) and file contents. Contents are `GET
/api/repo/grep?q=[&repo=…][&case=][&regex=][&word=][&glob=]`: `git grep` over the named roots,
repeated `repo=` for each, or every checkout under the repos root when the footer's "widen"
is pressed. git rather than ripgrep because git is the one tool Henry already needs on every
machine. Hits render as the same tree — folders, then files carrying a hit count, unfolding to
their lines with the match marked; up to 40 hits every file is already open, past that they
start folded, so a broad search stays scannable. Capped at 500 hits, long lines windowed on
the daemon, typing debounced, stale answers dropped.

**The search has the knobs a search needs**, all persisted per browser: `Aa` exact case
(otherwise smart case, as before), `.*` regex (`-E` instead of `-F`), `ab|` whole word (`-w`),
and a glob box (`*.ts,!*.test.ts`) that becomes a git pathspec for the text search and filters
the tree for the name one. Defaults are off, so the old literal smart-case search is exactly
what a caller passing nothing still gets. **An unbalanced regex is an answer, not an
exception**: `git grep` exits 128, and `GrepResult.error` carries git's own words to the pane,
because a half-typed pattern reading as "no matches" is a lie.

**Pinned roots are config, not view state.** `files.roots` in `config.json` (settable through
`POST /api/config`, `~` expanded on load) holds folders worth reading that no session has
touched; "+ folder" adds one, a hover `×` removes it. A pinned folder that holds no repo is
walked by `GET /api/fs/tree?path=` instead — one bounded breadth-first pass skipping `.git`,
`node_modules`, `target`, `dist` and their kin, capped at 20 000 entries, cached 10 s, saying
so when it truncates. It does not read `.gitignore` (there is no repo to read it from), while
`git grep --no-index --exclude-standard` searching that same folder does.

**⌘F over a peek finds in that file.** ⌘F stays contextual: over a file peek in view it is
find-in-file — a bar under the peek header, smart case, ↩/⇧↩ walk the matches, matched lines
show the term marked (and lose syntax colour for it), Esc closes the bar before it closes the
peek. Anywhere else ⌘F opens the files tree with the keyboard in its filter. ⌘⇧F is the tree's
content search regardless, carrying the peek's find term along, so "this word, but everywhere"
is one key. ⌃F works outside the terminal, where it stays forward-char.

**The Files tab** is the folder tree of every repo this session has touched (⌘F above), where
each repo's root row is also its card, on one line: name, branch, `↑n ↓n` against the upstream (only the non-zero side; `↑∅` when there is no upstream),
`+n` commits since the session baseline (click: the log unfolds under the row), the
open-PR count when there is one (click: the list unfolds), then three icons — `±n` is the
dirty count and opens the diff vs baseline (unified/split), the graph mark opens the commit
graph of every branch as `git log --graph --all` draws it (`GET /api/repo/tree`, capped at
400 commits), `↗` opens the upstream remote's web page (scp/ssh/https git URLs become
https). The path, the last commit and a worktree's parent live in the row's tooltip; a
worktree carries a `wt` tag. Any commit hash (tree rows, the log, a commit's parents) opens
that commit: metadata, message and its patch vs the first parent (`GET /api/repo/commit`).
Diff, tree and commit are full-screen modals over the app and stack; Esc closes the top
one. This replaced a Repos tab that showed the same facts as cards, in the column the tree
now uses for files; a saved layout's Repos slot becomes the Files slot on load. A plain
terminal's root has no card until a hook associates the session with the repo, as before.
