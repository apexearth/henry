import { describe, expect, test } from "bun:test";
import { parsePlaybookText } from "@henry/shared";

const entry = [
  "HEADLINE: Pushed two commits to `main` in `henry`.",
  "DOING: restyling the playbook panel",
  "CHANGED:",
  "- `henry`: 2 commits on `main`, pushed",
  "- `henry`: `PLAN.md` edited",
  "  (still dirty)",
  "CAREFUL:",
  "- none",
  "NEXT: run the build",
].join("\n");

describe("parsePlaybookText", () => {
  test("splits labels, bullets and continuation lines; drops none and HEADLINE", () => {
    const p = parsePlaybookText(entry);
    expect(p.headline).toBe("Pushed two commits to `main` in `henry`.");
    expect(p.sections.map((s) => s.label)).toEqual(["DOING", "CHANGED", "NEXT"]);
    expect(p.sections[0].text).toBe("restyling the playbook panel");
    expect(p.sections[1].items).toEqual(["`henry`: 2 commits on `main`, pushed", "`henry`: `PLAN.md` edited (still dirty)"]);
    expect(p.sections[2].text).toBe("run the build");
  });

  test("tolerates markdown decoration on labels and bullets", () => {
    const p = parsePlaybookText("**HEADLINE:** hi\n## DOING: x\nCHANGED:\n* **a**\n1. b");
    expect(p.headline).toBe("hi");
    expect(p.sections[1].items).toEqual(["a", "b"]);
  });

  test("plain prose becomes one unlabeled section", () => {
    const p = parsePlaybookText("Just a paragraph.\nSecond line.");
    expect(p.headline).toBeUndefined();
    expect(p.sections).toEqual([{ label: "", text: "Just a paragraph.\nSecond line.", items: [] }]);
    expect(parsePlaybookText("  \n").sections).toEqual([]);
  });

  test("a sentence with a colon is not a label", () => {
    const p = parsePlaybookText("Note: the session is idle.");
    expect(p.sections[0].label).toBe("");
  });
});
