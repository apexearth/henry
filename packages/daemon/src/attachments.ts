// Images sent into a session from a window that is not at this machine (a phone). They are
// written here and the session is given their path: Claude Code reads an image by path, and
// the phone has no clipboard the session can reach.
import { mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { henryDir } from "./config";

/** Outside every repo, so an attachment never shows up as an untracked file. */
export const attachmentsDir = join(henryDir, "attachments");

/** The phone shrinks a photo before it sends it; this only stops a mistake filling the disk. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

/** The extension for an image type Claude can read, or undefined. HEIC is not one of them. */
export const imageExt = (contentType: string | null) => EXT[(contentType ?? "").split(";")[0]!.trim().toLowerCase()];

const pad = (n: number) => String(n).padStart(2, "0");

/** Writes the image under the session's folder and returns its absolute path. */
export function saveAttachment(sessionId: string, ext: string, bytes: Uint8Array): string {
  const dir = join(attachmentsDir, sessionId.replace(/[^\w.-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const path = join(dir, `${stamp}-${randomBytes(3).toString("hex")}.${ext}`);
  writeFileSync(path, bytes);
  return path;
}

/** Removes attachments older than `days`, and the session folders that leaves empty. */
export function pruneAttachments(days: number): number {
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  let sessions: string[];
  try {
    sessions = readdirSync(attachmentsDir);
  } catch {
    return 0;
  }
  for (const s of sessions) {
    const dir = join(attachmentsDir, s);
    try {
      const names = readdirSync(dir);
      let left = names.length;
      for (const n of names) {
        const p = join(dir, n);
        if (statSync(p).mtimeMs < cutoff) {
          unlinkSync(p);
          removed++;
          left--;
        }
      }
      if (!left) rmdirSync(dir);
    } catch {}
  }
  return removed;
}
