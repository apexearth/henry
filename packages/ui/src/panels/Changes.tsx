// What the session in view wrote, newest first: the files your last prompt changed at full
// strength on top, the ones it wrote before that dimmed beneath. Off the session's Write/Edit
// hooks (daemon/written.ts), so a file changed only through Bash is not listed.
import { useEffect, useState } from "react";
import type { SessionWrites } from "@henry/shared";
import { peekFile } from "../dock";
import { relTime } from "../GitTree";
import { baseName } from "../platform";
import { useStore } from "../ws";

/** Hooks that can move the answer: a new prompt, or a write landing. */
const MOVES = new Set(["UserPromptSubmit", "PostToolUse"]);

function useSessionWrites(sessionId: string | null): SessionWrites | undefined {
  const [writes, setWrites] = useState<SessionWrites>();
  // The newest event for this session that could change the list; a new one refetches.
  const mark = useStore((s) => s.events.find((e) => e.sessionId === sessionId && e.hookEvent && MOVES.has(e.hookEvent))?.id);
  const activity = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.activitySince);
  useEffect(() => {
    if (!sessionId) return;
    let on = true;
    // A burst of edits is one refetch, not one per hook.
    const t = setTimeout(() => {
      fetch(`/api/session/writes?sessionId=${encodeURIComponent(sessionId)}`)
        .then((r) => (r.ok ? (r.json() as Promise<SessionWrites>) : undefined))
        .then((w) => on && w && setWrites(w))
        .catch(() => {});
    }, 250);
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [sessionId, mark, activity]);
  return writes?.sessionId === sessionId ? writes : undefined;
}

export function ChangesPanel() {
  const sessionId = useStore((s) => s.activeSessionId);
  const writes = useSessionWrites(sessionId);
  // Relative times go stale; a minute is their resolution.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  if (!sessionId) return <div className="dock-body empty">no session</div>;
  if (!writes) return <div className="dock-body" />;
  const promptAt = writes.promptAt ?? 0;
  const recent = writes.files.filter((f) => f.at >= promptAt);
  const earlier = writes.files.filter((f) => f.at < promptAt);

  return (
    <div className="dock-body" style={{ padding: "4px 0", fontSize: 12 }}>
      <div style={{ padding: "2px 10px 4px", color: "var(--fg-dim)", fontSize: 11 }}>
        {writes.promptAt ? `last prompt ${relTime(writes.promptAt)} · ${recent.length ? `${recent.length} file${recent.length === 1 ? "" : "s"}` : "nothing written yet"}` : "no prompt yet"}
      </div>
      {recent.map((f) => <Row key={f.path} file={f} dim={false} />)}
      {earlier.length > 0 && <div style={{ borderTop: "1px solid var(--border)", margin: "4px 10px" }} />}
      {earlier.map((f) => <Row key={f.path} file={f} dim />)}
    </div>
  );
}

function Row({ file, dim }: { file: SessionWrites["files"][number]; dim: boolean }) {
  const shown = file.rel ?? file.path;
  const name = baseName(shown);
  const dir = shown.slice(0, shown.length - name.length).replace(/[\\/]$/, "");
  return (
    <div
      onClick={() => peekFile(file.path)}
      title={file.path}
      style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "2px 10px", cursor: "pointer", opacity: dim ? 0.45 : 1, minWidth: 0 }}
    >
      <span style={{ color: "var(--fg)", whiteSpace: "nowrap" }}>{name}</span>
      <span style={{ color: "var(--fg-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
        {dir}
      </span>
      <span style={{ color: "var(--fg-dim)", fontSize: 11, whiteSpace: "nowrap" }}>{relTime(file.at)}</span>
    </div>
  );
}
