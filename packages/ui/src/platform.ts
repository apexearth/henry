// Which modifier the window-level shortcuts use. On macOS it is ⌘ (metaKey); elsewhere the
// Windows/Super key belongs to the OS, so the same shortcuts sit on Ctrl (and Alt for the
// arrow keys, since Ctrl+arrows are the terminal's).
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

/** The "command" modifier for a keyboard event: ⌘ on macOS, Ctrl elsewhere. */
export const mod = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);

/** The modifier for the shortcuts the terminal would otherwise claim (rail ↑/↓, stage ←/→,
 * and off macOS the explorer's F): ⌘ on macOS, Alt elsewhere. */
export const arrowMod = (e: { metaKey: boolean; altKey: boolean }) => (isMac ? e.metaKey : e.altKey);

/** What the OS calls its file manager, for "open in …". */
export const FILE_MANAGER = isMac ? "Finder" : typeof navigator !== "undefined" && /^Win/.test(navigator.platform || "") ? "Explorer" : "file manager";

/** The window is on this machine's loopback listener, not a phone's; folders open here. */
export const onLoopback = typeof location !== "undefined" && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);

/** Opens `dir` (absolute, on this machine) in the OS file manager. */
export function revealFolder(dir: string): void {
  void fetch("/api/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: dir }) });
}

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
