// PDF peeks: pdf.js drawing pages inside a sandboxed frame. The frame has an opaque origin (no
// allow-same-origin), so a PDF that finds a hole in pdf.js lands in a page that cannot reach
// Henry's API. The browser's own viewer is not an option: WebKit (the Tauri shell on macOS)
// treats it as a plugin, and sandboxed frames get no plugins.
//
// The frame loads nothing itself: Henry posts it pdf.js's source and the PDF's bytes, and it
// imports the library from a blob URL of its own origin.

/** pdf.js and its worker as source text, fetched only when a PDF is shown. */
let lib: Promise<{ lib: string; worker: string }> | undefined;
export function loadPdfJs(): Promise<{ lib: string; worker: string }> {
  lib ??= Promise.all([import("pdfjs-dist/build/pdf.min.mjs?raw"), import("pdfjs-dist/build/pdf.worker.min.mjs?raw")]).then(
    ([l, w]) => ({ lib: l.default, worker: w.default }),
  );
  return lib;
}

/** Zoom is relative to fitting the frame's width (1), and Henry owns it: the header slider and
 *  ⌘+wheel in here both land in the peek's state, which posts `{ zoom }` back. */
export const PDF_ZOOM_MIN = 0.25;
export const PDF_ZOOM_MAX = 4;

/** The frame's whole document. Messages from Henry: `{ lib, worker, data }` once, then
 *  `{ zoom }`. To Henry: `{ wheel: deltaY }` for ⌘/ctrl+wheel (ctrl is a trackpad pinch). */
export const PDF_FRAME = `<!doctype html><meta charset=utf-8>
<style>
  html { background: #3a3a3c; }
  body { margin: 0; padding: 12px; font: 13px system-ui, sans-serif; color: #ddd; }
  /* Block + auto margins, not flex centring: a page wider than the frame must scroll to its left edge. */
  canvas { display: block; margin: 0 auto 12px; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
</style>
<script type=module>
let started = false, pages = [], zoom = 1, fit = 0, gen = 0, timer;
const MAX_PIXELS = 16e6;

function layout() {
  for (const p of pages) {
    const w = p.base.width * Math.min(fit / p.base.width, 2) * zoom;
    p.canvas.style.width = w + "px";
    p.canvas.style.height = (w * p.base.height) / p.base.width + "px";
  }
}

// Sizes change at once (CSS scaling); the sharp redraw follows when the zooming stops.
async function draw() {
  const mine = ++gen;
  for (const p of pages) {
    if (mine !== gen) return;
    p.task?.cancel();
    const cssW = parseFloat(p.canvas.style.width);
    let scale = (cssW / p.base.width) * devicePixelRatio;
    const px = p.base.width * p.base.height * scale * scale;
    if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px);
    const vp = p.page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    canvas.style.cssText = p.canvas.style.cssText;
    p.task = p.page.render({ canvas, viewport: vp });
    try {
      await p.task.promise;
    } catch {
      return; // cancelled by a newer draw
    }
    if (mine !== gen) return;
    canvas.style.cssText = p.canvas.style.cssText;
    p.canvas.replaceWith(canvas);
    p.canvas = canvas;
  }
}

addEventListener("wheel", (e) => {
  if (!e.metaKey && !e.ctrlKey) return;
  e.preventDefault();
  parent.postMessage({ wheel: e.deltaY }, "*");
}, { passive: false });

addEventListener("message", async (e) => {
  if (e.source !== parent) return;
  if (typeof e.data.zoom === "number") {
    if (e.data.zoom === zoom) return;
    const el = document.scrollingElement;
    const at = el.scrollHeight ? el.scrollTop / el.scrollHeight : 0;
    zoom = e.data.zoom;
    layout();
    el.scrollTop = at * el.scrollHeight;
    clearTimeout(timer);
    timer = setTimeout(draw, 150);
    return;
  }
  if (started) return;
  started = true;
  const { lib, worker, data } = e.data;
  const blob = (s) => URL.createObjectURL(new Blob([s], { type: "text/javascript" }));
  try {
    const pdfjs = await import(blob(lib));
    pdfjs.GlobalWorkerOptions.workerSrc = blob(worker);
    const doc = await pdfjs.getDocument({ data }).promise;
    fit = document.body.clientWidth - 24;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      pages.push({ page, base: page.getViewport({ scale: 1 }), canvas });
    }
    layout();
    await draw();
  } catch (err) {
    document.body.textContent = "Could not render this PDF: " + (err && err.message || err);
  }
});
</script>`;
