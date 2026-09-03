// A file peek: read-only view of one file, shown over the session in the stage group.
// Opened by ⌘-clicking a path (terminal output, diff headers); Esc or × closes it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { FileDiff, FilePeek } from "@henry/shared";
import { parseDiff } from "./DiffView";
import { closePeek, filePanelId, peekFile } from "./dock";
import { noteRecent } from "./files";
import { highlightLines } from "./highlight";
import { getState } from "./ws";

/** `path:line[:col]` → parts. Windows-style drive letters aren't a concern here. */
export function splitLineRef(ref: string): { path: string; line?: number } {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(ref);
  return m ? { path: m[1], line: Number(m[2]) } : { path: ref };
}

export async function fetchPeek(path: string, cwd?: string): Promise<FilePeek | null> {
  const q = new URLSearchParams({ path });
  if (cwd) q.set("cwd", cwd);
  const r = await fetch(`/api/file?${q}`);
  return r.ok ? ((await r.json()) as FilePeek) : null;
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

interface Props {
  path: string;
  line?: number;
  /** In view and in the active group: takes focus so Esc and scrolling keys work. */
  active: boolean;
}

export function FileView({ path, line, active }: Props) {
  const [peek, setPeek] = useState<FilePeek | null | undefined>(() => primed.get(path));
  // Highlighted HTML per line; null until ready or when the file is plain text. Painted after
  // the text so a big file shows up immediately and colours in a beat later.
  const [html, setHtml] = useState<string[] | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const hit = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let on = true;
    const cached = primed.get(path);
    primed.delete(path);
    if (cached) setPeek(cached);
    else fetchPeek(path).then((p) => on && setPeek(p));
    return () => {
      on = false;
    };
  }, [path]);

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
    if (!peek?.repoPath) return;
    let on = true;
    const q = new URLSearchParams({ path: peek.path });
    const sid = getState().activeSessionId;
    if (sid) q.set("sessionId", sid);
    fetch(`/api/file/diff?${q}`)
      .then((r) => (r.ok ? (r.json() as Promise<FileDiff>) : null))
      .then((d) => on && setFd(d))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [peek]);
  const tint = useMemo(() => (fd?.diff ? tintsOf(fd.diff) : null), [fd]);

  // Dockview hides inactive panels, which drops their scroll position: re-centre on return.
  useEffect(() => {
    if (!active) return;
    body.current?.focus();
    if (peek && line) hit.current?.scrollIntoView({ block: "center" });
  }, [active, peek, line]);

  const lines = peek?.content ? peek.content.split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  const name = path.slice(dir.length);
  const shown = peek?.rel ? { dir: peek.rel.slice(0, peek.rel.lastIndexOf("/") + 1), name } : { dir, name };

  return (
    <div className="peek">
      <div className="peek-head">
        <button className="peek-back" onClick={() => closePeek(filePanelId(path))} title="back to the session (Esc)">←</button>
        <span className="peek-path" title={path}>
          {shown.dir}<b>{shown.name}</b>
        </span>
        {peek?.repoPath && <span className="peek-meta" style={{ marginLeft: 0 }}>{peek.repoPath.split("/").pop()}</span>}
        {tint && (
          <span className="peek-meta peek-diffstat" style={{ marginLeft: 0 }} title={`vs baseline ${fd?.baseline.slice(0, 7)}`}>
            {tint.adds.size > 0 && <span className="a">+{tint.adds.size}</span>}
            {tint.nDel > 0 && <span className="d">−{tint.nDel}</span>}
          </span>
        )}
        <span className="peek-meta">
          {peek ? `${lines.length} lines · ${fmtSize(peek.size)}${peek.truncated ? " · truncated" : ""}` : peek === null ? "not found" : "loading…"}
        </span>
        <button className="peek-close" onClick={() => closePeek(filePanelId(path))} title="close (Esc)">×</button>
      </div>
      <div className="peek-body" ref={body} tabIndex={0}>
        {peek === null && <div className="peek-note">This file no longer exists.</div>}
        {peek?.binary && <div className="peek-note">Binary file, nothing to show.</div>}
        {peek && !peek.binary && (
          <pre>
            {lines.map((t, i) => (
              <Line key={i} no={i + 1} text={t} html={html && i < html.length ? html[i] : undefined} hit={i + 1 === line}
                add={tint?.adds.has(i + 1) ?? false} dels={tint?.dels.get(i + 1)} hitRef={hit} />
            ))}
            {tint?.dels.get(lines.length + 1)?.map((t, i) => (
              <div key={"tail" + i} className="peek-line del"><span className="peek-no" />{t}</div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}

function Line({ no, text, html, hit, add, dels, hitRef }: { no: number; text: string; html?: string; hit: boolean; add: boolean; dels?: string[]; hitRef: React.RefObject<HTMLDivElement> }) {
  return (
    <>
      {dels?.map((t, i) => (
        <div key={i} className="peek-line del"><span className="peek-no" />{t}</div>
      ))}
      <div className={"peek-line" + (hit ? " hit" : "") + (add ? " add" : "")} ref={hit ? hitRef : undefined}>
        <span className="peek-no">{no}</span>
        {html !== undefined ? <span dangerouslySetInnerHTML={{ __html: html }} /> : text}
      </div>
    </>
  );
}
