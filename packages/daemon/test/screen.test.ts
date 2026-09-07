// The per-session emulator (src/screen.ts): a window attaching gets the screen, not the bytes
// that made it. No daemon, no PTY, no HENRY_HOME — screens.ts talks to nothing.
import { describe, expect, test } from "bun:test";
import { screens } from "../src/screen";

/** xterm parses on a microtask; wait for the write callbacks to land. */
const settled = () => new Promise((r) => setTimeout(r, 20));

describe("screens", () => {
  test("a repainting app collapses into one screen, not one frame per repaint", async () => {
    const id = "repaint";
    screens.open(id, 40, 10);
    screens.write(id, "scrolled away\r\n");
    // Ten frames of a full-screen app, each painted over the last from home.
    for (let i = 0; i < 10; i++) screens.write(id, `\x1b[H\x1b[2Jframe ${i}\r\n`);
    await settled();
    const snap = screens.snapshot(id)!;
    expect(snap).toContain("frame 9");
    for (let i = 0; i < 9; i++) expect(snap).not.toContain(`frame ${i}`);
    // \x1b[2J cleared it: the earlier line is gone from the buffer, not merely overpainted.
    expect(snap).not.toContain("scrolled away");
    screens.forget(id);
  });

  test("scrollback survives as text, in order", async () => {
    const id = "history";
    screens.open(id, 40, 5);
    for (let i = 0; i < 60; i++) screens.write(id, `line ${i}\r\n`);
    await settled();
    const snap = screens.snapshot(id)!;
    expect(snap).toContain("line 0");
    expect(snap).toContain("line 59");
    expect(snap.indexOf("line 0")).toBeLessThan(snap.indexOf("line 59"));
    screens.forget(id);
  });

  test("an app holding the alternate screen is restored to it", async () => {
    const id = "alt";
    screens.open(id, 40, 10);
    screens.write(id, "before the app\r\n");
    screens.write(id, "\x1b[?1049h\x1b[Hinside the app");
    await settled();
    const snap = screens.snapshot(id)!;
    expect(snap).toContain("before the app");
    expect(snap).toContain("\x1b[?1049h");
    expect(snap).toContain("inside the app");
    screens.forget(id);
  });

  test("mouse encoding is carried across an attach", async () => {
    const id = "mouse";
    screens.open(id, 40, 10);
    // What Claude Code asks for: any-motion tracking in the SGR encoding.
    screens.write(id, "\x1b[?1003h\x1b[?1006h");
    await settled();
    expect(screens.snapshot(id)).toContain("\x1b[?1006h");
    screens.write(id, "\x1b[?1006l");
    await settled();
    expect(screens.snapshot(id)).not.toContain("\x1b[?1006h");
    screens.forget(id);
  });

  test("a mode split across two chunks still counts", async () => {
    const id = "split";
    screens.open(id, 40, 10);
    screens.write(id, "\x1b[?10");
    screens.write(id, "06h");
    await settled();
    expect(screens.snapshot(id)).toContain("\x1b[?1006h");
    screens.forget(id);
  });

  test("bytes not yet parsed are in the snapshot exactly once", async () => {
    const id = "pending";
    screens.open(id, 40, 10);
    screens.write(id, "hello\r\n");
    // Same tick as the write: "hello" is still in flight, and the caller subscribes to live
    // output from here, so the snapshot has to carry it.
    const early = screens.snapshot(id)!;
    expect(early.split("hello").length - 1).toBe(1);
    await settled();
    const late = screens.snapshot(id)!;
    expect(late.split("hello").length - 1).toBe(1);
    screens.forget(id);
  });

  test("resizing follows the pty, and forget is idempotent", async () => {
    const id = "resize";
    screens.open(id, 80, 24);
    screens.resize(id, 100, 30);
    screens.write(id, "after");
    await settled();
    expect(screens.snapshot(id)).toContain("after");
    screens.forget(id);
    screens.forget(id);
    expect(screens.snapshot(id)).toBeUndefined();
    expect(screens.has(id)).toBe(false);
  });
});
