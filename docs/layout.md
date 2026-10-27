# Layout

The dock, the stage, the status strip, the topbar and the backdrop behind the terminal.

```
┌──────────┬──────────────────────────────────────┬──────────────────────┐
│ sessions │                                      │ Files│Flags│Playbook │
│ ▣ Rail fi│                                      │ ▾ henry main ↑2 ±5 ⑂↗│
│ ▣ Stealth│         xterm.js (WebGL)             │   ▸ packages         │
│ >_ henry │         one per session              │   M PLAN.md          │
│ ▢ arm ⚑2 │                                      │ ▸ arm feat/x ↑∅ ±0 ⑂ │
│ + new    │                                      │                      │
│ 3 running│                                      │                      │
├──────────┴──────────────────────────────────────┴──────────────────────┤
│ opus  ctx ▇▇▁ 41%  38k in 9k out  $1.20         5h ▇▇▁ 42% 2h10m  7d ▇▁▁ 18% 3d │
└────────────────────────────────────────────────────────────────────────┘
```

That is the default arrangement, not a fixed one. The workspace is a Dockview grid
(`dockview-react`): the rail, every terminal and each tool tab is a panel. Drag a tool tab
to split a group (top/bottom/left/right), stack it as a tab, dock it on a window edge, or
float it. Tabs have no close button and there is no view menu: tools are rearranged, never
dismissed. The arrangement is saved to localStorage
(`henry.layout.v3`; a v2 layout is read once and its usage pane folded into the tabs) and
restored on load; "reset layout" restores the picture above.
The selected session is saved too (`henry.active`, id + cwd), so a refresh reopens where you
were; if that session is gone, Henry falls back to a running session in the same repo.

**The centre is a stage, not a tab strip.** Sessions are processes you glance at, not
documents you curate, so terminal groups hide their header: the rail (and ⌘1..9, ⌘↑/↓) is
the only selector, and one session shows at a time. The centre group is locked: tools dock
around its edges but cannot be dropped into it, and terminals are not dragged. Terminal
panels whose session is gone are dropped; new sessions join the active terminal group (or
the empty centre pane). Drag handles are tab headers only: dragging panel bodies would
fight xterm's mouse handling and text selection.

