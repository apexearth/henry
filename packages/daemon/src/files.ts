// File peeks: read one file for the UI to show over the terminal. Loopback-only, the user's
// own machine, so any readable regular file is fair game; size is capped so a stray click on
// a log never ships megabytes.
import { openSync, readSync, closeSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { FilePeek } from "@henry/shared";
import { expandHome } from "./config";
import * as git from "./git";

const CAP_BYTES = 1024 * 1024;

/** `raw` may be `~/x`, absolute, or relative to `cwd` (the session's). Undefined: no such file. */
export function readPeek(raw: string, cwd?: string): FilePeek | undefined {
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
  const buf = Buffer.alloc(Math.min(size, CAP_BYTES));
  const fd = openSync(path, "r");
  let n = 0;
  try {
    n = readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }
  const head = buf.subarray(0, Math.min(n, 8192));
  const binary = head.includes(0);
  const repo = git.resolveRepo(path);
  return {
    path,
    repoPath: repo?.path,
    rel: repo && path.startsWith(repo.path + "/") ? path.slice(repo.path.length + 1) : undefined,
    size,
    truncated: size > n,
    binary,
    content: binary ? "" : buf.subarray(0, n).toString("utf8"),
  };
}
