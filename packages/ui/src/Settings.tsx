// Everything in ~/.henry/config.json that is worth a control, on ⌘, (or the topbar). The
// daemon owns validation (only it can stat a folder) and hot-reloads config.json, so saving
// is one POST and the new state arrives over the WS like any other change.
//
// Only edited fields are sent: two windows with the modal open do not clobber each other's
// sections. Long lists (rules.alarm / rules.notable) stay in the JSON file — see the footnote.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { HenryConfig, RepoPickerEntry } from "@henry/shared";
import { useStore } from "./ws";

const st = {
  body: { flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 0 8px" } as CSSProperties,
  section: { padding: "10px 12px 4px" } as CSSProperties,
  h: { color: "var(--fg-dim)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", paddingBottom: 6 } as CSSProperties,
  row: { display: "flex", alignItems: "baseline", gap: 10, padding: "4px 0" } as CSSProperties,
  label: { flex: "0 0 150px", color: "var(--fg)" } as CSSProperties,
  field: { flex: 1, minWidth: 0 } as CSSProperties,
  note: { color: "var(--fg-dim)", fontSize: 11, lineHeight: 1.45, margin: "2px 0 0 160px" } as CSSProperties,
  check: { display: "flex", alignItems: "center", gap: 8, padding: "3px 0" } as CSSProperties,
  err: { color: "var(--alarm, #e5484d)", fontSize: 11, padding: "0 12px" } as CSSProperties,
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={st.section}>
      <div style={st.h}>{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <>
      <div style={st.row}>
        <label style={st.label}>{label}</label>
        <div style={st.field}>{children}</div>
      </div>
      {note && <div style={st.note}>{note}</div>}
    </>
  );
}

/** How many repos live under a folder, so a typo reads as "nothing here" before saving. */
function useRepoCount(path: string): string {
  const [found, setFound] = useState("");
  useEffect(() => {
    const p = path.trim();
    if (!p) return setFound("");
    const t = setTimeout(() => {
      fetch(`/api/repos?root=${encodeURIComponent(p)}`)
        .then((r) => r.json())
        .then((list: RepoPickerEntry[]) => {
          const n = list.filter((r) => !r.folder).length;
          setFound(n ? `${n} repo${n === 1 ? "" : "s"} there` : "no repos found there");
        })
        .catch(() => setFound(""));
    }, 250);
    return () => clearTimeout(t);
  }, [path]);
  return found;
}

export function Settings({ onClose }: { onClose: () => void }) {
  const config = useStore((s) => s.config);
  const [draft, setDraft] = useState<HenryConfig | null>(config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = draft ?? config;
  const rootCount = useRepoCount(c?.reposRoot ?? "");

  if (!c) return null;

  const set = (patch: Partial<HenryConfig>) => {
    setError(null);
    setDraft({ ...c, ...patch });
  };
  const setOverseer = (patch: Partial<HenryConfig["overseer"]>) => set({ overseer: { ...c.overseer, ...patch } });
  const setRules = (patch: Partial<HenryConfig["rules"]>) => set({ rules: { ...c.rules, ...patch } });

  /** Only what differs from the config the daemon last sent, so untouched sections are left alone. */
  const changes = (): Partial<HenryConfig> => {
    if (!config) return {};
    const out: Partial<HenryConfig> = {};
    if (c.reposRoot !== config.reposRoot) out.reposRoot = c.reposRoot;
    if (c.defaultRepo !== config.defaultRepo) out.defaultRepo = c.defaultRepo;
    if (c.retentionDays !== config.retentionDays) out.retentionDays = c.retentionDays;
    if (JSON.stringify(c.overseer) !== JSON.stringify(config.overseer)) out.overseer = c.overseer;
    if (JSON.stringify(c.rules) !== JSON.stringify(config.rules)) out.rules = c.rules;
    return out;
  };
  const dirty = Object.keys(changes()).length > 0;

  const save = async () => {
    const patch = changes();
    if (busy) return;
    if (!Object.keys(patch).length) return onClose();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      const body = (await r.json()) as { error?: string };
      if (!r.ok) setError(body.error ?? "could not save");
      else onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
        }}>
        <h3>Settings</h3>
        <div style={st.body}>
          <Section title="repos">
            <Row label="repos root"
              note={<>The one folder holding every repo. It feeds the session picker, is watched for git changes, and is the boundary for outside-root flags — changing it moves that boundary for running sessions too. {rootCount}</>}>
              <input className="picker-input" style={{ width: "100%", boxSizing: "border-box", margin: 0 }} spellCheck={false}
                value={c.reposRoot} placeholder="~/code" onChange={(e) => set({ reposRoot: e.target.value })} />
            </Row>
            <Row label="new sessions start in">
              <input className="picker-input" style={{ width: "100%", boxSizing: "border-box", margin: 0 }} spellCheck={false}
                value={c.defaultRepo} placeholder="~/code" onChange={(e) => set({ defaultRepo: e.target.value })} />
            </Row>
          </Section>

          <Section title="history">
            <Row label="keep for (days)"
              note="Events, flags, playbook entries and usage snapshots older than this are swept at startup and every 6 hours. Sessions themselves are never swept. 0 keeps everything.">
              <input type="number" min={0} step={1} style={{ width: 90 }} value={c.retentionDays}
                onChange={(e) => set({ retentionDays: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
            </Row>
          </Section>

          <Section title="playbook (overseer)">
            <div style={st.check}>
              <input id="ov-stop" type="checkbox" checked={c.overseer.onStop} onChange={(e) => setOverseer({ onStop: e.target.checked })} />
              <label htmlFor="ov-stop">write an entry after each turn</label>
            </div>
            <div style={st.check}>
              <input id="ov-flag" type="checkbox" checked={c.overseer.onFlag} onChange={(e) => setOverseer({ onFlag: e.target.checked })} />
              <label htmlFor="ov-flag">write an entry when a flag fires</label>
            </div>
            <div style={{ ...st.note, marginLeft: 0, paddingTop: 4 }}>
              Off by default: each entry is an LLM call. Asking the overseer a question from the Playbook panel works either way.
            </div>
            <Row label="backend">
              <select value={c.overseer.backend} onChange={(e) => setOverseer({ backend: e.target.value as HenryConfig["overseer"]["backend"] })}>
                {["auto", "api", "claude-cli", "none"].map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </Row>
            <Row label="model">
              <input className="picker-input" style={{ width: "100%", boxSizing: "border-box", margin: 0 }} spellCheck={false}
                value={c.overseer.model} onChange={(e) => setOverseer({ model: e.target.value })} />
            </Row>
            <Row label="min seconds between" note="Floor between two turn-triggered entries for one session.">
              <input type="number" min={0} step={10} style={{ width: 90 }} value={c.overseer.stopMinIntervalSec ?? 60}
                onChange={(e) => setOverseer({ stopMinIntervalSec: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
            </Row>
          </Section>

          <Section title="rules">
            <Row label="protected branches" note="Comma separated. Committing on one of these is an alarm; pushing is notable.">
              <input className="picker-input" style={{ width: "100%", boxSizing: "border-box", margin: 0 }} spellCheck={false}
                value={c.rules.protectedBranches.join(", ")}
                onChange={(e) => setRules({ protectedBranches: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            </Row>
            <Row label="subagents / 10 min" note="More SubagentStop events than this in ten minutes flags a subagent storm.">
              <input type="number" min={1} step={1} style={{ width: 90 }} value={c.rules.maxSubagentsPer10m ?? 8}
                onChange={(e) => setRules({ maxSubagentsPer10m: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
            </Row>
            <div style={{ ...st.note, marginLeft: 0, paddingTop: 6 }}>
              The alarm and notable command lists, federation and the port live in <code>~/.henry/config.json</code>; edits there apply without a restart.
            </div>
          </Section>
        </div>
        {error && <div style={st.err}>{error}</div>}
        <div className="foot">
          <span className="hint" style={{ flex: 1, color: "var(--fg-dim)", fontSize: 11 }}>Esc to close without saving</span>
          <button onClick={onClose}>Cancel</button>
          <button onClick={() => void save()} disabled={busy || !dirty}>{busy ? "saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
