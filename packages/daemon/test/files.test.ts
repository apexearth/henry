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

describe("writeFile", () => {
  test("creates a file and its folders, refuses one that exists, and the tree sees it", () => {
    const path = join(root, "docs", "spec.md");
    const r = files.writeFile(path, "# spec\n", { create: true });
    expect("peek" in r && r.peek.content).toBe("# spec\n");
    expect(files.writeFile(path, "", { create: true })).toEqual({ error: "already exists", status: 409 });
    expect(files.readDirIndex(root)!.files).toContain("docs/spec.md");
  });

  test("a save carries the mtime it read and is refused once the file has moved on", () => {
    const path = join(root, "src", "a.ts");
    const before = files.readPeek(path)!;
    const r = files.writeFile(path, "a2\n", { ifMtime: before.mtime });
    expect("peek" in r && r.peek.content).toBe("a2\n");
    // The read from before the save is stale now.
    const stale = files.writeFile(path, "a3\n", { ifMtime: before.mtime });
    expect("error" in stale && stale.status).toBe(409);
    expect(files.readPeek(path)!.content).toBe("a2\n");
  });

  test("relative paths and missing files are refused", () => {
    expect("error" in files.writeFile("relative.md", "", { create: true })).toBe(true);
    expect(files.writeFile(join(root, "gone.md"), "", {})).toEqual({ error: "no longer exists", status: 404 });
  });
});

describe("serveRaw", () => {
  const site = join(tmp, "my site");
  const url = (p: string) => files.RAW_PREFIX + p.replace(/\\/g, "/").replace(/^\/+/, "").split("/").map((s) => encodeURIComponent(s).replace(/%3A/g, ":")).join("/");

  beforeAll(() => {
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, "index.html"), "<link rel=stylesheet href=style.css>\n");
    writeFileSync(join(site, "style.css"), "body{}\n");
  });

  test("a page and the files beside it, sandboxed and never cached", async () => {
    expect(files.rawPath(url(join(site, "index.html")))).toBe(join(site, "index.html"));
    const page = files.serveRaw(url(join(site, "index.html")));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toStartWith("sandbox allow-scripts");
    expect(page.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await files.serveRaw(url(join(site, "style.css"))).text()).toBe("body{}\n");
  });

  test("a folder is its index.html, and nothing else is found", async () => {
    expect(await files.serveRaw(url(site)).text()).toContain("style.css");
    expect(files.serveRaw(url(join(site, "missing.js"))).status).toBe(404);
    expect(files.serveRaw(url(pics)).status).toBe(404);
  });
});
