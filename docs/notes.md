# Notes

The few things you must not lose track of while switching between sessions. `daemon/src/notes.ts`
keeps them, `notes-fill.ts` fills them from sessions, `ui/src/panels/Notes.tsx` shows them.

- **A note is a line you keep until you tick it off.** The Notes tab (its count is on the tab) adds
  one with Enter, edits one on double-click and removes one with ✓, with an undo for a few seconds.
  Nothing expires a live note: it goes when you say it no longer matters.
- **The list is a queue, worked from the top.** A new note joins the end, and "later" sends one
  behind everything already there; the move is a change like an edit and reaches every machine.
- **A note written while looking at a session is about that session**, unless you untick "about".
  While you are in that session its notes come first, in their queue order; anywhere else the note carries the session's
  name as a chip that takes you back to it. The title is stored with the note, so it still reads
  right after the session is gone or while its machine is offline.
- **Every paired machine holds the same list.** Each daemon keeps all notes, not only its own, in
  SQLite. When a link comes up both sides send everything they hold, and after that every change
  goes to every connected peer, whichever side dialed. Of two copies of one note the one changed
  later wins, with a removal counting as a change and a fixed tie-break, so machines that saw the
  same changes in any order agree. A change that changes nothing here is not passed on, which is
  what ends the echo. Removed notes stay as tombstones for 90 days so a machine that was away
  learns they are gone; one away for longer can bring a removed note back.
- **Notes spread past the machine they were written on.** Unlike sessions and topics, a note is
  yours, not a machine's: a machine gets every note the machines it is paired with hold. A peer's
  notes are checked for shape before they are stored.
- **"Fill from sessions" asks the model for notes, only when pressed.** Each machine reads its own
  running Claude sessions the way a coordinator does (prompts asked, repos, files written, the last
  reply; never source or diffs), with the notes already kept so it does not repeat them, and adds
  at most two per session. A session is read again only after it has done something since it was
  last read, so a second press right away costs nothing. A window's press runs on its machine and
  on every machine that machine dials; a machine that only dials and never listens is reached only
  from its own window. One model call per machine per press, never on a timer.
- **Voice sees the notes** in its context, so "what was I keeping in mind?" can be asked out loud.
