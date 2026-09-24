// A file peek: one file shown over the session in the stage group, read-only until you press
// edit (Editor.tsx takes the body; ⌘S saves, a file changed on disk meanwhile is not overwritten).
// Opened by ⌘-clicking a path (terminal output, diff headers); Esc or × closes it. ⌘F over
// the peek in view opens a find bar (App.tsx routes it here as a `henry:find` event).
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileDiff, FilePeek } from "@henry/shared";
import { parseDiff } from "./DiffView";
import { closePeek, filePanelId, peekFile, popoutPeek } from "./dock";
import type { EditorHandle } from "./Editor";
import { noteRecent } from "./files";
import { highlightLines, languageFor } from "./highlight";
import { Markdown } from "./Markdown";
import { loadPdfJs, PDF_FRAME, PDF_ZOOM_MAX, PDF_ZOOM_MIN } from "./pdf";
import { baseName, MOD, mod } from "./platform";
import { getState } from "./ws";

// CodeMirror is a third of the bundle and most peeks are never edited.
const Editor = lazy(() => import("./Editor").then((m) => ({ default: m.Editor })));

/** `path:line[:col]` → parts. Windows-style drive letters aren't a concern here. */
export function splitLineRef(ref: string): { path: string; line?: number } {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(ref);
  return m ? { path: m[1], line: Number(m[2]) } : { path: ref };
}

export async function fetchPeek(path: string, cwd?: string, local = false): Promise<FilePeek | null> {
  const q = new URLSearchParams({ path });
  if (cwd) q.set("cwd", cwd);
  // Files are read where the session you are looking at runs: a relayed session's machine.
  // The explorer browses this machine's repos, so it asks for local reads.
  const peer = local ? undefined : getState().sessions.find((x) => x.id === getState().activeSessionId)?.peer;
  if (peer) q.set("peer", peer);
  const r = await fetch(`/api/file?${q}`);
  return r.ok ? ((await r.json()) as FilePeek) : null;
}

/** An HTML page runs from `/raw/<path>` (daemon files.ts), so its relative links load the files
 *  beside it as file:// would. Only this machine's files, and only through the loopback
 *  listener: a relayed session's file is on another disk, and the phone's cookie does not ride
 *  along with a sandboxed page's requests. */
function rawServed(local: boolean): boolean {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) return false;
  return local || !getState().sessions.find((x) => x.id === getState().activeSessionId)?.peer;
}

function rawUrl(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/^\/+/, "").split("/");
  return "/raw/" + parts.map((p) => encodeURIComponent(p).replace(/%3A/g, ":")).join("/");
}

// Fetched once by openPeek so the panel paints without a second round trip.
const primed = new Map<string, FilePeek>();
/** Peeks that open straight into the editor: a file just made from the tree. */
const wantEdit = new Set<string>();

/** Resolve `raw` (maybe relative to `cwd`) and open it; a path that isn't a file opens nothing. */
export async function openPeek(raw: string, cwd?: string, line?: number, edit = false): Promise<boolean> {
  const peek = await fetchPeek(raw, cwd);
  if (!peek) {
    console.info(`[henry] no file at ${raw}${cwd ? ` (cwd ${cwd})` : ""}`);
    return false;
  }
  primed.set(peek.path, peek);
  if (edit) wantEdit.add(peek.path);
  noteRecent(peek.path);
  peekFile(peek.path, line);
  return true;
}

