// Milestone 3: unified/split diff of a repo vs the session baseline.
// Hand-rolled unified-diff parser + renderer. Files past the first 20 (and very large
// files) start collapsed so a big diff does not freeze the panel.
import { useMemo, useState } from "react";
import { openPeek } from "./FileView";
import { isMac, joinPath } from "./platform";

export interface DiffViewProps {
  repoPath: string;
  baseline: string;
  diff: string;
}

// ---- parser ----

export type LineKind = "ctx" | "add" | "del" | "meta";

export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "binary";

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  hunks: Hunk[];
  adds: number;
  dels: number;
  lineCount: number;
}

export interface ParsedDiff {
  files: DiffFile[];
  /** Lines outside any file block (e.g. the daemon's truncation note). */
  notes: string[];
}

const stripPrefix = (p: string) => (p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p);

export function parseDiff(text: string): ParsedDiff {
  const files: DiffFile[] = [];
  const notes: string[] = [];
  let file: DiffFile | undefined;
  let hunk: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = { oldPath: m ? m[1] : "", newPath: m ? m[2] : "", status: "modified", hunks: [], adds: 0, dels: 0, lineCount: 0 };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) {
      if (line.trim()) notes.push(line);
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      // File header block.
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) { file.status = "renamed"; file.oldPath = line.slice(12); }
      else if (line.startsWith("rename to ")) file.newPath = line.slice(10);
      else if (line.startsWith("Binary files")) file.status = "binary";
      else if (line.startsWith("--- ") && line.slice(4) !== "/dev/null") file.oldPath = stripPrefix(line.slice(4));
      else if (line.startsWith("+++ ") && line.slice(4) !== "/dev/null") file.newPath = stripPrefix(line.slice(4));
      continue;
    }
    const c = line[0];
    if (c === "+") {
      hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
      file.adds++;
    } else if (c === "-") {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
      file.dels++;
    } else if (c === " ") {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (c === "\\") {
      hunk.lines.push({ kind: "meta", text: line });
    } else if (line === "") {
      // Some tools emit a bare empty line for an empty context line.
      hunk.lines.push({ kind: "ctx", text: "", oldNo: oldNo++, newNo: newNo++ });
    } else {
      hunk.lines.push({ kind: "meta", text: line });
    }
    file.lineCount++;
  }
  return { files, notes };
}

// ---- split pairing ----

interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === "del") {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
      while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) rows.push({ left: dels[k], right: adds[k] });
    } else if (l.kind === "add") {
      rows.push({ right: l });
      i++;
    } else {
      rows.push({ left: l, right: l });
      i++;
    }
  }
  return rows;
}

// ---- rendering ----

const AUTO_EXPAND_FILES = 20;
const LARGE_FILE_LINES = 1500;

const kindClass: Record<LineKind, string> = { ctx: "dl-ctx", add: "dl-add", del: "dl-del", meta: "dl-meta" };
const marker: Record<LineKind, string> = { ctx: " ", add: "+", del: "-", meta: " " };

function statusLabel(f: DiffFile): string {
  switch (f.status) {
    case "added": return "new";
    case "deleted": return "deleted";
    case "renamed": return "renamed";
    case "binary": return "binary";
    default: return "";
  }
}

function fileTitle(f: DiffFile): string {
  if (f.status === "renamed" && f.oldPath !== f.newPath) return `${f.oldPath} → ${f.newPath}`;
  return f.newPath || f.oldPath;
}

function UnifiedHunk({ hunk }: { hunk: Hunk }) {
  return (
    <>
      <tr className="dl-hunk"><td colSpan={3}>{hunk.header}</td></tr>
      {hunk.lines.map((l, i) => (
        <tr key={i} className={kindClass[l.kind]}>
          <td className="dl-no">{l.oldNo ?? ""}</td>
          <td className="dl-no">{l.newNo ?? ""}</td>
          <td className="dl-text"><span className="dl-mark">{marker[l.kind]}</span>{l.text}</td>
        </tr>
      ))}
    </>
  );
}

