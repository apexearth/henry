// Rail section under the sessions: the active session's changed files, newest first.
// Click to peek. Files are things you glance at, so there is nothing to open or close here.
import { useState } from "react";
import type { ChangedFile } from "@henry/shared";
import { openPeek } from "./FileView";
import { splitPath, useSessionFiles } from "./files";
import { useStore } from "./ws";

const STATUS_TEXT: Record<ChangedFile["status"], string> = { M: "modified", A: "added", D: "deleted", R: "renamed", "?": "untracked" };

export function FilesSection() {
  const active = useStore((s) => s.activeSessionId);
  const sf = useSessionFiles(active);
  const [open, setOpen] = useState(true);
  if (!active) return null;
  const repos = (sf?.repos ?? []).filter((r) => r.files.length);
  const total = repos.reduce((n, r) => n + r.files.length, 0);
  return (
    <div className="rail-files">
      <div className="rail-group-h files-h" onClick={() => setOpen(!open)} title={open ? "collapse" : "expand"}>
        <span className="name">Files</span>
        <span className="n">{sf ? total : "…"}</span>
      </div>
      {open && (total ? (
        repos.map((r) => (
          <div key={r.path}>
            {repos.length > 1 && <div className="files-repo" title={r.path}>{r.name}</div>}
            {[...r.files].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)).map((f) => {
              const { dir, name } = splitPath(f.path);
              const gone = f.status === "D";
              return (
                <div key={f.path} className={"rail-item file" + (gone ? " off" : "")}
                  title={`${STATUS_TEXT[f.status]}${f.from ? ` from ${f.from}` : ""}\n${r.path}/${f.path}`}
                  onClick={() => !gone && openPeek(`${r.path}/${f.path}`)}>
                  <span className={"fstat s-" + f.status}>{f.status}</span>
                  <span className="title">{name}</span>
                  {dir && <span className="sub">{dir}</span>}
                </div>
              );
            })}
          </div>
        ))
      ) : (
        <div className="files-empty">{sf ? "no changes since baseline" : "loading…"}</div>
      ))}
    </div>
  );
}
