// Answer parsing and session matching (src/voice.ts). Pure: no whisper, no daemon, no audio.
import { describe, expect, test } from "bun:test";
import type { Session } from "@henry/shared";
import { biasFrom, canonicalize, matchSession, parseAnswer, relaySafe, resolveOpen } from "../src/voice";

const session = (id: string, title: string) => ({ id, title }) as Session;

const live = [
  session("s1", "dune vs squid"),
  session("s2", "henry voice panel"),
  session("s3", "off-chain indexer"),
];

describe("parseAnswer", () => {
  test("plain answers are spoken whole", () => {
    expect(parseAnswer("Tests pass, seventy-one of seventy-one.")).toEqual({ spoken: "Tests pass, seventy-one of seventy-one." });
  });

  test("a GO line is lifted off the front and the rest is spoken", () => {
    const { spoken, go } = parseAnswer("GO: dune vs squid\nIt finished the backfill and is waiting on you.");
    expect(go).toBe("dune vs squid");
    expect(spoken).toBe("It finished the backfill and is waiting on you.");
  });

  test("GO only counts on the first line, so a mid-sentence mention is just speech", () => {
    const { spoken, go } = parseAnswer("It said GO: somewhere in the log.");
    expect(go).toBeUndefined();
    expect(spoken).toBe("It said GO: somewhere in the log.");
  });

  test("a GO with nothing after it still switches", () => {
    expect(parseAnswer("GO: henry voice panel")).toEqual({ spoken: "", go: "henry voice panel" });
  });

  test("TELL carries the message beneath it and speaks nothing itself", () => {
    const { spoken, tell } = parseAnswer("TELL: dune vs squid\nStop the backfill and check the queue depth first.");
    expect(tell).toEqual({ name: "dune vs squid", message: "Stop the backfill and check the queue depth first." });
    expect(spoken).toBe("");
  });

  test("a multi-line TELL keeps every line of the message", () => {
    const { tell } = parseAnswer("TELL: henry\nFirst, land the fix.\nThen run the tests.");
    expect(tell?.message).toBe("First, land the fix.\nThen run the tests.");
  });

  test("TELL with no message is not a relay", () => {
    expect(parseAnswer("TELL: henry").tell).toEqual({ name: "henry", message: "" });
  });

  test("only the first line is a directive, so a spoken \"tell\" is just speech", () => {
    const out = parseAnswer("I would tell: the indexer to slow down, but it already stopped.");
    expect(out.tell).toBeUndefined();
    expect(out.go).toBeUndefined();
  });

  test("OPEN names a repo and carries the first prompt beneath it", () => {
    const { spoken, open } = parseAnswer("OPEN: henry on mini\nAdd a test for the retention sweep.");
    expect(open).toEqual({ name: "henry on mini", message: "Add a test for the retention sweep." });
    expect(spoken).toBe("");
  });

  test("OPEN with nothing after it opens a session with no prompt", () => {
    expect(parseAnswer("OPEN: dune-vs-squid").open).toEqual({ name: "dune-vs-squid", message: "" });
  });
});

// Which repo, on which machine, an OPEN means. `repos` lists this machine's first, so a name
// held on two machines opens here unless the model said otherwise.
describe("resolveOpen", () => {
  const repos = [
    { name: "henry", path: "/me/code/henry" },
    { name: "dune-vs-squid", path: "/me/code/dune-vs-squid" },
    { name: "henry", path: "/other/henry", peer: "mini" },
    { name: "arm", path: "/other/arm", peer: "mini" },
  ];
  const peers = ["mini"];

  test("a bare name picks this machine's copy first", () => {
    expect(resolveOpen("henry", repos, peers)).toEqual({ name: "henry", path: "/me/code/henry" });
  });

  test("\"on <peer>\" picks that machine's copy", () => {
    expect(resolveOpen("henry on mini", repos, peers)?.path).toBe("/other/henry");
    expect(resolveOpen("Henry on Mini", repos, peers)?.path).toBe("/other/henry");
  });

  test("a repo that only exists on a peer is found without naming the machine", () => {
    expect(resolveOpen("arm", repos, peers)?.peer).toBe("mini");
  });

  test("\"on\" followed by something that is not a machine stays part of the name", () => {
    // whisper's "dune versus squid on this machine": no peer called "machine", so the whole
    // phrase is matched, and containment still finds the repo.
    expect(resolveOpen("dune versus squid on machine", repos, peers)?.path).toBe("/me/code/dune-vs-squid");
  });

  test("a peer that has no such repo does not fall back to another machine's", () => {
    expect(resolveOpen("dune-vs-squid on mini", repos, peers)).toBeUndefined();
  });

  test("nothing close matches nothing", () => {
    expect(resolveOpen("grocery list", repos, peers)).toBeUndefined();
  });
});