function SplitHunk({ hunk }: { hunk: Hunk }) {
  const rows = useMemo(() => toSplitRows(hunk.lines), [hunk]);
  const cell = (l: DiffLine | undefined, side: "old" | "new") => {
    if (!l) return <><td className="dl-no" /><td className="dl-text dl-empty" /></>;
    const cls = l.kind === "ctx" || l.kind === "meta" ? kindClass[l.kind] : side === "old" ? "dl-del" : "dl-add";
    return (
      <>
        <td className={`dl-no ${cls}`}>{side === "old" ? l.oldNo ?? "" : l.newNo ?? ""}</td>
        <td className={`dl-text ${cls}`}><span className="dl-mark">{marker[l.kind]}</span>{l.text}</td>
      </>
    );
  };
  return (
    <>
      <tr className="dl-hunk"><td colSpan={4}>{hunk.header}</td></tr>
      {rows.map((r, i) => (
        <tr key={i}>
          {cell(r.left, "old")}
          {cell(r.right, "new")}
        </tr>
      ))}
    </>
  );
}

function FileBlock({ file, open, onToggle, split, repoPath }: { file: DiffFile; open: boolean; onToggle: () => void; split: boolean; repoPath: string }) {
  const label = statusLabel(file);
  return (
    <div className={`df ${open ? "open" : ""}`}>
      <div className="df-head" onClick={onToggle} title={open ? "collapse" : "expand"}>
        <span className="df-caret">{open ? "▾" : "▸"}</span>
        <span className="df-path" title={`${isMac ? "⌘" : "Ctrl"}-click to peek at the file`}
          onClick={(e) => { if (!e.metaKey && !e.ctrlKey) return; e.stopPropagation(); openPeek(joinPath(repoPath, file.newPath || file.oldPath)); }}>{fileTitle(file)}</span>
        {label && <span className={`df-status df-${file.status}`}>{label}</span>}
        <span className="df-counts">
          {file.adds > 0 && <span className="df-adds">+{file.adds}</span>}
          {file.dels > 0 && <span className="df-dels">−{file.dels}</span>}
        </span>
      </div>
      {open && (
        file.status === "binary" || file.hunks.length === 0 ? (
          <div className="df-note">{file.status === "binary" ? "binary file, no text diff" : "no hunks"}</div>
        ) : (
          <div className="df-scroll">
            <table className={`dt ${split ? "dt-split" : "dt-unified"}`}>
              <tbody>
                {file.hunks.map((h, i) => (split ? <SplitHunk key={i} hunk={h} /> : <UnifiedHunk key={i} hunk={h} />))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

export function DiffView({ repoPath, baseline, diff }: DiffViewProps) {
  const parsed = useMemo(() => parseDiff(diff), [diff]);
  const [split, setSplit] = useState(false);
  // Explicit user overrides; everything else follows the default (first 20 files, not huge).
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [allOpen, setAllOpen] = useState<boolean | null>(null);
  const keyOf = (f: DiffFile, i: number) => `${i}:${f.newPath || f.oldPath}`;
  const isOpen = (f: DiffFile, i: number) => {
    const k = keyOf(f, i);
    if (k in overrides) return overrides[k];
    if (allOpen !== null) return allOpen;
    return i < AUTO_EXPAND_FILES && f.lineCount <= LARGE_FILE_LINES;
  };
  const toggle = (f: DiffFile, i: number) => setOverrides((o) => ({ ...o, [keyOf(f, i)]: !isOpen(f, i) }));
  const setAll = (v: boolean) => {
    setAllOpen(v);
    setOverrides({});
  };
  const adds = parsed.files.reduce((n, f) => n + f.adds, 0);
  const dels = parsed.files.reduce((n, f) => n + f.dels, 0);

  return (
    <div className="diffview">
      <style>{DIFF_CSS}</style>
      <div className="dv-bar">
        <span className="dv-summary" title={repoPath}>
          {parsed.files.length} file{parsed.files.length === 1 ? "" : "s"}
          {adds > 0 && <span className="df-adds"> +{adds}</span>}
          {dels > 0 && <span className="df-dels"> −{dels}</span>}
          <span className="dv-base"> vs {baseline ? baseline.slice(0, 7) : "(no baseline)"}</span>
        </span>
        <span className="dv-actions">
          <button className={!split ? "on" : ""} onClick={() => setSplit(false)}>unified</button>
          <button className={split ? "on" : ""} onClick={() => setSplit(true)}>split</button>
          <button onClick={() => setAll(true)} title="expand all files">⊞</button>
          <button onClick={() => setAll(false)} title="collapse all files">⊟</button>
        </span>
      </div>
      {parsed.files.length === 0 && <div className="df-note">{diff.trim() ? "nothing parseable in this diff" : "no changes since baseline"}</div>}
      {parsed.files.map((f, i) => (
        <FileBlock key={keyOf(f, i)} file={f} open={isOpen(f, i)} onToggle={() => toggle(f, i)} split={split} repoPath={repoPath} />
      ))}
      {parsed.notes.length > 0 && <div className="df-note">{parsed.notes.join(" ")}</div>}
    </div>
  );
}

export const DIFF_CSS = `
.diffview { font-size: 11px; margin-top: 6px; }
.dv-bar { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 0; color: var(--fg-dim); position: sticky; top: 0; background: var(--bg-2); z-index: 1; }
.dv-actions { display: flex; gap: 3px; }
.dv-actions button { padding: 1px 6px; font-size: 11px; }
.dv-actions button.on { border-color: var(--accent); color: var(--accent); }
.dv-base { color: var(--fg-dim); }
.df { border: 1px solid var(--border); border-radius: 4px; margin-bottom: 4px; background: var(--bg); overflow: hidden; }
.df-head { display: flex; align-items: center; gap: 6px; padding: 3px 6px; cursor: pointer; background: var(--bg-3); user-select: none; }
.df-head:hover { color: var(--accent); }
.df-caret { width: 10px; color: var(--fg-dim); }
.df-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.df-status { font-size: 10px; padding: 0 4px; border-radius: 3px; border: 1px solid var(--border); color: var(--fg-dim); }
.df-added { color: var(--ok); border-color: var(--ok); }
.df-deleted { color: var(--alarm); border-color: var(--alarm); }
.df-renamed { color: var(--warn); border-color: var(--warn); }
.df-counts { display: flex; gap: 6px; white-space: nowrap; }
.df-adds { color: var(--ok); }
.df-dels { color: var(--alarm); }
.df-note { padding: 4px 8px; color: var(--fg-dim); font-style: italic; }
.df-scroll { overflow-x: auto; }
.dt { border-collapse: collapse; width: 100%; font-family: var(--mono); table-layout: auto; }
.dt td { padding: 0 4px; white-space: pre; vertical-align: top; line-height: 1.5; }
.dt .dl-no { color: var(--fg-dim); text-align: right; min-width: 2.5em; user-select: none; border-right: 1px solid var(--border); opacity: .7; }
.dt .dl-text { width: 100%; }
.dt-split .dl-text { width: 50%; }
.dt .dl-mark { display: inline-block; width: 1em; color: var(--fg-dim); user-select: none; }
.dt .dl-add { background: rgba(63,185,80,.14); }
.dt .dl-add .dl-mark { color: var(--ok); }
.dt .dl-del { background: rgba(248,81,73,.14); }
.dt .dl-del .dl-mark { color: var(--alarm); }
.dt .dl-meta { color: var(--fg-dim); font-style: italic; }
.dt .dl-empty { background: repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(255,255,255,.03) 4px, rgba(255,255,255,.03) 8px); }
.dt .dl-hunk td { background: rgba(110,168,254,.10); color: var(--accent); padding: 1px 6px; white-space: pre; }
`;
