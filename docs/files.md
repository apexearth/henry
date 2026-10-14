# Files: peeks, the tree, ⌘K and ⌘F

Looking at files without opening an editor, and the odd spec written without one.

**File peeks.** Files are things you glance at, not documents you keep open. ⌘-click a
path in terminal output (relative paths resolve against the session's cwd; on a phone a tap
does it) or a file header in a diff and the file opens read-only over the session, in the
same stage group (on a phone, as a full-screen sheet), with its own slim header (path, repo,
+added −deleted vs baseline, size, ×). A `path:line` reference
scrolls to and tints that line. The stage is a strip: the session at position 0, its peeks
to the right; ⌘←/→ walk it, Esc (or ×) closes the peek in view, and closing the last one
lands on the session that was showing. Peeks are per window, never restored with the
layout, served by `GET /api/file?path=&cwd=` (1 MB cap, binary detection). ⧉ in the header
pops a peek out into a window of its own (dockview's popout group on `/popout.html`: the
panel moves, the app's state stays shared, the theme follows); closing that window closes
the peek.

**Diffs show what is uncommitted**, against HEAD: once you commit, the change leaves the
diff, and what the session committed lives in its `+n` log instead. `GET
/api/file/diff?sessionId=&path=` returns the one-file unified diff (untracked files against
/dev/null; `sessionId` only routes it to the right machine); the peek tints added lines and
shows deleted lines as struck-through ghosts where they were.

**Markdown opens as a page.** A `.md` peek renders (`ui/Markdown.tsx`: marked, sanitized by
DOMPurify, code fences coloured by the same highlighter as the source view) with
```` ```mermaid ```` fences drawn as diagrams in the app's own colours; mermaid is loaded only
when a file has one. A diagram that will not parse shows mermaid's message over its source. A
relative link opens that file as another peek, a `#heading` link scrolls, anything else opens
in the browser, and a relative image is fetched through `/api/file` like the file itself, so a
relayed session's README shows its screenshots. The page fills the pane's width; on a phone it
is laid out at a desktop's 860px and zoomed out to fit, since prose reflowed to a phone's width
breaks tables and code. Zoomed out, a scroll box is too small to drag, so wide code and tables
run past the page and the whole pane scrolls sideways. A `page | split | source` switch in the header
picks the page, the line view, or both side by side scrolling on their own, remembered per
browser; a `path:line` reference opens as source, and ⌘F (find works on lines) shows the
source when the page was showing alone.

**A peek edits when you ask it to.** Most of the time you read here and write in the
session, but a spec you want to be exact about is quicker to type than to dictate, so the
header's `edit` swaps the source pane for an editor (`ui/Editor.tsx`: CodeMirror 6, loaded
the first time it is asked for, grammars on demand like the read view's and painted with the
read view's own colour classes, so the light shade and the syntax palette are one set of
rules). It has what an editor has — undo, multiple cursors, bracket pairs, folds, find and
replace on ⌘F, Tab indents — and nothing that knows the project: no completion, no lint.
Prose (markdown, plain text) wraps; code scrolls. A markdown peek in `split` shows the page of
what you are typing, a beat behind the keys. The text saves itself 0.6 s after the typing
stops (`⌘S` saves at once), because text that lives only in the window dies with it, and a dev
relaunch of the shell is enough to take it; a page going away inside that beat sends a last
keepalive save. Every save goes through `POST /api/file` carrying the mtime the peek read; a
file that has changed on disk since is refused with "changed on disk", `save anyway` and
`discard`, and autosave stops until you pick one, because a Claude session may be editing the
same file and its work must not vanish under yours. A CRLF file comes back CRLF.
An open peek follows the file: it reads it again when you come back to it, on any hook event
or repo change, and on window focus, and shows the new text when the mtime or size moved
(scroll kept; a clean editor reopens on it). Unsaved text is never replaced; its save is the
one refused. Esc,
`done` and × save unsaved text before they leave; only a refused save holds the peek and
points at `save` / `discard`. Clean, Esc leaves the editor and the next Esc closes the peek. Not on the phone,
and never for a peer's file: peers read (`federation.md`).

**The tree makes files.** Right-click a root, a folder, or a file (for the folder it is in)
and `new file in …` puts a name row under that folder; a name with slashes makes the folders
in between, `..` is refused, an existing name is refused by the daemon. The file is created
empty (`create: true` on the same `POST`) and opens straight in the editor, and the tree
re-reads its index at once rather than waiting out the 10 s cache. That is the whole of what
the tree changes: no rename, no delete, no folders on their own.

