# Layout

The dock, the stage, the status strip, the topbar and the sky behind the terminal.

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
to xterm — is drawn fully clear over the context wall rather than as a slab of it. On a phone
the same rows sit in the ⚙ tab of the ⋮ sheet.

**The context wall.** Behind every session pane is a brick wall that rises from the bottom as
the session's context window fills, in front of the sky that is actually outside: the sun and
moon stand where they really stand over the user's latitude and longitude, so the day is as
long as today's day is, the winter sun stays low, the moon keeps its own hours and its real
phase, and the stars come out through twilight. Two readings in one picture — how full the
window is, and how late it has got — and a wall tall enough to blot out the sky is telling you
something. The wall is the Usage panel's context
fraction, brick by brick (one brick is ~2.5k tokens of a 200k window), coloured by the same
green/amber/red thresholds, so a `/compact` visibly drops it. It is a canvas under xterm, whose
background is transparent whenever the wall is on; a fourth theme choice (`sky`: off, faint,
soft, bold) sets how hard it paints, and "off" makes the terminal background opaque again.
Decoration only: no session state is readable from it that a panel does not also state.

The sky's arithmetic is local (`solar.ts`, the standard low-precision solar and lunar series,
good to a fraction of a degree): no weather or almanac API, so it works offline and on a
plane, and nothing about the user leaves the machine. The place is guessed from the browser's
time zone (`place.ts`), which needs no geolocation prompt and is right to within a few
hundred kilometres — minutes of sunset. When the sky is on, the theme popover shows the
latitude and longitude with today's sunrise and sunset under them; both are editable, and a
`locate` button asks the browser for something exact only when the user clicks it.
