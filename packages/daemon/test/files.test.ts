// readDirIndex: the files pane's tree for a root that holds no git repo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "henry-files-test-")));
process.env.HENRY_HOME = join(tmp, "home");

const files = await import("../src/files");

const root = join(tmp, "plain");
const pics = join(tmp, "pics");

beforeAll(() => {
  mkdirSync(pics, { recursive: true });
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, "target"), { recursive: true });
  writeFileSync(join(root, "README.md"), "hi\n");
  writeFileSync(join(root, "src", "a.ts"), "a\n");
  writeFileSync(join(root, "src", "deep", "b.ts"), "b\n");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "nope\n");
  writeFileSync(join(root, "target", "out.bin"), "nope\n");
  // A 1×1 PNG, and a PNG hiding under the wrong name: the signature decides, not the extension.
  writeFileSync(join(pics, "dot.png"), PNG);
  writeFileSync(join(pics, "dot.dat"), PNG);
  writeFileSync(join(pics, "mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  writeFileSync(join(pics, "blob.bin"), Buffer.from([1, 2, 0, 3]));
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

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

  test("a picture comes back whole as base64 with its type, whatever it is called", () => {
    for (const name of ["dot.png", "dot.dat"]) {
      const p = files.readPeek(join(pics, name))!;
      expect(p.image).toBe("image/png");
      expect(p.binary).toBe(true);
      expect(p.truncated).toBe(false);
      expect(Buffer.from(p.content, "base64").equals(PNG)).toBe(true);
    }
    expect(files.readPeek(join(pics, "mark.svg"))!.image).toBe("image/svg+xml");
  });

  test("text and other binaries are what they were", () => {
    const text = files.readPeek(join(root, "README.md"))!;
    expect(text.image).toBeUndefined();
    expect(text.binary).toBe(false);
    expect(text.content).toBe("hi\n");
    const blob = files.readPeek(join(pics, "blob.bin"))!;
    expect(blob.image).toBeUndefined();
    expect(blob.binary).toBe(true);
    expect(blob.content).toBe("");
  });

  test("the cache is reported to /api/debug/memory", () => {
    files.readDirIndex(root);
    const s = files.stats();
    expect(s.fsDirCache).toBeGreaterThan(0);
    expect(s.fsDirCachePaths).toBeGreaterThan(0);
  });
});