/** Save `content` over `path`. `ifMtime` refuses a file changed since it was read (409). */
export async function saveFile(path: string, content: string, ifMtime?: number): Promise<{ peek: FilePeek } | { error: string; status: number }> {
  const r = await fetch("/api/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, content, ifMtime }) });
  const body = (await r.json().catch(() => ({}))) as FilePeek & { error?: string };
  return r.ok ? { peek: body } : { error: body.error ?? r.statusText, status: r.status };
}

/** Line tints from a unified diff: new-side line numbers that were added, and deleted lines
 *  keyed by the new-side line they now sit before (lines.length + 1 = after the last line). */
function tintsOf(diff: string): { adds: Set<number>; dels: Map<number, string[]>; nDel: number } | null {
  const f = parseDiff(diff).files[0];
  if (!f?.hunks.length) return null;
  const adds = new Set<number>();
  const dels = new Map<number, string[]>();
  let nDel = 0;
  for (const h of f.hunks) {
    let cursor = Number(/\+(\d+)/.exec(h.header)?.[1] ?? 1);
    for (const l of h.lines) {
      if (l.kind === "add" && l.newNo) {
        adds.add(l.newNo);
        cursor = l.newNo + 1;
      } else if (l.kind === "ctx" && l.newNo) cursor = l.newNo + 1;
      else if (l.kind === "del") {
        let list = dels.get(cursor);
        if (!list) dels.set(cursor, (list = []));
        list.push(l.text);
        nDel++;
      }
    }
  }
  return { adds, dels, nDel };
}

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "open" shows (or refocuses) the find bar of the peek in view; "close" hides it. */
export type FindAction = "open" | "close";
export const FIND_EVENT = "henry:find";
export function sendFind(action: FindAction): void {
  window.dispatchEvent(new CustomEvent<FindAction>(FIND_EVENT, { detail: action }));
}

/** Esc over the peek in view. True when an editor took it (closed its find, or is holding
 *  unsaved text and will not be closed by a stray key); false leaves it to the find bar and
 *  the peek. */
export const ESC_EVENT = "henry:peek-esc";
export function sendEsc(): boolean {
  return !window.dispatchEvent(new CustomEvent(ESC_EVENT, { cancelable: true }));
}

const FIND_CAP = 5000;
type Span = [start: number, end: number];

/** Whether markdown (or HTML) opens as a page, as source, or both side by side; one choice
 *  for every peek of that kind, per browser. */
const VIEW_KEYS = { md: "henry.mdView", html: "henry.htmlView" } as const;
type PageKind = keyof typeof VIEW_KEYS;
const MD_VIEWS = ["page", "split", "source"] as const;
type MdView = (typeof MD_VIEWS)[number];
function loadMdView(kind: PageKind): MdView {
  try {
    const v = localStorage.getItem(VIEW_KEYS[kind]);
    return (MD_VIEWS as readonly string[]).includes(v ?? "") ? (v as MdView) : "page";
  } catch {
    return "page";
  }
}

/** Whether a PDF peek renders straight away or waits for "view", per browser. Off by default:
 *  a stray click in the tree should not hand an unread file to the PDF parser. */
const PDF_AUTO_KEY = "henry.pdfAuto";
export function loadPdfAuto(): boolean {
  try {
    return localStorage.getItem(PDF_AUTO_KEY) === "1";
  } catch {
    return false;
  }
}
export function savePdfAuto(on: boolean): void {
  try {
    localStorage.setItem(PDF_AUTO_KEY, on ? "1" : "0");
  } catch {}
}

/** Every occurrence of `q` (smart case), in file order, keyed by 1-based line. */
function findAll(lines: string[], q: string): { at: { line: number; i: number }[]; byLine: Map<number, Span[]> } {
  const at: { line: number; i: number }[] = [];
  const byLine = new Map<number, Span[]>();
  if (!q) return { at, byLine };
  const sensitive = q !== q.toLowerCase();
  const needle = sensitive ? q : q.toLowerCase();
  for (let n = 0; n < lines.length && at.length < FIND_CAP; n++) {
    const s = sensitive ? lines[n] : lines[n].toLowerCase();
    let i = s.indexOf(needle);
    if (i < 0) continue;
    const spans: Span[] = [];
    while (i >= 0 && at.length < FIND_CAP) {
      at.push({ line: n + 1, i: spans.length });
      spans.push([i, i + needle.length]);
      i = s.indexOf(needle, i + needle.length);
    }
    byLine.set(n + 1, spans);
  }
  return { at, byLine };
}

interface Props {
  path: string;
  line?: number;
  /** In view and in the active group: takes focus so Esc and scrolling keys work. */
  active: boolean;
  /** Explorer preview: read on this machine, changes vs HEAD, and no dock buttons. */
  local?: boolean;
  /** In a window of its own: no pop-out button. */
  popped?: boolean;
  /** Offers the edit button. Not on the phone, and never for a peer's file: peers read. */
  editable?: boolean;
}

export function FileView({ path, line, active, local = false, popped = false, editable = false }: Props) {
  const [peek, setPeek] = useState<FilePeek | null | undefined>(() => primed.get(path));
  // Highlighted HTML per line; null until ready or when the file is plain text. Painted after
  // the text so a big file shows up immediately and colours in a beat later.
  const [html, setHtml] = useState<string[] | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const hit = useRef<HTMLDivElement>(null);
  const cur = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let on = true;
    const cached = primed.get(path);
    primed.delete(path);
    wantEdit.delete(path);
    if (cached) setPeek(cached);
    else fetchPeek(path, undefined, local).then((p) => on && setPeek(p));
    return () => {
      on = false;
    };
  }, [path, local]);

  useEffect(() => {
    let on = true;
    setHtml(null);
    if (peek && !peek.binary && peek.content) highlightLines(peek.path, peek.content).then((h) => on && setHtml(h));
    return () => {
      on = false;
    };
  }, [peek]);

  // Changes vs the active session's baseline (HEAD when none): added lines tinted in place,
  // deleted lines as struck-through ghosts where they used to be.
  const [fd, setFd] = useState<FileDiff | null>(null);
  useEffect(() => {
    setFd(null);
    if (!peek?.repoPath || peek.image) return;
    let on = true;
    const q = new URLSearchParams({ path: peek.path });
    const sid = local ? null : getState().activeSessionId;
    if (sid) q.set("sessionId", sid);
    fetch(`/api/file/diff?${q}`)
      .then((r) => (r.ok ? (r.json() as Promise<FileDiff>) : null))
      .then((d) => on && setFd(d))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [peek, local]);
  const tint = useMemo(() => (fd?.diff ? tintsOf(fd.diff) : null), [fd]);

  // Editing. `draft` is the editor's text, so dirty is "not what was read"; on save the peek
  // is replaced by what the daemon read back (new mtime), which makes the draft clean again.
  const [editing, setEditing] = useState(() => wantEdit.has(path));
  const [draft, setDraft] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<{ busy?: boolean; error?: string; conflict?: boolean } | null>(null);
  const [nudge, setNudge] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const canEdit = editable && !!peek && !peek.binary && !peek.image && !peek.truncated
    && !getState().sessions.find((x) => x.id === getState().activeSessionId)?.peer;
  // CodeMirror joins lines with LF whatever the file used; a CRLF file is compared and written
  // back in its own line ends, or it would read as edited on opening and come out changed.
  const crlf = !!peek?.content.includes("\r\n");
  const text = useMemo(() => (crlf ? peek!.content.replace(/\r\n/g, "\n") : peek?.content ?? ""), [peek, crlf]);
  const dirty = editing && draft !== null && draft !== text;
  const startEdit = () => {
    setDraft(text);
    setFind(null);
    setEditing(true);
  };
  const stopEdit = () => {
    setEditing(false);
    setDraft(null);
    setSaveState(null);
    requestAnimationFrame(() => body.current?.focus());
  };
  // A key or × on unsaved text does not lose it; the header points at save / discard instead.
  const holdUnsaved = () => {
    setNudge(true);
    setTimeout(() => setNudge(false), 900);
  };
  const save = async (force = false) => {
    if (!peek || draft === null || saveState?.busy) return;
    setSaveState({ busy: true });
    const r = await saveFile(peek.path, crlf ? draft.replace(/\n/g, "\r\n") : draft, force ? undefined : peek.mtime);
    if ("peek" in r) {
      setPeek(r.peek);
      setSaveState(null);
    } else setSaveState({ error: r.error, conflict: r.status === 409 });
  };
  const tryClose = () => (dirty ? holdUnsaved() : closePeek(filePanelId(path)));
  useEffect(() => {
    if (!active || !editing) return;
    const onEsc = (e: Event) => {
      e.preventDefault();
      if (editor.current?.isFinding()) return editor.current.find("close");
      if (dirty) return holdUnsaved();
      stopEdit();
    };
    window.addEventListener(ESC_EVENT, onEsc);
    return () => window.removeEventListener(ESC_EVENT, onEsc);
  }, [active, editing, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dockview hides inactive panels, which drops their scroll position: re-centre on return.
  // The explorer's preview is never active but still follows the line of the hit it shows.
  useEffect(() => {
    if (active) (editing ? editor.current?.focus() : body.current?.focus());
    if ((active || local) && peek && line) hit.current?.scrollIntoView({ block: "center" });
  }, [active, local, peek, line, editing]);

  const lines = useMemo(() => {
    const ls = peek?.content && !peek.image ? peek.content.split("\n") : [];
    if (ls.length && ls[ls.length - 1] === "") ls.pop();
    return ls;
  }, [peek]);

  // A picture: drawn from the bytes the peek carried, at its own size until that is wider than
  // the pane. The header says how big it really is once the browser has decoded it. The size is
  // kept with the src it was measured from, so a decode that lands before a reset is not lost.
  const imgSrc = useMemo(() => (peek?.image && peek.content ? `data:${peek.image};base64,${peek.content}` : null), [peek]);
  const [measured, setMeasured] = useState<{ src: string; w: number; h: number } | null>(null);
  const dims = measured && measured.src === imgSrc ? measured : null;
  const [fit, setFit] = useState(true);

  // Find within the file: the bar lives only on the peek in view, so leaving it closes the bar.
  const [find, setFind] = useState<{ q: string; n: number } | null>(null);
  useEffect(() => {
    if (!active) {
      setFind(null);
      return;
    }
    const onFind = (e: Event) => {
      const action = (e as CustomEvent<FindAction>).detail;
      if (editor.current) return editor.current.find(action);
      if (action === "close") {
        setFind(null);
        body.current?.focus();
        return;
      }
      setFind((f) => f ?? { q: "", n: 0 });
      requestAnimationFrame(() => findInput.current?.select());
    };
    window.addEventListener(FIND_EVENT, onFind);
    return () => window.removeEventListener(FIND_EVENT, onFind);
  }, [active]);
  const found = useMemo(() => findAll(lines, find?.q ?? ""), [lines, find?.q]);
  const curIdx = find && found.at.length ? ((find.n % found.at.length) + found.at.length) % found.at.length : -1;
  const curAt = curIdx >= 0 ? found.at[curIdx] : undefined;
  useEffect(() => {
    cur.current?.scrollIntoView({ block: "center" });
  }, [curAt]);
  const onFindKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      setFind((f) => f && { ...f, n: f.n + (e.shiftKey ? -1 : 1) });
    }
  };
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  const name = path.slice(dir.length);
  const shown = peek?.rel ? { dir: peek.rel.slice(0, peek.rel.lastIndexOf("/") + 1), name } : { dir, name };

  // Markdown and HTML are a page unless you asked for a line, or you are finding in it: both
  // are about the source, so the page alone gives way to it (a split already shows it). The
  // choice is remembered for the next peek of that kind.
  const isText = !!peek && !peek.binary && !peek.image;
  const isMd = isText && languageFor(path) === "markdown";
  const isHtml = isText && /\.html?$/i.test(path) && rawServed(local);
  const kind: PageKind = isHtml ? "html" : "md";
  const [mdView, setMdView] = useState<MdView>(() => (line ? "source" : loadMdView(kind)));
  useEffect(() => {
    if (!line) setMdView(loadMdView(kind));
  }, [kind, line]);
  const chooseMdView = (next: MdView) => {
    setMdView(next);
    try {
      localStorage.setItem(VIEW_KEYS[kind], next);
    } catch {}
  };
  const [reloads, setReloads] = useState(0);
  // A PDF's bytes come from `/raw`: same machine and listener rules as HTML.
  const isPdf = !!peek?.pdf;
  const pdfServed = isPdf && rawServed(local);
  const [pdfOpen, setPdfOpen] = useState(loadPdfAuto);
  // 1 = the page fits the pane's width.
  const [pdfZoom, setPdfZoom] = useState(1);
  useEffect(() => {
    setPdfOpen(loadPdfAuto());
    setPdfZoom(1);
  }, [path]);
  // The editor is the source: a page alone gives way to it, a split shows the page of what is
  // being typed, a beat behind the keys.
  const showPage = (isMd || isHtml) && (mdView === "split" || (mdView === "page" && !find && !editing));
  const showSource = !showPage || mdView === "split";
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!editing || !showPage || draft === null) return void setPreview(null);
    const t = setTimeout(() => setPreview(draft), 200);
    return () => clearTimeout(t);
  }, [editing, showPage, draft]);
  // Images and links in the page resolve against the file's folder, on the machine it was read from.
  const loadImage = useCallback(
    (src: string) => fetchPeek(src, dir, local).then((p) => (p?.image && p.content ? `data:${p.image};base64,${p.content}` : null)),
    [dir, local],
  );
  const openLink = useCallback((href: string) => void openPeek(href.replace(/[#?].*$/, ""), dir), [dir]);

  return (
    <div className={"peek" + (editing ? " editing" : "")}
      onKeyDown={(e) => {
        // ⌘S from the header too, not just from inside the editor.
        if (editing && mod(e) && !e.altKey && !e.shiftKey && (e.key === "s" || e.key === "S")) {
          e.preventDefault();
          void save();
        }
      }}>
      <div className="peek-head">
        {!local && !popped && <button className="peek-back" onClick={tryClose} title="back to the session (Esc)">←</button>}
        <span className="peek-path" title={path}>
          {shown.dir}<b>{shown.name}</b>
        </span>
        {peek?.repoPath && <span className="peek-meta" style={{ marginLeft: 0 }}>{baseName(peek.repoPath)}</span>}
        {tint && (
          <span className="peek-meta peek-diffstat" style={{ marginLeft: 0 }} title={local ? "uncommitted" : `vs baseline ${fd?.baseline.slice(0, 7)}`}>
            {tint.adds.size > 0 && <span className="a">+{tint.adds.size}</span>}
            {tint.nDel > 0 && <span className="d">−{tint.nDel}</span>}
          </span>
        )}
        <span className="peek-meta">
          {peek?.image
            ? `${peek.image.slice(6).replace("+xml", "").replace("x-icon", "ico")}${dims ? ` · ${dims.w}×${dims.h}` : ""} · ${fmtSize(peek.size)}`
            : peek?.pdf ? `pdf · ${fmtSize(peek.size)}`
            : peek ? `${lines.length} lines · ${fmtSize(peek.size)}${peek.truncated ? " · truncated" : ""}` : peek === null ? "not found" : "loading…"}
        </span>
        {imgSrc && dims && (
          <button className="peek-back" onClick={() => setFit((f) => !f)} title={fit ? "show at actual size" : "fit to the pane"}>{fit ? "1:1" : "fit"}</button>
        )}
        {pdfServed && pdfOpen && (
          <span className="peek-zoom" title="zoom (⌘+scroll over the page)">
            <input type="range" min={Math.log(PDF_ZOOM_MIN)} max={Math.log(PDF_ZOOM_MAX)} step={0.01} value={Math.log(pdfZoom)}
              onChange={(e) => setPdfZoom(clampZoom(Math.exp(Number(e.target.value))))} />
            <button className="peek-back" onClick={() => setPdfZoom(1)} title="fit to the pane">{Math.round(pdfZoom * 100)}%</button>
          </span>
        )}
        {isHtml && showPage && (
          <button className="peek-back" onClick={() => setReloads((n) => n + 1)} title="reload the page">↻</button>
        )}
        {(isMd || isHtml) && (
          <span className="peek-seg" title={isHtml ? "how to show the HTML" : "how to show the markdown"}>
            {MD_VIEWS.map((v) => (
              <button key={v} className={v === mdView ? "on" : undefined} onClick={() => chooseMdView(v)}>{v}</button>
            ))}
          </span>
        )}
        {canEdit && !editing && <button className="peek-back" onClick={startEdit} title="edit this file here">edit</button>}
        {editing && (
          <span className={"peek-edit" + (nudge ? " nudge" : "")}>
            {saveState?.error && (
              <span className="peek-save-err" title={saveState.error}>
                {saveState.conflict ? "changed on disk" : saveState.error}
                {saveState.conflict && <button className="peek-back" onClick={() => void save(true)} title="write your text over what is on disk now">save anyway</button>}
              </span>
            )}
            {dirty ? (
              <>
                <span className="peek-unsaved" title="unsaved changes">●</span>
                <button className="peek-back on" onClick={() => void save()} disabled={saveState?.busy} title={`save (${MOD}S)`}>{saveState?.busy ? "saving…" : "save"}</button>
                <button className="peek-back" onClick={stopEdit} title="drop the unsaved changes and go back to reading">discard</button>
              </>
            ) : (
              <button className="peek-back" onClick={stopEdit} title="back to reading (Esc)">done</button>
            )}
          </span>
        )}
        {!local && !popped && <button className="peek-back" onClick={() => popoutPeek(path)} title="open in its own window">⧉</button>}
        {!local && <button className="peek-close" onClick={tryClose} title="close (Esc)">×</button>}
      </div>
      {find && (
        <div className="peek-find">
          <input ref={findInput} value={find.q} spellCheck={false} placeholder="find in file" autoFocus
            onChange={(e) => setFind({ q: e.target.value, n: 0 })} onKeyDown={onFindKey} />
          <span className="hint">
            {find.q ? found.at.length ? `${curIdx + 1} of ${found.at.length}${found.at.length >= FIND_CAP ? "+" : ""}` : "no match" : ""}
          </span>
          <span style={{ flex: 1 }} />
          <span className="hint">↩ next · ⇧↩ previous · Esc closes</span>
        </div>
      )}
      <div className={"peek-body" + (showPage && showSource ? " split" : "")} ref={body} tabIndex={0}>
        {peek === null && <div className="peek-note">This file no longer exists.</div>}
        {imgSrc && (
          <div className={"peek-img" + (fit ? " fit" : "")}>
            <img src={imgSrc} alt={name} onLoad={(e) => setMeasured({ src: imgSrc, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          </div>
        )}
        {peek?.image && !imgSrc && <div className="peek-note">{peek.truncated ? `Image is ${fmtSize(peek.size)}, over what a peek carries.` : "Empty image file."}</div>}
        {peek?.binary && !peek.image && !isPdf && <div className="peek-note">Binary file, nothing to show.</div>}
        {isPdf && !pdfServed && <div className="peek-note">PDFs are shown only in a Henry window on the machine that holds them.</div>}
        {pdfServed && !pdfOpen && (
          <div className="peek-note">
            PDF, {fmtSize(peek!.size)}, not rendered yet. <button onClick={() => setPdfOpen(true)}>view</button>
            <div style={{ marginTop: 8, fontSize: 11 }}>Settings can render PDFs as soon as they open.</div>
          </div>
        )}
        {pdfServed && pdfOpen && (
          <div className="peek-pane peek-html">
            <PdfFrame path={peek!.path} title={name} zoom={pdfZoom} onZoom={setPdfZoom} />
          </div>
        )}
        {editing && peek && showSource && (
          <div className="peek-pane">
            <Suspense fallback={<div className="peek-note">loading the editor…</div>}>
              <Editor ref={editor} path={peek.path} doc={draft ?? text} onChange={setDraft} onSave={() => void save()} />
            </Suspense>
          </div>
        )}
        {peek && !peek.binary && !peek.image && showSource && !editing && (
          <pre className="peek-pane">
            {lines.map((t, i) => (
              <Line key={i} no={i + 1} text={t} html={html && i < html.length ? html[i] : undefined} hit={i + 1 === line}
                add={tint?.adds.has(i + 1) ?? false} dels={tint?.dels.get(i + 1)} hitRef={hit}
                marks={found.byLine.get(i + 1)} cur={curAt?.line === i + 1 ? curAt.i : undefined} curRef={cur} />
            ))}
            {tint?.dels.get(lines.length + 1)?.map((t, i) => (
              <div key={"tail" + i} className="peek-line del"><span className="peek-no" />{t}</div>
            ))}
          </pre>
        )}
        {showPage && peek && isHtml && (
          <div className="peek-pane peek-html">
            {/* Opaque origin (no allow-same-origin): the page runs, but never as Henry. */}
            <iframe key={reloads} src={rawUrl(peek.path)} title={name} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" />
          </div>
        )}
        {showPage && peek && !isHtml && (
          <div className="peek-pane">
            <Markdown text={editing ? preview ?? draft ?? text : peek.content} loadImage={loadImage} openLink={openLink} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Opaque origin (sandbox without allow-same-origin): pdf.js runs there, never as Henry. The
 *  bytes are read here, where `/raw` is same-origin, and handed over with the library. */
function PdfFrame({ path, title, zoom, onZoom }: { path: string; title: string; zoom: number; onZoom: (f: (z: number) => number) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const zoomNow = useRef(zoom);
  zoomNow.current = zoom;
  const unlisten = useRef(() => {});
  useEffect(() => () => unlisten.current(), []);
  // Runs again when the frame is moved into a popped-out window (moving an iframe reloads it),
  // and the frame's messages then go to that window, so the listener is bound per load.
  const onLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
    const frame = e.currentTarget.contentWindow;
    const host = e.currentTarget.ownerDocument.defaultView;
    unlisten.current();
    // ⌘+wheel inside the frame never reaches the host window; the frame forwards the delta.
    const onMsg = (m: MessageEvent) => {
      if (m.source !== frame || typeof m.data?.wheel !== "number") return;
      const dy = m.data.wheel as number;
      onZoom((z) => clampZoom(z * Math.exp(-dy * 0.002)));
    };
    host?.addEventListener("message", onMsg);
    unlisten.current = () => host?.removeEventListener("message", onMsg);
    Promise.all([loadPdfJs(), fetch(rawUrl(path)).then((r) => r.arrayBuffer())])
      .then(([{ lib, worker }, data]) => {
        frame?.postMessage({ lib, worker, data }, "*", [data]);
        frame?.postMessage({ zoom: zoomNow.current }, "*");
      })
      .catch((err) => console.warn("[henry] pdf peek:", err));
  };
  useEffect(() => ref.current?.contentWindow?.postMessage({ zoom }, "*"), [zoom]);
  return <iframe ref={ref} key={path} srcDoc={PDF_FRAME} sandbox="allow-scripts" title={title} onLoad={onLoad} />;
}

function clampZoom(z: number): number {
  return Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, z));
}

interface LineProps {
  no: number;
  text: string;
  html?: string;
  hit: boolean;
  add: boolean;
  dels?: string[];
  hitRef: React.RefObject<HTMLDivElement>;
  /** Find matches on this line; a line with any loses its syntax colours to show them. */
  marks?: Span[];
  /** Index into `marks` of the current match. */
  cur?: number;
  curRef: React.RefObject<HTMLDivElement>;
}

function Line({ no, text, html, hit, add, dels, hitRef, marks, cur, curRef }: LineProps) {
  let content: React.ReactNode;
  if (marks?.length) {
    const parts: React.ReactNode[] = [];
    let at = 0;
    marks.forEach(([a, b], i) => {
      parts.push(text.slice(at, a), <mark key={i} className={i === cur ? "cur" : undefined}>{text.slice(a, b)}</mark>);
      at = b;
    });
    parts.push(text.slice(at));
    content = <span>{parts}</span>;
  } else content = html !== undefined ? <span dangerouslySetInnerHTML={{ __html: html }} /> : text;
  return (
    <>
      {dels?.map((t, i) => (
        <div key={i} className="peek-line del"><span className="peek-no" />{t}</div>
      ))}
      <div className={"peek-line" + (hit ? " hit" : "") + (add ? " add" : "")} ref={cur !== undefined ? curRef : hit ? hitRef : undefined}>
        <span className="peek-no">{no}</span>
        {content}
      </div>
    </>
  );
}
