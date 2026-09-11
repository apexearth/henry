import { describe, expect, test } from "bun:test";
import { ancestorsOf, buildTree, filesUnder } from "../src/tree";
import { globFilter, matches, tokenize } from "../src/match";

/** A compact shape to assert against: "dir/" for directories, nested. */
function shape(nodes: ReturnType<typeof buildTree>): unknown[] {
  return nodes.map((n) => (n.dir ? { [n.name + "/"]: shape(n.children) } : n.name));
}

describe("buildTree", () => {
  test("nests paths, directories first, then case-insensitive by name", () => {
    expect(shape(buildTree(["b.ts", "Alpha.ts", "src/z.ts", "src/a.ts", "lib/x.ts"]))).toEqual([
      { "lib/": ["x.ts"] },
      { "src/": ["a.ts", "z.ts"] },
      "Alpha.ts",
      "b.ts",
    ]);
  });

  test("collapses single-child directory chains into one row", () => {
    expect(shape(buildTree(["packages/ui/src/Rail.tsx", "packages/ui/src/ws.ts"]))).toEqual([
      { "packages/ui/src/": ["Rail.tsx", "ws.ts"] },
    ]);
  });

  test("stops collapsing where the tree forks", () => {
    expect(shape(buildTree(["a/b/c/one.ts", "a/b/d/two.ts"]))).toEqual([
      { "a/b/": [{ "c/": ["one.ts"] }, { "d/": ["two.ts"] }] },
    ]);
  });

  test("a directory holding one file is not collapsed into it", () => {
    expect(shape(buildTree(["src/only.ts"]))).toEqual([{ "src/": ["only.ts"] }]);
  });

  test("a name that is both a file and a directory keeps both", () => {
    expect(shape(buildTree(["x", "x/y.ts"]))).toEqual([{ "x/": ["y.ts"] }]);
  });

  test("empty and junk input", () => {
    expect(buildTree([])).toEqual([]);
    expect(buildTree(["", "/"])).toEqual([]);
  });

  test("rel is the full path, which is what the pane opens", () => {
    const [dir] = buildTree(["packages/ui/src/a.ts"]);
    expect(dir.rel).toBe("packages/ui/src");
    expect(dir.children[0].rel).toBe("packages/ui/src/a.ts");
  });
});

describe("ancestorsOf", () => {
  test("names every directory on the way to a file", () => {
    expect([...ancestorsOf(["a/b/c.ts"])].sort()).toEqual(["a", "a/b"]);
  });

  test("a file at the root has no ancestors", () => {
    expect([...ancestorsOf(["c.ts"])]).toEqual([]);
  });
});

describe("filesUnder", () => {
  test("collects the files of a subtree in tree order: directories before files", () => {
    expect(filesUnder(buildTree(["a/b.ts", "a/c/d.ts", "e.ts"]))).toEqual(["a/c/d.ts", "a/b.ts", "e.ts"]);
  });
});

describe("globFilter", () => {
  test("includes, excludes, and matches anywhere in the path", () => {
    const ts = globFilter("*.ts")!;
    expect(ts("packages/ui/src/a.ts")).toBe(true);
    expect(ts("packages/ui/src/a.tsx")).toBe(false);

    const both = globFilter("*.ts,*.md")!;
    expect(both("a.md")).toBe(true);
    expect(both("a.ts")).toBe(true);
    expect(both("a.css")).toBe(false);

    const notTests = globFilter("!*.test.ts")!;
    expect(notTests("a.test.ts")).toBe(false);
    expect(notTests("a.ts")).toBe(true);

    // Include and exclude together: exclude wins.
    const mixed = globFilter("*.ts,!*.test.ts")!;
    expect(mixed("a.ts")).toBe(true);
    expect(mixed("a.test.ts")).toBe(false);
    expect(mixed("a.md")).toBe(false);
  });

  test("an empty or all-whitespace glob filters nothing", () => {
    expect(globFilter("")).toBeUndefined();
    expect(globFilter(" , ")).toBeUndefined();
  });
});

describe("matches", () => {
  test("every token must match, and a file-name hit outranks a path hit", () => {
    expect(matches(tokenize("railf"), "packages/ui/src/RailFiles.tsx")).toBeGreaterThan(-Infinity);
    expect(matches(tokenize("zzz"), "packages/ui/src/RailFiles.tsx")).toBe(-Infinity);
    const nameHit = matches(tokenize("rail"), "packages/ui/src/Rail.tsx");
    const pathHit = matches(tokenize("rail"), "packages/rail/src/other.tsx");
    expect(nameHit).toBeGreaterThan(pathHit);
  });
});
