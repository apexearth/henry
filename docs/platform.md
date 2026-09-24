# Stack, shell, ports and Windows

What Henry is built on, how it is served, which ports it takes, and what differs on Windows.

- **TypeScript end to end.** Bun runtime for the daemon, Vite + React + xterm.js for
  the UI. Agentic-first: the stack Claude writes and tests fastest.
- **Browser or native, same page.** The daemon serves the UI at `http://127.0.0.1:14711`.
  `packages/shell` is a Tauri window on that URL and nothing else: no IPC, no state, no
  bundled frontend. It exists for the macOS menu, since a browser tab never sees ⌘N or
  ⌘1..9. Menu items reach the page as `henry:menu` CustomEvents. On Windows the shell has
  no menu bar: wry turns WebView2's browser accelerators off, so the page's own bindings
  see every Ctrl chord and the bar would only cost a row. The webview cannot make a window
  by itself, so Rust answers every `window.open`: the page's own `/popout.html` (a
  popped-out peek) gets a linked Tauri window built from the webview's features, so the
  page keeps its handle on it; anything else, a `target="_blank"` link (the repo's ↗, a PR
  number), goes to the default browser.
  Both front ends run at once against the one daemon. `bun run dev` (scripts/dev.ts) runs daemon, Vite and the shell
  together: the shell is the debug cargo build with `HENRY_URL` on the Vite page so it
  hot-reloads, rebuilt and reopened on edits under `src-tauri`. Each child is supervised
  with a debounced restart (1s doubling to 15s, reset after a stable run); the servers
  come back from any exit, the window only from a crash, since closing it is deliberate.
- **Ports nobody else wants.** Daemon 14711, federation 14712, Vite dev 14713, phone 14714. Henry sits
  next to whatever the user is developing, so it stays off 3000/5173/8080 and their
  neighbours, off IANA-registered numbers, and below 32768 so no OS's ephemeral range can
  land an outbound connection on it. `HENRY_PORT` overrides the daemon port everywhere
  (daemon, hooks, Vite proxy, shell).
- **The running daemon publishes its port; hooks read it, not their environment.** A PTY
  outlives the daemon, so the `HENRY_PORT` in a session's environment is only true until the
  daemon moves — when Henry left 4711 for 14711, every session started before the move went
  on posting hooks into a dead port, silently, until it was restarted. So the daemon writes
  its bound port to `<henry home>/port` (plain text, one integer) at startup, and all four
  hook entry points resolve the daemon as: that file, else `$HENRY_PORT`, else 14711. They
  find the Henry home the way the daemon does — `HENRY_HOME` if set, else `~/.henry` — so a
  session with no Henry variables at all still finds the live daemon. The file is per-home,
  which is the only sharding that matters: two daemons on one home already share one SQLite
  and are a misconfiguration, so a private port needs a private `HENRY_HOME` (tests do
  both). A missing, empty or non-numeric file is not an error, it just means the env
  fallback; a stale one means the same failure the hook had anyway, a refused connection
  that `--max-time 1` and `exit 0` swallow.
- **What a session cannot re-resolve, the daemon comes back for.** The port file works
  because a hook is a fresh process on every call. An MCP client is not: `installer.ts` bakes
  the port into `launch-mcp.json`, Claude Code reads it once at session start, and a running
  process has no way to be told the url changed — so a port move would strand
  `henry_activity` and `henry_attention` for the life of every session that predates it. The
  daemon therefore keeps a listener open on every port its live sessions still name, with the
  same handlers as the main one: `sessions.port` records what a session was launched against,
  and `server.ts:syncAliasListeners` opens and closes aliases as sessions come and go. It is
  best-effort — a port another program now holds is logged and skipped, leaving that session
  no worse off than before, and never failing the daemon's boot. Anything a session carries
  away uses `config.boundPort()`, not `config.port`, which `HENRY_PORT=0` and a config edited
  since startup both turn into a lie.

- **Windows is a first-class host, with the same three processes.** The platform switches
  live in one daemon module (`platform.ts`) and one function in sessiond; everything else
  goes through Node's path/os modules. What differs: sessiond opens PTYs on node-pty's bundled
  `conpty.dll`, not the one in the OS (`HENRY_CONPTY_DLL=0` goes back). The inbox ConPTY on
  Windows 10 consumes an app's mouse-tracking DECSETs and forwards none of them, so nothing
  downstream learns the app wants the wheel, and a wheel report written back reaches nobody —
  which is the whole of Claude Code's own scrollback, so scrolling up in a Windows session did
  nothing at all while the same session scrolled fine on macOS. The bundled one relays the
  modes and delivers the reports. It is chosen at spawn, so a session started before the
  switch keeps the old one. sessiond runs PTYs on ConPTY and
  node-pty there rejects signals, so `kill` terminates instead of delivering SIGHUP; the
  daemon starts sessiond through PowerShell's `Start-Process` (ShellExecute inherits no
  handles; a CreateProcess child inherits Bun's listening sockets, and a sessiond respawned
  by a serving daemon then held :14711 after that daemon died, so no later daemon could
  bind); a
  plain terminal is PowerShell (`pwsh`, else `powershell`, else cmd.exe) with no `-l`; a
  `claude.cmd` twin of the PATH shim serves PowerShell/cmd while the sh one serves Git
  Bash; hooks and the status line are `node henry-hook.mjs <Event>` (Claude Code runs
  hooks under Git Bash or PowerShell on Windows, neither of which has curl for sure),
  written with forward slashes since Git Bash eats backslashes; transcript slugs also
  replace `\` and `:`; a terminal shown again asks the daemon for a redraw
  (`pty:resize` with `redraw`), which a POSIX pty gets as a one-row shrink and restore and
  ConPTY as one plain resize, since it repaints on every resize and garbles a TUI on a
  shrink (sessiond drops same-size resizes for the same reason); the daemon turns raw SO/SI
  bytes in ConPTY output into spaces, since ConPTY counts them as printed cells and xterm.js
  does not, which otherwise puts the first character typed after a resize one column left
  (Claude Code sends SI on that key); every session carries the Windows build of the machine
  hosting its PTY, so both the terminal in the window and the daemon's own emulator can set
  xterm's `windowsPty`, without which either reflows scrollback that ConPTY has already
  wrapped and lets a taller terminal pull scrollback back under ConPTY's reprint, losing it.
  It rides on the session and not on the state snapshot because the window drawing a session
  can be on another machine (Federation), and only the host knows what its PTY is. A resize reaches the daemon only once the drag has settled, since each
  one costs a reprint. In the browser, Ctrl takes ⌘'s letters and digits, Alt takes the
  arrows (Ctrl+arrows are the terminal's), Alt+N opens the picker (Chrome reserves
  Ctrl+N) and Alt+F the explorer (Ctrl+F is the terminal's forward-char, so it only
  reaches the window from outside one); duplicate is Ctrl+Shift+D and a terminal here is Ctrl+` (nothing reserves it,
  and the terminal makes no control character of it). Tauri builds the platform's own bundles; the menu
  bar is macOS-only, and in the Windows shell Ctrl+N and Ctrl+Shift+R (reset layout) are
  page bindings, with nothing on Ctrl+R so the terminal keeps reverse search.
