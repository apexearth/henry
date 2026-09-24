// A file peek: read-only view of one file, shown over the session in the stage group.
// Opened by ⌘-clicking a path (terminal output, diff headers); Esc or × closes it. ⌘F over
// the peek in view opens a find bar (App.tsx routes it here as a `henry:find` event).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileDiff, FilePeek } from "@henry/shared";
import { parseDiff } from "./DiffView";
import { closePeek, filePanelId, peekFile } from "./dock";
import { noteRecent } from "./files";
import { highlightLines, languageFor } from "./highlight";
import { Markdown } from "./Markdown";
import { baseName } from "./platform";
import { getState } from "./ws";

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

/** Resolve `raw` (maybe relative to `cwd`) and open it; a path that isn't a file opens nothing. */
export async function openPeek(raw: string, cwd?: string, line?: number): Promise<boolean> {
  const peek = await fetchPeek(raw, cwd);
  if (!peek) {
    console.info(`[henry] no file at ${raw}${cwd ? ` (cwd ${cwd})` : ""}`);
    return false;
  }
  primed.set(peek.path, peek);
  noteRecent(peek.path);
  peekFile(peek.path, line);
  return true;
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
}

export function FileView({ path, line, active, local = false }: Props) {
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

  // Dockview hides inactive panels, which drops their scroll position: re-centre on return.
  // The explorer's preview is never active but still follows the line of the hit it shows.
  useEffect(() => {
    if (active) body.current?.focus();
    if ((active || local) && peek && line) hit.current?.scrollIntoView({ block: "center" });
  }, [active, local, peek, line]);

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
  const text = !!peek && !peek.binary && !peek.image;
  const isMd = text && languageFor(path) === "markdown";
  const isHtml = text && /\.html?$/i.test(path) && rawServed(local);
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
  const showPage = (isMd || isHtml) && (mdView === "split" || (mdView === "page" && !find));
  const showSource = !showPage || mdView === "split";
  // Images and links in the page resolve against the file's folder, on the machine it was read from.
  const loadImage = useCallback(
    (src: string) => fetchPeek(src, dir, local).then((p) => (p?.image && p.content ? `data:${p.image};base64,${p.content}` : null)),
    [dir, local],
  );
  const openLink = useCallback((href: string) => void openPeek(href.replace(/[#?].*$/, ""), dir), [dir]);

  return (
    <div className="peek">
      <div className="peek-head">
        {!local && <button className="peek-back" onClick={() => closePeek(filePanelId(path))} title="back to the session (Esc)">←</button>}
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
            : peek ? `${lines.length} lines · ${fmtSize(peek.size)}${peek.truncated ? " · truncated" : ""}` : peek === null ? "not found" : "loading…"}
        </span>
        {imgSrc && dims && (
          <button className="peek-back" onClick={() => setFit((f) => !f)} title={fit ? "show at actual size" : "fit to the pane"}>{fit ? "1:1" : "fit"}</button>
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
        {!local && <button className="peek-close" onClick={() => closePeek(filePanelId(path))} title="close (Esc)">×</button>}
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
        {peek?.binary && !peek.image && <div className="peek-note">Binary file, nothing to show.</div>}
        {peek && !peek.binary && !peek.image && showSource && (
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
            <Markdown text={peek.content} loadImage={loadImage} openLink={openLink} />
          </div>
        )}
      </div>
    </div>
  );
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
