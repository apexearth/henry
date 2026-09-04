// ConPTY output filter: raw SO/SI bytes become a space on Windows so xterm's cursor keeps
// pace with ConPTY's; everything else, and every byte off Windows, passes through. Run: bun test
import { describe, expect, test } from "bun:test";
import { isWindows, sanitizePtyOutput, stripLockingShifts } from "../src/platform";

// What ConPTY relayed for the first keystroke after a resize (Claude Code 2.1.260): keyboard
// mode setup, SI, then a backspace and the typed character.
const burst = "\x1b[<u\x1b[>5u\x1b[>4;2m\x0f";
const keystroke = "\x08h";

describe("stripLockingShifts", () => {
  test("replaces SO and SI with a space, leaves the rest alone", () => {
    expect(stripLockingShifts(burst + keystroke)).toBe("\x1b[<u\x1b[>5u\x1b[>4;2m \x08h");
    expect(stripLockingShifts("a\x0eb\x0fc")).toBe("a b c");
  });
  test("keeps other controls and escapes intact", () => {
    const frame = "\x1b[?25l\x1b[27;3H❯ \x1b[K\r\n\t\x07\x1b]8;;\x07\x1b[?25h";
    expect(stripLockingShifts(frame)).toBe(frame);
  });
});

describe("sanitizePtyOutput", () => {
  test("filters on Windows only", () => {
    expect(sanitizePtyOutput("x\x0fy")).toBe(isWindows ? "x y" : "x\x0fy");
  });
});
