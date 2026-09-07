// Transcript -> turns (src/history.ts). Parsing only: no HENRY_HOME, no daemon, no files.
import { describe, expect, test } from "bun:test";
import { parseTurns } from "../src/history";

const line = (o: unknown) => JSON.stringify(o);
const at = "2026-09-05T07:30:20.325Z";

describe("parseTurns", () => {
  test("reads a conversation in order, both roles", () => {
    const turns = parseTurns(
      [
        line({ type: "user", uuid: "u1", timestamp: at, message: { role: "user", content: "how do I scroll?" } }),
        line({ type: "assistant", uuid: "a1", timestamp: at, message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "you don't" }] } }),
      ].join("\n"),
    );
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[0].blocks[0].text).toBe("how do I scroll?");
    expect(turns[1].model).toBe("claude-opus-5");
    expect(turns[1].at).toBe(Date.parse(at));
  });

  test("tool calls keep their name and the argument worth showing", () => {
    const turns = parseTurns(
      line({
        type: "assistant",
        uuid: "a2",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "bun run build", timeout: 900 } }] },
      }),
    );
    expect(turns[0].blocks[0]).toMatchObject({ kind: "tool", name: "Bash", text: "bun run build" });
  });

  test("a tool result comes back as its own block", () => {
    const turns = parseTurns(
      line({ type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "exit=0" }] }] } }),
    );
    expect(turns[0].blocks[0]).toMatchObject({ kind: "result", text: "exit=0" });
  });

  test("a slash command shows as the command, not its markup", () => {
    const raw = "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>";
    const turns = parseTurns(line({ type: "user", uuid: "u3", message: { role: "user", content: raw } }));
    expect(turns[0].blocks[0].text).toBe("/clear");
  });

  test("meta lines, empty turns and unparseable lines are skipped", () => {
    const turns = parseTurns(
      [
        line({ type: "user", uuid: "m1", isMeta: true, message: { role: "user", content: "caveat: ..." } }),
        line({ type: "summary", uuid: "s1" }),
        line({ type: "assistant", uuid: "e1", message: { role: "assistant", content: [] } }),
        "{ not json",
        "",
        line({ type: "user", uuid: "k1", message: { role: "user", content: "kept" } }),
      ].join("\n"),
    );
    expect(turns.map((t) => t.uuid)).toEqual(["k1"]);
  });

  test("subagent turns are marked, so the panel can fold them", () => {
    const turns = parseTurns(
      [
        line({ type: "assistant", uuid: "a3", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "sub" }] } }),
        line({ type: "assistant", uuid: "a4", message: { role: "assistant", content: [{ type: "text", text: "main" }] } }),
      ].join("\n"),
    );
    expect(turns[0].sidechain).toBe(true);
    expect(turns[1].sidechain).toBeUndefined();
  });

  test("a read that starts mid-file drops the half line it opened on", () => {
    const good = line({ type: "user", uuid: "u4", message: { role: "user", content: "whole" } });
    const turns = parseTurns(`ssage":{"role":"user","content":"half a line"}}\n${good}`, true);
    expect(turns.map((t) => t.uuid)).toEqual(["u4"]);
  });

  test("a huge block is cut and says so", () => {
    const turns = parseTurns(line({ type: "user", uuid: "u5", message: { role: "user", content: "x".repeat(50_000) } }));
    expect(turns[0].blocks[0].clipped).toBe(true);
    expect(turns[0].blocks[0].text.length).toBeLessThan(50_000);
  });
});