**A session can leave the stage for a window of its own.** ⧉ on a rail row (or "open in its
own window" in its right-click menu) opens `/?session=<id>`: a whole Henry client showing only
that terminal under a one-line bar (title, repo, activity, any ask), not a dockview popout like
a peek's, so it outlives the main window reloading on a UI build. Two windows drawing one PTY
at two sizes fight over it, so while the session is out the main window has no tab for it, and
its rail row keeps ⧉ lit and brings that window forward when clicked. Windows of the browser
tell one another which sessions are out over a BroadcastChannel (a beat every 2 s, a goodbye on
close), so a reloaded main window still knows; closing the session's window, or "back to the
main window", returns the tab. The session's window leaves notices and the remembered session
(`henry.active`) to the main one, and counts as looking at the session like any window.

**The topbar carries the roll-up, and it is half about you.** Left of the buttons, one line
of chips answers "what is happening" without the rail: any session that asked for you by name
(first, and carrying its own sentence — see Henry's tools), sessions working / needing an
answer / waiting on you, and uncommitted paths (plus unpushed commits) across every repo Henry
has seen. Then a divider, and the same line answers "what have *I* been doing": time here today
(typing or reading), prompts sent, and a four-hour cadence sparkline with your current pace.
Flags and usage are deliberately not up here — flags are a panel, usage is the status strip
along the bottom, and the bar is for the two things you cannot get by looking at a panel: who
wants you, and how your day is going. A chip
renders only when it has something to say, and each is a shortcut: session chips jump to the
session that has waited longest, the repo chip opens Files, the human chips open the "you"
popover (today in detail, the day by the hour, the last fortnight). The repos-root button is
gone; Settings is where the path lives.

**Appearance.** Three choices in the topbar "theme" popover (tone, highlight, shade) derive
the whole palette in OKLCH; `theme.ts` writes it as CSS variables on `<html>` and the
terminal (background, foreground, cursor, selection, the 16 ANSI colors) reads the same
variables, so the stage and the chrome always match. Nothing else hard-codes a color.
Saved as `henry.theme`. Semantic colors (ok/warn/alarm) and the Claude orange stay fixed
across themes. Two of the shades, `light` and `white`, are light: past a background
lightness of 0.5 the palette flips — surfaces step darker instead of lighter, text and the
accent drop to read on paper, the ANSI colours with them — and `theme.ts` sets
`color-scheme: light` and `html.light` so native widgets and the hand-coloured syntax
tokens follow. What an app draws in the terminal is its own: Claude Code picks its colours
for a dark terminal, so on a light shade xterm is given a minimum contrast ratio of 7, which
darkens only what falls short, and its dim text — half of what Claude Code says, drawn by
xterm at half opacity — is instead coloured at full strength and pulled 30% toward the
background, opaque: a step down, still legible. On dark shades the floor is off and dim is
xterm's own. A cell painted in the theme background — every dim run, since dim is a background flag
to xterm — is drawn fully clear over the context backdrop rather than as a slab of it. On a phone
the same rows sit in the ⚙ tab of the ⋮ sheet.

**The context backdrop.** Behind Henry's window is a canvas that gets busier as the active
session's context window fills, in one of three scenes, all reading the Usage panel's context
fraction. It sits under xterm, whose background is transparent whenever the backdrop is on; a
theme choice (`backdrop`: off, faint, soft, bold) sets how hard it paints, and "off" makes the
terminal background opaque again. `span` sets where it is drawn: `window` (the default) draws the
active session's scene once behind the whole window, and `pane` puts one behind each session
pane instead. In
`window`, the terminal goes clear, the rail and panels take a light tint of their background
and the bars and sticky headers a heavier one, so the scene reads through the chrome too. The tint has no
`backdrop-filter` blur because that would make the topbar a stacking context and trap its
popovers under the dock. A popped-out session window and the phone layout have no chrome
around the terminal, so they keep the backdrop per pane under either setting. Two more soften or brighten it, for every scene: `focus`
(sharp, soft, hazy, dream) blurs it, so lines become texture and then a wash of colour, and
`glow` (off, soft, neon; dark shades only, since added light only washes paper out) blooms it
— a half-size copy of each painted frame, blurred, brightened and added on top, so every line
glows in its own colour. Decoration only: no session state is readable from it that a panel
does not also state.

`life` (the default) is Conway's Life written in dim, mirrored half-width katakana on cells
larger than the terminal's, so it never reads as text. Life alone settles into a few percent
of still ash, so `life.ts` holds the density with a controller instead: a target set by the
context fraction (near empty at the start of a session, a churning soup near the end), a
shortfall that becomes Matrix rain falling down a column and planting a seed where it lands,
and a surplus that is culled. Rain lands in the bottom quarter of the pane when the window is
fresh and anywhere when it is full, so the activity rises from the bottom. Dead cells fade like
phosphor rather than blinking out, and old still life erodes so the board never freezes. Each
tool call fires a glider in from an edge, a working session runs at about twice the tempo of an
idle one, and a drop of more than 8 points in the fraction (a `/compact`, a `/clear`) turns every
living cell into a drop that pours off the bottom. It pauses with the tab and, under reduced
motion, is a still frame redrawn when the fraction moves. Its colour walks the Usage thresholds,
green to amber to red.

`loom` weaves the session as cloth (`loom.ts`). Every prompt lays a thread across the pane in
a new colour, and every tool call leaves a stroke of its own kind: a reading tool a long warp
line, an edit a tight knot, a shell command a zig-zag, an agent a fan of filaments. The threads
follow a seeded flow field, so a debugging session leaves knotted cloth and a clean build calm
parallel weave. The context fraction sets how much thread is on the loom; where the events
account for less, plain weft makes up the difference. Past 70% the field turns turbulent and
past 90% the cloth frays. A compaction (the PreCompact hook, or the same 8-point drop) squeezes
the cloth down into a braid along the bottom, and braids stack, one per compaction. The cloth
is alive, like a sample under a microscope: its threads sit at three depths — behind the focal
plane (soft, dim, slow), on it (sharp), in front of it (wide, soft, carried furthest) — each
depth drawn at its own resolution, which is the blur, and drifting at its own speed, with motes
suspended at every depth. A slow current carries every thread at about 15 frames a second, more
once the field is turbulent, swinging its tail further than its anchor so it bends like a fibre
in water. A tool call landing touches the water, a small ring from where its stroke begins, and
when the context fraction then rises, a swell goes out from that same place sized by what was
added (a percent of the window is a plain ripple, a big read a wide, hard swell), pushing the
threads near it aside. A turn's threads recede as
newer turns arrive, to about a fifth of their strength, so the turn in hand stands out and the
history settles into texture. Filler is drawn already receded. Under reduced motion the current
is still and frames are drawn only when the cloth changes. On mount the session's history is fetched from `/api/events` and
replayed, seeded by event ids, into the cloth it was before the reload; a peer's session,
which this daemon has no history for, starts from the live feed.

`sky` is a brick wall that rises from the bottom as
the window fills, in front of the sky that is actually outside: the sun and
moon stand where they really stand over the user's latitude and longitude, so the day is as
long as today's day is, the winter sun stays low, the moon keeps its own hours and its real
phase, and the stars come out through twilight. Two readings in one picture — how full the
window is, and how late it has got — and a wall tall enough to blot out the sky is telling you
something. The wall is the context fraction brick by brick (one brick is ~2.5k tokens of a
200k window), so a `/compact` visibly drops it.

The sky's arithmetic is local (`solar.ts`, the standard low-precision solar and lunar series,
good to a fraction of a degree): no weather or almanac API, so it works offline and on a
plane, and nothing about the user leaves the machine. The place is guessed from the browser's
time zone (`place.ts`), which needs no geolocation prompt and is right to within a few
hundred kilometres — minutes of sunset. When the sky scene is on, the theme popover shows the
latitude and longitude with today's sunrise and sunset under them; both are editable, and a
`locate` button asks the browser for something exact only when the user clicks it.
