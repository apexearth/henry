// Topbar "keys" modal: every shortcut Henry binds, in one place. The bindings live in
// App.tsx, Rail.tsx, Terminal.tsx, the pickers and the shell menu; keep this list in step.
import { useEffect } from "react";
import { inShell } from "./shell";

type Key = [keys: string[], what: string];

// ⌘N and ⌘⇧R are reserved by Chrome in a browser tab (new window, reload); the shell's menu owns them.
const SECTIONS: [string, Key[]][] = [
  ["sessions", [
    [["⌘1…9", "⌃1…9"], "switch to the nth session in rail order"],
    [["⌘↑", "⌘↓"], "previous / next session in the rail, wrapping"],
    [[inShell ? "⌘N" : "⌃N"], "new session (the + new session picker)"],
    [["⌘D"], "duplicate the session in view: same kind, same folder"],
    [["⇧↩"], "newline in Claude Code's prompt instead of sending"],
  ]],
  ["files", [
    [["⌘K", "⌃K"], "find a file to peek at (⌃K stays kill-line in the terminal)"],
    [["⌘ click"], "peek at a path in terminal output or a diff header"],
    [["⌘←", "⌘→"], "walk the stage: the session, then its peeks"],
    [["esc"], "close the peek in view, or the dialog that is open"],
  ]],
  ["pickers", [
    [["↑", "↓"], "move the selection"],
    [["↩"], "open the selected file or start the session"],
    [["esc"], "close"],
  ]],
  ["window", [
    [["⌘/"], "this list"],
    ...(inShell ? [[["⌘⇧R"], "reset layout: rail | terminals | tools"], [["⌘R"], "reload"]] as Key[] : []),
  ]],
];

export function Keys({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal keys" onMouseDown={(e) => e.stopPropagation()}>
        <h3>keyboard shortcuts</h3>
        <div className="list">
          {SECTIONS.map(([name, keys]) => (
            <div key={name} className="keys-section">
              <div className="keys-h">{name}</div>
              {keys.map(([combo, what]) => (
                <div key={what} className="keys-row">
                  <span className="keys-combo">
                    {combo.map((k, i) => (
                      <span key={k}>{i > 0 && <span className="keys-or">or</span>}<kbd>{k}</kbd></span>
                    ))}
                  </span>
                  <span className="keys-what">{what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="foot hint">
          <span>{inShell ? "native window: ⌘N and ⌘⇧R come from the menu" : "browser tab: Chrome keeps ⌘N and ⌘⇧R, so ⌃N and the reset layout button stand in"}</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
