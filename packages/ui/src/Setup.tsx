// Where the repos live. First run: before the picker, git watcher or cross-repo rules mean
// anything, Henry needs the one folder that holds every repo, so this shows until
// ~/.henry/config.json has a reposRoot and cannot be dismissed (App swallows Esc for any
// .modal-bg). Later, the topbar reopens it with `onClose`, which adds Cancel/Esc/backdrop.
import { useEffect, useState } from "react";
import type { RepoPickerEntry } from "@henry/shared";
import { useStore } from "./ws";

export function Setup({ onClose }: { onClose?: () => void }) {
  const current = useStore((s) => s.config?.reposRoot ?? "~/code");
  const [path, setPath] = useState(current);
  const [preview, setPreview] = useState<RepoPickerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const changing = !!onClose;

  // Live count of what Henry would find there, so a typo shows as "nothing here" before Enter.
  useEffect(() => {
    const p = path.trim();
    if (!p) return setPreview(null);
    const t = setTimeout(() => {
      fetch(`/api/repos?root=${encodeURIComponent(p)}`)
        .then((r) => r.json())
        .then((list: RepoPickerEntry[]) => setPreview(list))
        .catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(t);
  }, [path]);

  const submit = async () => {
    if (busy || !path.trim()) return;
    if (changing && path.trim() === current) return onClose?.();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reposRoot: path }) });
      const body = (await r.json()) as { error?: string };
      if (!r.ok) setError(body.error ?? "could not save");
      // First run: the daemon broadcasts a state with firstRun=false and this modal unmounts.
      else onClose?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const repos = preview?.filter((r) => !r.folder) ?? [];
  const names = repos.slice(0, 6).map((r) => r.name).join(", ") + (repos.length > 6 ? ", …" : "");
  const found = preview === null ? "" : repos.length ? `${repos.length} repo${repos.length === 1 ? "" : "s"} found: ${names}` : "no repos found in that folder yet";

  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal" style={{ width: 560 }} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{changing ? "Change where your repos live" : "Where do your repos live?"}</h3>
        <div style={{ padding: "10px 12px", lineHeight: 1.5 }}>
          <p style={{ margin: "0 0 8px" }}>
            Henry expects one folder that holds all of your repositories, each as a subfolder. Worktrees and plain
            scratch folders inside it are fine too.
          </p>
          <p style={{ margin: "0 0 8px", color: "var(--fg-dim)" }}>
            That folder feeds the new-session picker, is watched for git changes, and is the boundary Henry uses to
            flag a session writing somewhere it should not.{" "}
            {changing
              ? "Changing it moves that boundary for every session, running ones included: writes in the old folder start to show as outside-root flags."
              : <>You can change it later from the topbar, or as <code>reposRoot</code> in <code>~/.henry/config.json</code>.</>}
          </p>
          <input className="picker-input" autoFocus value={path} spellCheck={false} style={{ margin: "6px 0", width: "100%", boxSizing: "border-box" }}
            placeholder="~/code" onChange={(e) => { setPath(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void submit(); }
              else if (e.key === "Escape" && changing) { e.preventDefault(); onClose?.(); }
            }} />
          <div style={{ fontSize: 11, minHeight: 16, color: error ? "var(--red, #e5484d)" : "var(--fg-dim)" }}>{error ?? found}</div>
        </div>
        <div className="foot">
          <span className="hint" style={{ flex: 1, color: "var(--fg-dim)", fontSize: 11 }}>{changing ? "Enter to confirm · Esc to cancel" : "Enter to confirm"}</span>
          {changing && <button onClick={onClose}>Cancel</button>}
          <button onClick={() => void submit()} disabled={busy || !path.trim()}>{changing ? "Change folder" : "Use this folder"}</button>
        </div>
      </div>
    </div>
  );
}
