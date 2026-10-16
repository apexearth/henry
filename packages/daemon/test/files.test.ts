// readDirIndex: the files pane's tree for a root that holds no git repo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

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
  writeFileSync(join(pics, "paper.dat"), "%PDF-1.4\n%\xe2\xe3\n");
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
    expect(blob.pdf).toBeUndefined();
  });

  test("a PDF is flagged by its bytes and carries nothing", () => {
    const p = files.readPeek(join(pics, "paper.dat"))!;
    expect(p.pdf).toBe(true);
    expect(p.binary).toBe(true);
    expect(p.content).toBe("");
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

describe("the tree's file operations", () => {
  const ops = join(tmp, "ops");

  beforeAll(() => {
    mkdirSync(join(ops, "src"), { recursive: true });
    writeFileSync(join(ops, "src", "a.ts"), "a\n");
    writeFileSync(join(ops, "b.md"), "b\n");
  });

  test("makeDir makes a folder and its parents, and refuses one that exists", () => {
    expect(files.makeDir(join(ops, "docs", "specs"))).toEqual({ ok: true, path: join(ops, "docs", "specs") });
    expect(files.makeDir(join(ops, "docs"))).toEqual({ error: "already exists", status: 409 });
    expect("error" in files.makeDir("relative")).toBe(true);
  });

  test("movePath renames and moves, makes the target's folders, and never overwrites", () => {
    expect(files.movePath(join(ops, "b.md"), join(ops, "notes", "b2.md"))).toEqual({ ok: true, path: join(ops, "notes", "b2.md") });
    expect(files.readPeek(join(ops, "notes", "b2.md"))!.content).toBe("b\n");
    writeFileSync(join(ops, "c.md"), "c\n");
    expect(files.movePath(join(ops, "c.md"), join(ops, "notes", "b2.md"))).toEqual({ error: "already exists", status: 409 });
    expect(files.movePath(join(ops, "gone.md"), join(ops, "x.md"))).toEqual({ error: "no longer exists", status: 404 });
    expect(files.movePath(join(ops, "src"), join(ops, "src", "deeper", "src"))).toEqual({ error: "cannot move a folder into itself", status: 400 });
    expect(files.movePath(join(ops, "src"), join(ops, "lib"))).toEqual({ ok: true, path: join(ops, "lib") });
    expect(files.readPeek(join(ops, "lib", "a.ts"))!.content).toBe("a\n");
  });

  test("a case-only rename goes through where names ignore case", () => {
    if (process.platform === "linux") return;
    expect(files.movePath(join(ops, "c.md"), join(ops, "C.md"))).toEqual({ ok: true, path: join(ops, "C.md") });
    expect(files.listDir(ops)!.files).toContain("C.md");
  });

  test("listDir lists one folder, folders apart from files", () => {
    const l = files.listDir(ops)!;
    expect(l.dirs).toEqual(["docs", "lib", "notes"]);
    expect(l.files.map((f) => f.toLowerCase())).toEqual(["c.md"]);
    expect(files.listDir(join(ops, "nope"))).toBeUndefined();
  });

  test("trashPath refuses what is not there and what is too big to trash", async () => {
    expect(await files.trashPath(join(ops, "nope"))).toEqual({ error: "no longer exists", status: 404 });
    expect(await files.trashPath(tmpdir().slice(0, tmpdir().indexOf(sep) + 1))).toEqual({ error: "not that one", status: 400 });
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
