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

/** Most matches a find marks, as in a text peek. */
export const PDF_FIND_CAP = 5000;

/** The frame's whole document. Messages from Henry: `{ lib, worker, data }` once, then
 *  `{ zoom }` and `{ find, n }` (the query and which match is current). To Henry:
 *  `{ wheel: deltaY }` for ⌘/ctrl+wheel (ctrl is a trackpad pinch), `{ found }` (match count)
 *  and `{ key }` for the keys Henry owns (⌘F, ⌘K, Esc), which never leave the frame on their own.
 *
 *  Each page is its canvas under pdf.js's text layer: transparent text placed over the
 *  picture, which is what makes text selectable and gives find something to mark. Its sizes
 *  hang off --total-scale-factor, so zoom moves it without a re-layout. */
export const PDF_FRAME = `<!doctype html><meta charset=utf-8>
<style>
  html { background: #3a3a3c; }
  body { margin: 0; padding: 12px; font: 13px system-ui, sans-serif; color: #ddd; }
  /* Block + auto margins, not flex centring: a page wider than the frame must scroll to its left edge. */
  .page { position: relative; margin: 0 auto 12px; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.4); --scale-round-x: 1px; --scale-round-y: 1px; }
  .page canvas { display: block; width: 100%; height: 100%; }
  /* The part of pdf.js's pdf_viewer.css that places the text layer. */
  .textLayer { position: absolute; inset: 0; overflow: clip; line-height: 1; text-align: initial; transform-origin: 0 0;
    --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size)); --min-font-size-inv: calc(1 / var(--min-font-size)); }
  .textLayer :is(span, br) { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0 0; }
  .textLayer > :not(.markedContent), .textLayer .markedContent span:not(.markedContent) {
    --font-height: 0; font-size: calc(var(--text-scale-factor) * var(--font-height));
    --scale-x: 1; --rotate: 0deg; transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv)); }
  .textLayer .markedContent { display: contents; }
  .textLayer ::selection { background: rgba(110,168,254,.35); color: transparent; }
  ::highlight(hit) { background-color: rgba(110,168,254,.35); }
  ::highlight(cur) { background-color: rgba(255,150,0,.55); }
</style>
<script type=module>
let started = false, pdfjs, pages = [], zoom = 1, fit = 0, gen = 0, timer;
let textDone;
const textReady = new Promise((r) => (textDone = r));
const MAX_PIXELS = 16e6, FIND_CAP = ${PDF_FIND_CAP};

function layout() {
  for (const p of pages) {
    const w = p.base.width * Math.min(fit / p.base.width, 2) * zoom;
    p.el.style.width = w + "px";
    p.el.style.height = (w * p.base.height) / p.base.width + "px";
    p.el.style.setProperty("--total-scale-factor", w / p.base.width);
  }
}

// Sizes change at once (CSS scaling); the sharp redraw follows when the zooming stops.
async function draw() {
  const mine = ++gen;
  for (const p of pages) {
    if (mine !== gen) return;
    p.task?.cancel();
    const cssW = parseFloat(p.el.style.width);
    let scale = (cssW / p.base.width) * devicePixelRatio;
    const px = p.base.width * p.base.height * scale * scale;
    if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px);
    const vp = p.page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    p.task = p.page.render({ canvas, viewport: vp });
    try {
      await p.task.promise;
    } catch {
      return; // cancelled by a newer draw
    }
    if (mine !== gen) return;
    p.canvas.replaceWith(canvas);
    p.canvas = canvas;
  }
}

// Alongside the drawing rather than after it, so a find in a long PDF need not wait for every
// page to paint; a find waits for all the text.
async function texts() {
  for (const p of pages) {
    const div = document.createElement("div");
    div.className = "textLayer";
    p.el.append(div);
    try {
      await new pdfjs.TextLayer({ textContentSource: p.page.streamTextContent(), container: div, viewport: p.base }).render();
      p.text = div;
    } catch {}
  }
  textDone();
}

// Find: smart case, over each page's text in reading order (a line break counts as a space),
// marked with the CSS highlight API so the text layer's DOM is never split up.
let query = "", wanted, hits = [];
function search(q) {
  const out = [];
  if (!q) return out;
  const sensitive = q !== q.toLowerCase();
  const needle = sensitive ? q : q.toLowerCase();
  for (const p of pages) {
    if (!p.text) continue;
    let s = "";
    const at = [];
    const walk = document.createTreeWalker(p.text, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        at.push([s.length, node]);
        s += node.data;
      } else if (node.nodeName === "BR") s += " ";
    }
    const hay = sensitive ? s : s.toLowerCase();
    for (let i = hay.indexOf(needle); i >= 0 && out.length < FIND_CAP; i = hay.indexOf(needle, i + needle.length)) {
      const r = document.createRange();
      r.setStart(...spot(at, i, false));
      r.setEnd(...spot(at, i + needle.length, true));
      out.push(r);
    }
  }
  return out;
}
// The text node holding offset i of the page's string; an end belongs to the node it closes.
function spot(at, i, end) {
  let k = at.length - 1;
  while (k > 0 && (end ? at[k][0] >= i : at[k][0] > i)) k--;
  const [start, node] = at[k];
  return [node, Math.max(0, Math.min(i - start, node.data.length))];
}
async function find(q, n) {
  wanted = { q, n };
  await textReady;
  if (wanted.q !== q || wanted.n !== n) return; // a newer one is on its way
  if (q !== query) {
    query = q;
    hits = search(q);
  }
  const hl = globalThis.CSS?.highlights;
  hl?.delete("hit");
  hl?.delete("cur");
  parent.postMessage({ found: hits.length }, "*");
  if (!hits.length) return;
  const cur = hits[((n % hits.length) + hits.length) % hits.length];
  if (hl) {
    hl.set("hit", new Highlight(...hits));
    hl.set("cur", new Highlight(cur));
  }
  const r = cur.getBoundingClientRect();
  const dx = r.left < 0 || r.right > innerWidth ? r.left + r.width / 2 - innerWidth / 2 : 0;
  scrollBy({ left: dx, top: r.top + r.height / 2 - innerHeight / 2 });
}

addEventListener("wheel", (e) => {
  if (!e.metaKey && !e.ctrlKey) return;
  e.preventDefault();
  parent.postMessage({ wheel: e.deltaY }, "*");
}, { passive: false });

addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (e.key !== "Escape" && !((e.metaKey || e.ctrlKey) && (k === "f" || k === "k"))) return;
  e.preventDefault();
  const { key, metaKey, ctrlKey, shiftKey, altKey } = e;
  parent.postMessage({ key: { key, metaKey, ctrlKey, shiftKey, altKey } }, "*");
});

addEventListener("message", async (e) => {
  if (e.source !== parent) return;
  if (typeof e.data.find === "string") return void find(e.data.find, e.data.n | 0);
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
    pdfjs = await import(blob(lib));
    pdfjs.GlobalWorkerOptions.workerSrc = blob(worker);
    const doc = await pdfjs.getDocument({ data }).promise;
    fit = document.body.clientWidth - 24;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const el = document.createElement("div");
      el.className = "page";
      const canvas = document.createElement("canvas");
      el.append(canvas);
      document.body.append(el);
      pages.push({ page, base: page.getViewport({ scale: 1 }), el, canvas });
    }
    layout();
    void texts();
    await draw();
  } catch (err) {
    textDone();
    document.body.textContent = "Could not render this PDF: " + (err && err.message || err);
  }
});
</script>`;
