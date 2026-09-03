// A file peek: read-only view of one file, shown over the session in the stage group.
// Opened by ⌘-clicking a path (terminal output, diff headers); Esc or × closes it.
import { useEffect, useRef, useState } from "react";
import type { FilePeek } from "@henry/shared";
import { closePeek, filePanelId, peekFile } from "./dock";

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
  peekFile(peek.path, line);
  return true;
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
              <div key={i} className={"peek-line" + (i + 1 === line ? " hit" : "")} ref={i + 1 === line ? hit : undefined}>
                <span className="peek-no">{i + 1}</span>{t}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
