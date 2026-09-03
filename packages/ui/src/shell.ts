// Bridge to the native shell (packages/shell). It dispatches menu commands on the window
// as `henry:menu` CustomEvents; in a plain browser tab none of this ever fires.
export type MenuCommand = "new-session" | "duplicate-session" | "reset-layout";

export const inShell = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Runs `fn` when the shell's menu fires `cmd`. Returns an unsubscribe for useEffect. */
export function onMenu(cmd: MenuCommand, fn: () => void) {
  const handler = (e: Event) => {
    if ((e as CustomEvent<string>).detail === cmd) fn();
  };
  window.addEventListener("henry:menu", handler);
  return () => window.removeEventListener("henry:menu", handler);
}
