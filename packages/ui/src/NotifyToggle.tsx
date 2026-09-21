// The one control for OS notifications, in Settings on a desk and in the drawer on a phone.
// It applies on the click, not on Save: the setting is this browser's, not the daemon's.
import type { CSSProperties } from "react";
import { setWanted, useNotifyState } from "./notify";

const st = {
  check: { display: "flex", alignItems: "center", gap: 8, padding: "3px 0" } as CSSProperties,
  note: { color: "var(--fg-dim)", fontSize: 11, lineHeight: 1.45, paddingTop: 2 } as CSSProperties,
};

export function NotifyToggle({ id = "notify-toggle" }: { id?: string }) {
  const { wanted, permission } = useNotifyState();
  const note =
    permission === "unsupported" ? "this browser cannot show notifications"
    : permission === "denied" ? "blocked by the browser: allow notifications for this site in its settings, then try again"
    : wanted && permission === "default" ? "waiting for the browser's permission prompt"
    : undefined;
  return (
    <>
      <div style={st.check}>
        <input id={id} type="checkbox" checked={wanted} disabled={permission === "unsupported"} onChange={(e) => void setWanted(e.target.checked)} />
        <label htmlFor={id}>notify me when a session needs me</label>
      </div>
      {note && <div style={st.note}>{note}</div>}
    </>
  );
}
