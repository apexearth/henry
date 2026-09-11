// readDirIndex: the files pane's tree for a root that holds no git repo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "henry-files-test-")));
process.env.HENRY_HOME = join(tmp, "home");

const files = await import("../src/files");

const root = join(tmp, "plain");

beforeAll(() => {
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, "target"), { recursive: true });
  writeFileSync(join(root, "README.md"), "hi\n");
  writeFileSync(join(root, "src", "a.ts"), "a\n");
  writeFileSync(join(root, "src", "deep", "b.ts"), "b\n");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "nope\n");
  writeFileSync(join(root, "target", "out.bin"), "nope\n");
});

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows: config.ts still watches HENRY_HOME in this process, which pins the directory.
  }
});

describe("readDirIndex", () => {
  test("walks a plain folder, skipping build and dependency directories", () => {
    const idx = files.readDirIndex(root)!;
    expect(idx.path).toBe(realpathSync(root));
    expect(idx.files).toEqual(["README.md", "src/a.ts", "src/deep/b.ts"]);
    expect(idx.truncated).toBe(false);
    // Forward slashes on every platform, so the UI's one tree builder works unchanged.
    expect(idx.files.every((f) => !f.includes("\\"))).toBe(true);
  });

  test("a missing path, or a file, is not a directory index", () => {
    expect(files.readDirIndex(join(root, "nope"))).toBeUndefined();
    expect(files.readDirIndex(join(root, "README.md"))).toBeUndefined();
    expect(files.readDirIndex("")).toBeUndefined();
    expect(files.readDirIndex("relative/path")).toBeUndefined();
  });

  test("the cache is reported to /api/debug/memory", () => {
    files.readDirIndex(root);
    const s = files.stats();
    expect(s.fsDirCache).toBeGreaterThan(0);
    expect(s.fsDirCachePaths).toBeGreaterThan(0);
  });
});
