# Henry on a phone

The phone is not a machine Henry runs on: no daemon, no sessiond, no repos, nothing to install.
It is **another window onto a daemon that is already running**, so what it needs is a way in and a
shape that fits a hand. Everything a phone shows comes from the machine it is attached to, and
through that machine's peers, so one phone reaches every Henry the desk reaches.

- **A second listener, off loopback, behind a granted token.** `phone.listen` takes the same
  vocabulary as federation — `"tailscale"` (default) binds the 100.64/10 address, `"off"` never
  listens, an explicit address binds that — on `phone.port` (14714). It serves the UI, `/api/*`
  and `/ws`, and nothing else: `/hook`, `/statusline` and `/mcp` are how local processes talk to
  the daemon and are unauthenticated because loopback is the boundary, so off loopback they 404.
  `/api/federation/*` and phone management are refused there too: a phone drives sessions, it does
  not hand out keys. Windows on this listener take the same broadcasts as loopback ones and count
  toward `windowCount()`, so a session's ask knows a phone is watching.
- **The tailnet is not the credential.** A tailnet is a network of the user's devices, not one
  trusted device: a laptop that joined it for something else must not be able to type into a
  Claude session by knowing a port number. So access is a 256-bit token, stored as a SHA-256 in
  `~/.henry/phones.json` (0600) and held by the browser in an HttpOnly cookie, which is also what
  authenticates the WebSocket upgrade. Nothing in the page ever holds it.
- **Granting is a QR, and the QR carries an invite, not the token.** "phone → show a QR code"
  (or `henry phone invite`, which draws the same code in the terminal) opens a ten-minute,
  one-use, five-guess window; the QR is `http://<address>:14714/?i=<code>`. The phone opens it,
  spends the code for a token, takes it out of its address bar, and from then on just opens the
  page. A code photographed over a shoulder is worth nothing once the phone it was shown to has
  used it. Revoking a device (the popover's ×, `henry phone forget`) drops its hash, and its next
  request is a 401.
- **The QR is drawn from `shared/qr.ts`**, byte mode, error correction M, versions 1–6, written
  here rather than pulled in because the only thing Henry encodes is a fifty-character URL. It
  renders as one SVG path in the popover and as half-blocks in a terminal. Its test reads the
  square back the way a scanner does — format information, mask, zigzag, de-interleave, syndromes,
  payload — so a mistake shows up as a failing test rather than a code that will not scan.
- **A granted phone is a window, with a window's power.** It sees the same state, including the
  config, and can type into any session — which is strictly more than reading a settings file, so
  withholding anything from it would be theatre. That is why granting is a deliberate scan and
  revoking is one click, and why the popover says so in as many words.
- **A device that has not been granted access draws one screen**: how to get a QR. There is no
  form to type a secret into, because anyone who can reach the port can load the page.
- **The layout is a second shape of the same bundle, not a second app.** A narrow touch screen
  (`(pointer: coarse) and (max-width: 1024px)`, or any window under 700px) gets `mobile/`: the
  session filling the screen, the two rails behind buttons — ☰ opens the rail as a drawer, ⋮ opens
  Files/History/Flags/Playbook/Usage as a sheet — and an ask, when there is one, as a bar under the header.
  The panels themselves are the desktop's, bound to the store once in `panels/bound.tsx` and used
  by both. `?mobile=1` / `?desktop=1` force either shape, which is how the phone layout gets looked
  at from a desk.
- **The terminal is zoomed, not reflowed.** Claude Code draws for 80 columns and wraps into a mess
  below that, so the phone's answer is a smaller cell: − / + in the header set the xterm font size
  (persisted per browser), starting at whatever fits 80 columns on this screen, and the PTY is told
  the new size like any other resize.
- **A drag scrolls the buffer, as a wheel.** xterm's own touch scrolling stands down whenever an
  app has mouse tracking on, which Claude Code always does, and the scrollable viewport a finger
  would have panned sits under the screen element where no touch reaches it — so the scrollback
  was unreachable on a phone, with no wheel to fall back on. Henry turns a drag on the screen into
  wheel events at the terminal, a notch per line of travel, and lets a flick coast. Going through
  the wheel and not `scrollLines` is the point: touch then does whatever the wheel already does
  here — reported to an app that asked for it, arrow keys on an alt screen, the viewport otherwise
  — rather than being a second scrolling story to keep true. A tap that never crosses six pixels
  is still a tap, and still reaches the app as a click.
- **Typing is a composer, not the on-screen keyboard against xterm.** A phone keyboard has no Esc,
  no Tab and no ⌃C, and autocorrect fights xterm's hidden textarea, so the terminal on a phone is
  a screen you read: xterm never takes focus there. Under it sits a row of the keys Claude Code
  actually wants (esc, tab, 1/2/3 for a permission prompt, ↑↓, ⏎, ⌃C, ⇧⏎) and a text box that
  sends a whole line at a time.
- **A fingertip is not a small mouse, and the picker is where that bites.** No field under 16px is
  focused on a coarse pointer: iOS zooms the page into one, and every tap after that lands where it
  looks like it should not. So "+ new session" opens the picker with the list showing and nothing
  focused — the box is a tap away when you want to filter — and the box is a `<form>`, because
  Android reports Enter in a text field as a composition key that no `keydown` handler sees. Rows
  select on the tap that opens them, never on the hover a touch synthesises a moment earlier.
- **Dictation is the point of the box, and it arrives twice.** The composer is an ordinary
  textarea, so the phone keyboard's own microphone works in it with no code at all — that is the
  one that works everywhere. The mic button beside it is the Web Speech API: continuous,
  hands-free, words appearing as they are recognised, for when the phone is on the desk and you
  are looking at the terminal. It is hidden where the API is missing. Recognition is the browser's;
  no audio goes near Henry.
