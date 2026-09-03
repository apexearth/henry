import { useEffect, useState } from "react";
import type { RepoPickerEntry } from "@henry/shared";
import { createSession, useStore } from "./ws";

export function RepoPicker({ onClose }: { onClose: () => void }) {
  const defaultRepo = useStore((s) => s.config?.defaultRepo ?? "");
  const [repos, setRepos] = useState<RepoPickerEntry[]>([]);
  const [path, setPath] = useState(defaultRepo);
  const [title, setTitle] = useState("");

  useEffect(() => {
    fetch("/api/repos")
      .then((r) => r.json())
      .then((list: RepoPickerEntry[]) => setRepos(list))
      .catch(() => setRepos([]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = () => {
    if (!path.trim()) return;
    createSession(path.trim(), title.trim() || undefined);
    onClose();
  };

  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>New session</h3>
        <div className="list">
          {repos.map((r) => (
            <div key={r.path} className={"row" + (r.path === path ? " sel" : "")} onClick={() => setPath(r.path)} onDoubleClick={create}>
              <span>{r.name}{r.isWorktree ? " (worktree)" : ""}</span>
              <span className="path">{r.path}</span>
            </div>
          ))}
          {!repos.length && <div className="row placeholder">no repos found under reposRoot</div>}
        </div>
        <div className="foot">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="cwd" spellCheck={false} />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="title (optional)" style={{ width: 140 }}
            onKeyDown={(e) => e.key === "Enter" && create()} />
          <button onClick={create}>Create</button>
        </div>
      </div>
    </div>
  );
}
