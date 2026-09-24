// File peeks: read one file for the UI to show over the terminal. Loopback-only, the user's
// own machine, so any readable regular file is fair game; size is capped so a stray click on
// a log never ships megabytes.
import { openSync, readSync, closeSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DirIndex, FilePeek } from "@henry/shared";
import { expandHome } from "./config";
import * as git from "./git";

const CAP_BYTES = 1024 * 1024;
/** Pictures go out whole or not at all (a cut PNG is nothing), so they get a larger cap. A
 * peek relayed to a paired machine travels as base64 inside one federation frame, so it gets
 * the smaller one (server.ts passes it). */
export const IMAGE_CAP_BYTES = 8 * 1024 * 1024;
export const RELAYED_IMAGE_CAP_BYTES = 2 * 1024 * 1024;

/** The picture formats a browser draws, told apart by their first bytes rather than their
 * names, so a screenshot saved as `.dat` still shows. SVG is text and goes by extension. */
function imageType(head: Buffer, size: number, path: string): string | undefined {
  const at = (i: number, s: string) => head.length >= i + s.length && head.toString("latin1", i, i + s.length) === s;
  if (at(0, "\x89PNG\r\n\x1a\n")) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  // "BM" is two letters a README can open with; the header's own size field settles it.
  if (at(0, "BM") && head.length >= 6 && head.readUInt32LE(2) === size) return "image/bmp";
  if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) return "image/x-icon";
  if (at(4, "ftypavif")) return "image/avif";
  if (/\.svg$/i.test(path) && !head.includes(0)) return "image/svg+xml";
  return undefined;
}

function readHead(path: string, size: number, cap: number): Buffer {
  const buf = Buffer.alloc(Math.min(size, cap));
  const fd = openSync(path, "r");
  try {
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** `raw` may be `~/x`, absolute, or relative to `cwd` (the session's). Undefined: no such file. */
export function readPeek(raw: string, cwd?: string, imageCap = IMAGE_CAP_BYTES): FilePeek | undefined {
  const expanded = expandHome(raw.trim());
  if (!expanded) return undefined;
  const abs = isAbsolute(expanded) ? expanded : cwd ? resolve(expandHome(cwd), expanded) : undefined;
  if (!abs) return undefined;
  let path: string;
  let size: number;
  try {
    path = realpathSync(abs);
    const st = statSync(path);
    if (!st.isFile()) return undefined;
    size = st.size;
  } catch {
    return undefined;
  }
  let bytes = readHead(path, size, CAP_BYTES);
  const image = imageType(bytes.subarray(0, 16), size, path);
  const repo = git.resolveRepo(path);
  const base = { path, repoPath: repo?.path, rel: repo ? git.relIn(repo.path, path) : undefined, size };
  if (image) {
    if (size > imageCap) return { ...base, truncated: true, binary: true, image, content: "" };
    if (bytes.length < size) bytes = readHead(path, size, imageCap);
    return { ...base, truncated: false, binary: true, image, content: bytes.toString("base64") };
  }
  const binary = bytes.subarray(0, 8192).includes(0);
  return { ...base, truncated: size > bytes.length, binary, content: binary ? "" : bytes.toString("utf8") };
}

// ---- the files pane's tree, for roots that are not git repos ----
// A repo uses git.listFiles, which gets .gitignore and the untracked/ignored distinction for
// free. A plain folder has none of that, so the walk carries its own skip list: the directories
// that are always build output or dependencies, and never what you opened the pane to read.

const DIR_CAP_FILES = 20_000;
const DIR_TTL_MS = 10_000;
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
  "target", "dist", "build", "out", ".next", ".nuxt", ".turbo", ".cache", ".gradle", ".idea",
  "vendor", "Pods", "DerivedData", ".terraform", ".tox", ".svn", ".hg",
]);

const dirCache = new Map<string, { at: number; index: DirIndex }>();

/** Every file under `raw`, relative and forward-slashed, skipping build and dependency dirs.
 *  Breadth-first so a shallow, wide tree still reads usefully when the cap cuts it off. */
export function readDirIndex(raw: string): DirIndex | undefined {
  const expanded = expandHome(raw.trim());
  if (!expanded || !isAbsolute(expanded)) return undefined;
  let root: string;
  try {
    root = realpathSync(expanded);
    if (!statSync(root).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const hit = dirCache.get(root);
  if (hit && Date.now() - hit.at < DIR_TTL_MS) return hit.index;

  const files: string[] = [];
  let truncated = false;
  const queue: string[] = [""];
  // Symlinked directories are not followed: a link back up the tree would walk forever.
  while (queue.length && !truncated) {
    const rel = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip it, the rest of the tree is still worth showing
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(child);
      } else if (e.isFile()) {
        if (files.length >= DIR_CAP_FILES) {
          truncated = true;
          break;
        }
        files.push(child);
      }
    }
  }
  files.sort();
  const index: DirIndex = { path: root, files, truncated };
  dirCache.set(root, { at: Date.now(), index });
  return index;
}

/** For GET /api/debug/memory. */
export function stats(): Record<string, number> {
  let cached = 0;
  for (const v of dirCache.values()) cached += v.index.files.length;
  return { fsDirCache: dirCache.size, fsDirCachePaths: cached };
}

// ---- raw files: an HTML peek's preview, loaded the way file:// would load it ----
// The page's relative links (its CSS, scripts, pictures) resolve under the same prefix, so a
// page and the files beside it load as they would from disk. Every answer carries a CSP
// sandbox, which gives the page an opaque origin: it runs its scripts but is never Henry's
// origin, so it cannot read Henry's API, and server.ts refuses the `Origin: null` it sends.

export const RAW_PREFIX = "/raw/";

/** `/raw/<absolute path as a file URL path>` → that path on this machine. */
export function rawPath(pathname: string): string | undefined {
  try {
    return fileURLToPath(new URL("file:///" + pathname.slice(RAW_PREFIX.length)));
  } catch {
    return undefined;
  }
}

export function serveRaw(pathname: string): Response {
  let path = rawPath(pathname);
  try {
    if (path && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!path || !statSync(path).isFile()) throw new Error();
  } catch {
    return new Response("not found", { status: 404 });
  }
  return new Response(Bun.file(path), {
    headers: {
      "content-security-policy": "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
      "cache-control": "no-store",
    },
  });
}
