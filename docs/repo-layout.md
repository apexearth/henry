# Repo layout

```
henry/
  PLAN.md                    # what is ahead, and what is ruled out
  docs/                      # how each part works, one file per area (docs/README.md indexes them)
  changelog/                 # what shipped, one file per day
  package.json                 # bun workspaces
  packages/
    shared/                    # protocol + types shared by daemon and ui
      src/protocol.ts          # WS message union, REST shapes
      src/types.ts             # Session, RepoState, Flag, PlaybookEntry, Usage
      src/human.ts             # presence in whole minutes: hours, reading share, sit-downs, cadence
      src/qr.ts                # QR encoder (byte mode, ECC M, v1-6) for the phone's invite code
    daemon/
      src/index.ts             # cli: start | install | uninstall | status | sessiond status|restart
      src/server.ts            # HTTP + WS on 127.0.0.1:14711, serves ui/dist
      src/sessions.ts          # session records, reconciliation with sessiond, attach/detach
      src/sessiond-client.ts   # finds/starts sessiond, NDJSON over loopback TCP, reconnect
      src/sessiond-cli.ts      # henry sessiond status | restart [--now]
      src/federation.ts        # peer store, tailnet listener, pairing, inbound links, state merge
      src/fed-peer.ts          # outbound link: dial, mirror a peer's sessions, relay PTY + /api
      src/fed-crypto.ts        # identity keys, handshake, AES-GCM channel, pairing codes
      src/federation-cli.ts    # henry pair | peers [forget <name>]
      src/phone.ts             # the phone listener: granted devices, one-use invites, what a phone may ask for
      src/phone-cli.ts         # henry phone [invite | forget <name>]
      src/db.ts                # bun:sqlite schema + queries (~/.henry/henry.db)
      src/hooks.ts             # POST /hook, POST /statusline ingest
      src/transcript.ts        # tail ~/.claude/projects/**/<session>.jsonl
      src/git.ts               # repo discovery, worktrees, status, ahead/behind, diff, grep
      src/files.ts             # GET /api/file (one file, capped) and /api/fs/tree (a plain folder)
      src/prs.ts               # open PRs per checkout via `gh pr list`, cached and best-effort
      src/rules.ts             # ~/.henry/config.json rules → classify events
      src/mcp.ts               # POST /mcp: Henry's tools; henry_activity + henry_attention for hosted sessions
      src/attention.ts         # asks: a session calling for the user, with a deadline and a way to answer
      src/activity.ts          # working | needsInput | waiting | idle, derived from hooks
      src/engagement.ts        # my prompts + keystrokes per session: lastInputAt, prompt sparkline
      src/human.ts             # my minutes recorded + rolled up by local day (GET /api/human, POST /api/presence)
      src/overseer.ts          # playbook writer (api | claude-cli backend)
      src/installer.ts         # settings.json merge/unmerge
      src/screen.ts            # a headless xterm per session; attach is answered with its serialised buffer
      src/history.ts           # GET /api/history: a Claude session's turns, read from its transcript
      src/platform.ts          # the Windows switches: default shell, .cmd spawning, PATH key, shims
      hooks/henry-hook.sh      # tiny script installed into settings.json (henry-hook.mjs on Windows)
      hooks/henry-statusline.sh  # (henry-statusline.mjs on Windows)
    sessiond/                  # henry-sessiond: owns the PTYs, outlives the daemon (Node, node-pty only)
      src/main.ts              # TCP server, spawn/attach/kill, 2MB scrollback ring, drain/shutdown
      src/protocol.ts          # wire types, PROTOCOL_VERSION; the daemon imports this file
      README.md                # why it stays boring; the protocol
    ui/
      src/App.tsx              # picks the shape (dock or phone); the dock's top bar + Layout
      src/access.ts            # is this window allowed in: spend a QR's invite, or ask who we are
      src/Qr.tsx               # a QR matrix as one SVG path
      src/PhoneMenu.tsx        # topbar "phone": the QR, and the devices holding a token
      src/mobile/Mobile.tsx    # the phone shape: one session, rails as drawer + sheet, zoom
      src/mobile/Composer.tsx  # the phone's input: the keys a phone keyboard lacks, a line box, a mic
      src/mobile/dictation.ts  # Web Speech API, for hands-free input
      src/mobile/useMobile.ts  # which shape, the terminal's font size, the keyboard-aware height
      src/mobile/Gate.tsx      # what an ungranted device sees: how to get a QR
      src/TopActivity.tsx      # the strip: sessions, dirty repos, my hours/prompts/cadence + "you"
      src/presence.ts          # this window beating "I am here" while you read (POST /api/presence)
      src/Layout.tsx           # Dockview root; wraps rail, terminals and tools as panels
      src/dock.ts              # default layout, localStorage persistence, open/focus helpers
      src/ws.ts                # client, reconnect, state store
      src/Terminal.tsx         # xterm + webgl addon
      src/PrsMenu.tsx          # topbar open-PR count + the list behind it
      src/RepoPicker.tsx       # "+ new": typed picker over repos × {claude, terminal}
      src/FilePicker.tsx       # ⌘K: find a file to peek at
      src/FilesPane.tsx        # ⌘F / the Files tool: the folder tree, its filter and the search's toggles
      src/FilesRoot.tsx        # a root row of that tree: the repo card on one line, its log / PR folds and modals
      src/tree.ts              # flat paths -> a folder tree; collapsing, and a filter's ancestors
      src/match.ts             # fuzzy path matching + the glob box, shared by the tree and ⌘K
      src/FileView.tsx         # file peek (stage, with ⌘F find, edit + save) and the tree's preview
      src/Editor.tsx           # the peek's editor: CodeMirror 6 with the read view's colour classes
      src/panels/{History,Flags,Playbook,Usage}.tsx
      src/panels/bound.tsx     # those four wired to the store, for both the dock and the phone's sheet
      src/history.ts           # GET /api/history + the hook that refetches a session's turns
      src/DiffView.tsx
      src/GitTree.tsx          # repo modals: shell, commit graph (tree), one commit + patch
      src/demo/                # `?demo`: WebSocket + fetch swapped for a scripted daemon (world.ts, screens.ts)
  scripts/screenshots.ts       # docs/screenshots from ?demo, via the installed Chrome
  docs/screenshots/            # what the README shows (the only non-doc thing in docs/)
```