**HTML opens as a running page.** An `.html` peek is an iframe on `/raw/<path>`, which serves
the file from disk, so its relative CSS, scripts and pictures load the way they would from
file://; the same `page | split | source` switch (remembered apart from markdown's) and a ↻
that reloads it. The page is someone's code, so it never runs as Henry: every `/raw` answer
carries a CSP sandbox and the iframe omits `allow-same-origin`, which leaves it an opaque
origin, and the daemon refuses anything but `/raw` from `Origin: null`, so it can neither read
the API nor POST to it or open `/ws`. As on file://, that also means no ES modules or `fetch`
of the files beside it. Only on this machine's loopback listener: a relayed session's file is
on another disk, and on the phone the page's requests would go without the device cookie, so
both show the source.

**A PDF is drawn by pdf.js in a sandboxed frame, after you ask.** A file whose bytes start
`%PDF-` (whatever its name) is flagged in the peek and carries no content. The peek is an
iframe with `sandbox="allow-scripts"` and a fixed `srcdoc` (`ui/pdf.ts`), so it has an opaque
origin: Henry reads the bytes from `/raw` and posts them in with pdf.js's source, which the
frame imports from a blob URL of its own; a PDF that breaks pdf.js lands somewhere that cannot
reach the API. The browser's own viewer is not used because WebKit (the Tauri shell on macOS)
treats it as a plugin, and sandboxed frames get none. By default the peek shows a "view"
button first, so a stray click in the tree does not hand an unread file to the parser;
Settings → files turns that off, per browser. Zoom (25–400%, 100% fitting the pane's width)
is a slider in the header, or ⌘+wheel and pinch over the page: the frame forwards the wheel
to the peek, which owns the zoom and posts it back; pages resize at once and redraw sharp
when the zooming stops. Over each page lies pdf.js's text layer, invisible text in the
picture's place, so text selects and copies (links do not follow). ⌘F is the peek's find bar
as for any file; the frame searches that text (smart case, a line break counts as a space)
and marks the matches with the CSS highlight API, and Henry only shows the count. Keys pressed
inside the frame never reach Henry, so the frame passes on ⌘F, ⌘K and Esc. Same limits as
HTML: this machine's loopback only.

**An STL is a 3D view.** A file named `.stl`, binary or ASCII, opens as a part you can turn
(`ui/Model.tsx`, three.js, a chunk loaded only when one is shown): drag turns, right-drag
pans, the wheel zooms toward the cursor, and a double-click on the part makes that point the
centre of turning, which is how you get close to a detail. Iso, top, front and right views
(CAD's Z-up) each fit the part to the pane; feature edges (creases past 30°) are outlined unless
the part has more than 500k triangles; "wire" shows the mesh. Normals are recomputed from the
triangles, since exporters often write zeros. The corner gives the triangle count and the
bounding box in the file's own units. STL is triangles only, so it is parsed in Henry's page
with no sandbox; the bytes come from `/raw` with the same limits as a PDF. STEP is not shown:
it needs a CAD kernel (OpenCascade as WASM, several MB) to turn into triangles.

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
open-PR count when there is one (click: the list unfolds), then the icons — `±n` is the
dirty count and opens the uncommitted diff (unified/split), the graph mark opens the commit
graph of every branch as `git log --graph --all` draws it (`GET /api/repo/tree`, capped at
400 commits), `↗` opens the upstream remote's web page (scp/ssh/https git URLs become
https), and the folder mark opens the root in Explorer or Finder (a pinned folder has it too;
so does any folder, from the tree's right-click menu). Only for a window on this machine: not
for a peer's session or on the phone, and the daemon takes `POST /api/reveal` only from
loopback and only for a folder.
The path, the last commit and a worktree's parent live in the row's tooltip; a
worktree carries a `wt` tag. Any commit hash (tree rows, the log, a commit's parents) opens
that commit: metadata, message and its patch vs the first parent (`GET /api/repo/commit`).
Diff, tree and commit are full-screen modals over the app and stack; Esc closes the top
one. This replaced a Repos tab that showed the same facts as cards, in the column the tree
now uses for files; a saved layout's Repos slot becomes the Files slot on load. A plain
terminal's root has no card until a hook associates the session with the repo, as before.
