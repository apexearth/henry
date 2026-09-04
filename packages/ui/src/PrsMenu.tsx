// Topbar "PRs" chip: how many pull requests are open across the repos your sessions touch,
// visible without opening a panel. The count comes from the repo cards already in the store;
// the popover fetches the actual list from the daemon (which reads it with `gh`).
import { useEffect, useState } from "react";
import type { RepoPrs, RepoState } from "@henry/shared";
import { relTime } from "./GitTree";
import { hueText, nameHue } from "./theme";
import { useStore } from "./ws";

/** A pull-request mark (two branches meeting), sized to sit inline with text. */
export function PrIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="4" cy="3.5" r="2" />
      <circle cx="4" cy="12.5" r="2" />
      <circle cx="12" cy="12.5" r="2" />
      <path d="M4 5.5v5M12 10.5V6a2 2 0 0 0-2-2H7.5M9.5 2 7 4.5 9.5 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Open PRs across a set of repo cards. Worktrees of one repo report the same PRs, so repos
 * are folded by remote before adding up; a repo whose count is unknown contributes nothing.
 */
export function openPrTotal(repos: RepoState[]): { total: number; known: number } {
  const byRemote = new Map<string, number>();
  for (const r of repos) {
    if (r.openPrs === undefined) continue;
    byRemote.set(r.remoteUrl ?? r.path, r.openPrs);
  }
  let total = 0;
  for (const n of byRemote.values()) total += n;
  return { total, known: byRemote.size };
}

export function PrsMenu() {
  const [open, setOpen] = useState(false);
  const repos = useStore((s) => s.repos);
  const { total, known } = openPrTotal(Object.values(repos).flat());
  // Nothing to say until at least one repo has answered (no gh, or no GitHub remote).
  if (!known) return null;
  return (
    <>
      <button className={"topbar-btn prs-btn" + (total ? " some" : "")} onClick={() => setOpen((o) => !o)} title={`${total} open pull request${total === 1 ? "" : "s"} across ${known} repo${known === 1 ? "" : "s"}`}>
        <PrIcon />
        <span className="n">{total}</span>
        <span className="lbl">open PR{total === 1 ? "" : "s"}</span>
      </button>
      {open && (
        <>
          <div className="pop-bg" onClick={() => setOpen(false)} />
          <div className="pop prs-pop">
            <PrList />
          </div>
        </>
      )}
    </>
  );
}

function PrList() {
  const [rows, setRows] = useState<RepoPrs[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/prs");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { repos: RepoPrs[] };
        if (live) setRows(body.repos);
      } catch (e) {
        if (live) setErr((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (err) return <div className="err">could not read PRs: {err}</div>;
  if (!rows) return <div className="dim">loading…</div>;
  if (!rows.length) return <div className="dim">No GitHub repo in play yet.</div>;
  return (
    <>
      {rows.map((r) => (
        <div key={r.repo} className="prs-repo">
          <div className="prs-repo-h">
            <span className="name" style={{ color: hueText(nameHue(r.name)) }}>{r.name}</span>
            <span className="dim">{r.slug}</span>
            <span className="grow" />
            <a className="dim" href={`https://github.com/${r.slug}/pulls`} target="_blank" rel="noopener noreferrer">
              {r.prs.length} open
            </a>
          </div>
          {r.prs.map((p) => (
            <a key={p.number} className="prs-row" href={p.url} target="_blank" rel="noopener noreferrer" title={p.title}>
              <span className="num">#{p.number}</span>
              <span className="grow">{p.title}</span>
              {p.draft && <span className="draft">draft</span>}
              <span className="dim">{p.author}</span>
              <span className="dim">{relTime(p.updatedAt)}</span>
            </a>
          ))}
          {(!r.prs.length || r.note) && <div className="dim empty">{r.note ?? "no open PRs"}</div>}
        </div>
      ))}
    </>
  );
}
