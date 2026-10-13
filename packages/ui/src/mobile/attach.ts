// A photo from the phone, made small enough to send and in a format Claude reads, then handed to
// the daemon, which keeps it on the session's machine and answers with its path.

/** Claude scales anything past ~1568px down itself, so more than this is only upload time. */
const MAX_EDGE = 2000;
const KEEP_AS_IS = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** The image to send: the file itself when it is already a readable type and size, otherwise
 * redrawn as a JPEG. Redrawing is also what turns an iPhone's HEIC into something Claude reads. */
async function prepare(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (KEEP_AS_IS.has(file.type)) return file;
    throw new Error(`this browser cannot read ${file.name || "that image"}`);
  }
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  // A screenshot stays a PNG: text survives it, and JPEG blurs it.
  if (KEEP_AS_IS.has(file.type) && scale === 1 && file.size <= 5 * 1024 * 1024) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", 0.85));
  if (!blob) throw new Error("could not shrink that image");
  return blob;
}

/** Sends the image to the daemon for `sessionId` and returns where it now lives. */
export async function attachImage(sessionId: string, file: File): Promise<string> {
  const blob = await prepare(file);
  const res = await fetch(`/api/attach?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "content-type": blob.type },
    body: blob,
  });
  const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !body.path) throw new Error(body.error ?? `upload failed (${res.status})`);
  return body.path;
}