// A relayed message is typed into another agent's prompt. The promise that it is never *sent*
// is enforced here and nowhere else: pty:input is a raw write, so a stray newline is an Enter.
describe("relaySafe", () => {
  test("newlines become spaces, so a multi-line relay cannot submit itself", () => {
    expect(relaySafe("First, land the fix.\nThen run the tests.")).toBe("First, land the fix. Then run the tests.");
  });

  test("a carriage return — an Enter to every terminal — does not survive", () => {
    expect(relaySafe("do the thing\rrm -rf /")).toBe("do the thing rm -rf /");
    expect(relaySafe("trailing\r\n")).toBe("trailing");
  });

  test("escape sequences and other C0 controls are dropped", () => {
    expect(relaySafe("plain\x1b[31mred\x07")).toBe("plain[31mred");
    expect(relaySafe("nul\x00byte")).toBe("nulbyte");
  });

  test("a payload is capped rather than passed through", () => {
    expect(relaySafe("x".repeat(5_000)).length).toBe(1_000);
  });

  test("ordinary text is left alone", () => {
    expect(relaySafe("  Stop the backfill and check the queue depth.  ")).toBe("Stop the backfill and check the queue depth.");
  });
});

// Telling whisper a word exists makes it likelier, not certain: it writes what English suggests
// ("sub-squid", "session D"). These put the spelling back.
describe("canonicalize", () => {
  const terms = [
    { term: "subsquid", source: "you" as const },
    { term: "sessiond", source: "you" as const },
    { term: "FilePicker", source: "file" as const },
    { term: "off-chain", source: "repo" as const },
  ];

  test("a hyphen whisper invented is removed", () => {
    expect(canonicalize("deploy the sub-squid indexer", terms)).toBe("deploy the subsquid indexer");
  });

  test("a word split in two is rejoined", () => {
    expect(canonicalize("did session d restart", terms)).toBe("did sessiond restart");
    expect(canonicalize("open the file picker please", terms)).toBe("open the FilePicker please");
  });

  test("sentence punctuation survives the substitution", () => {
    expect(canonicalize("use sub-squid.", terms)).toBe("use subsquid.");
  });

  test("a term whisper spelled correctly is left alone", () => {
    expect(canonicalize("subsquid is fine", terms)).toBe("subsquid is fine");
  });

  test("a hyphen that belongs is restored too", () => {
    expect(canonicalize("the off chain repo", terms)).toBe("the off-chain repo");
  });

  test("text with no known terms is untouched", () => {
    expect(canonicalize("nothing to see here", terms)).toBe("nothing to see here");
    expect(canonicalize("anything", [])).toBe("anything");
  });
});

describe("biasFrom", () => {
  const term = (t: string, source: "you" | "repo" = "repo") => ({ term: t, source });

  test("what does not fit is reported rather than silently cut", () => {
    const many = Array.from({ length: 200 }, (_, i) => term(`repository-number-${i}`));
    const { used, dropped, prompt } = biasFrom(many);
    expect(dropped.length).toBeGreaterThan(0);
    expect(used.length + dropped.length).toBe(many.length);
    expect(prompt.length).toBeLessThanOrEqual(700);
  });

  test("your own words are first, so a full list cannot push them out", () => {
    const { used } = biasFrom([term("subsquid", "you"), ...Array.from({ length: 200 }, (_, i) => term(`filler-${i}`))]);
    expect(used[0]?.term).toBe("subsquid");
  });

  test("no terms is no prompt at all", () => {
    expect(biasFrom([])).toEqual({ prompt: "", used: [], dropped: [] });
  });
});

describe("matchSession", () => {
  test("exact title", () => {
    expect(matchSession("dune vs squid", live)?.id).toBe("s1");
  });

  test("case and punctuation do not count", () => {
    expect(matchSession("Off-Chain Indexer.", live)?.id).toBe("s3");
  });

  test("whisper writing out \"versus\" still finds \"vs\"", () => {
    expect(matchSession("dune versus squid", live)?.id).toBe("s1");
  });

  test("a partial name matches the session that contains it", () => {
    expect(matchSession("voice panel", live)?.id).toBe("s2");
  });

  test("the best word overlap wins when nothing matches literally", () => {
    expect(matchSession("the squid one", live)?.id).toBe("s1");
  });

  test("no overlap matches nothing rather than guessing", () => {
    expect(matchSession("grocery list", live)).toBeUndefined();
    expect(matchSession("", live)).toBeUndefined();
  });

  test("a title with nothing matchable in it does not capture every relay", () => {
    // Titles come from the terminal's OSC, so they can be emoji or CJK only. Such a title
    // normalizes to "", and "want.includes('')" is true for every input.
    const withJunk = [session("s9", "→ ···"), ...live];
    expect(matchSession("dune vs squid", withJunk)?.id).toBe("s1");
    expect(matchSession("something unrelated entirely", withJunk)).toBeUndefined();
  });
});
