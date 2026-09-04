// Which modifier the window-level shortcuts use. On macOS it is ⌘ (metaKey); elsewhere the
// Windows/Super key belongs to the OS, so the same shortcuts sit on Ctrl (and Alt for the
// arrow keys, since Ctrl+arrows are the terminal's).
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

/** The "command" modifier for a keyboard event: ⌘ on macOS, Ctrl elsewhere. */
export const mod = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);

/** The modifier for the arrow-key shortcuts (rail ↑/↓, stage ←/→): ⌘ on macOS, Alt elsewhere. */
export const arrowMod = (e: { metaKey: boolean; altKey: boolean }) => (isMac ? e.metaKey : e.altKey);

/** Shortcut labels for tooltips. */
export const MOD = isMac ? "⌘" : "Ctrl+";
export const ARROW_MOD = isMac ? "⌘" : "Alt+";

/** Last path segment, whichever separator the path uses. */
export function baseName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

/** True when `path` is `dir` or lives under it (either separator). */
export function under(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + "/") || path.startsWith(dir + "\\");
}

/** `dir/rel` with the separator `dir` already uses. */
export function joinPath(dir: string, rel: string): string {
  return `${dir}${dir.includes("\\") && !dir.includes("/") ? "\\" : "/"}${rel}`;
}
