// Topbar "keys" modal: every shortcut Henry binds, in one place. The bindings live in
// App.tsx, Rail.tsx, Terminal.tsx, the pickers and the shell menu; keep this list in step.
import { useEffect } from "react";
import { ARROW_MOD, MOD, isMac } from "./platform";
import { inShell } from "./shell";

type Key = [keys: string[], what: string];

// ⌘N and ⌘⇧R are reserved by Chrome in a browser tab (new window, reload); the shell's menu owns them
// on macOS, and on Windows the shell has no menu and nothing reserved, so the page binds them itself.
// Off macOS the same shortcuts sit on Ctrl (letters, digits) and Alt (arrows, N); see platform.ts.
const SHIFT_R = isMac ? "⌘⇧R" : "Ctrl+Shift+R";
const SECTIONS: [string, Key[]][] = [
  ["sessions", [
    [isMac ? ["⌘1…9", "⌃1…9"] : ["Ctrl+1…9"], "switch to the nth session in rail order"],
    [[`${ARROW_MOD}↑`, `${ARROW_MOD}↓`], "previous / next session in the rail, wrapping"],
    [[isMac ? (inShell ? "⌘N" : "⌃N") : inShell ? "Ctrl+N" : "Alt+N"], "new session (the + new session picker)"],
    [[isMac ? "⌘D" : "Ctrl+Shift+D"], "duplicate the session in view: same kind, same folder"],
    [["⇧↩"], "newline in Claude Code's prompt instead of sending"],
  ]],
  ["files", [
    [isMac ? ["⌘K", "⌃K"] : ["Ctrl+K"], isMac ? "find a file to peek at (⌃K stays kill-line in the terminal)" : "find a file to peek at (outside the terminal, where it is kill-line)"],
    [[isMac ? "⌘ click" : "Ctrl click"], "peek at a path in terminal output or a diff header"],
    [[`${ARROW_MOD}←`, `${ARROW_MOD}→`], "walk the stage: the session, then its peeks"],
    [["esc"], "close the peek in view, or the dialog that is open"],
  ]],
  ["pickers", [
    [["↑", "↓"], "move the selection"],
    [["↩"], "open the selected file or start the session"],
    [["esc"], "close"],
  ]],
  ["window", [
    [[`${MOD}/`], "this list"],
    ...(inShell ? [[[SHIFT_R], "reset layout: rail | terminals | tools"]] as Key[] : []),
    ...(inShell && isMac ? [[["⌘R"], "reload"]] as Key[] : []),
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
          <span>{inShell
            ? isMac ? `native window: ⌘N and ⌘⇧R come from the menu` : "native window: no menu, and nothing is reserved"
            : `browser tab: Chrome keeps ${MOD}N and ${SHIFT_R}, so ${isMac ? "⌃N" : "Alt+N"} and the reset layout button stand in`}</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
