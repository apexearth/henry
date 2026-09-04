// What differs between macOS/Linux and Windows for the processes Henry starts. Everything
// else in the daemon is written against Node's path/os modules, which already do the right
// thing per platform; this file holds the few decisions that need a platform switch.
import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

export const isWindows = process.platform === "win32";

/**
 * How a window makes the program in a terminal repaint after showing it again. A same-size
 * TIOCSWINSZ raises no SIGWINCH, so on POSIX the daemon drops a row and restores it. ConPTY
 * repaints the whole screen on any resize and reflows its buffer on a shrink, which is what
 * garbles a TUI, so on Windows one plain resize is both enough and all that is safe.
 */
export const redrawByShrink = !isWindows;

/** "claude" for claude, claude.exe, claude.cmd, C:\x\claude.exe, /usr/local/bin/claude. */
export function programName(command: string): string {
  return basename(command).replace(/\.(exe|cmd|bat)$/i, "");
}

/** The user's login shell (POSIX) or PowerShell (Windows; cmd.exe when even that is missing). */
export function defaultShell(): { command: string; args: string[] } {
  if (!isWindows) return { command: process.env.SHELL || "/bin/zsh", args: ["-l"] };
  const ps = Bun.which("pwsh") ?? Bun.which("powershell");
  return ps ? { command: ps, args: ["-NoLogo"] } : { command: process.env.COMSPEC || "cmd.exe", args: [] };
}

export function resolveClaude(): string {
  return Bun.which("claude") ?? "claude";
}

/**
 * What to hand a process spawner for `command args`. A Windows `.cmd`/`.bat` cannot be started
 * directly (CreateProcess wants an executable). npm's `claude.cmd` only runs `node cli.js`, so
 * that is spawned as-is when the file is where npm puts it; any other batch file goes through
 * cmd.exe, whose quoting only holds when the paths carry no spaces.
 */
export function spawnSpec(command: string, args: string[]): { command: string; args: string[] } {
  if (!isWindows || !/\.(cmd|bat)$/i.test(command)) return { command, args };
  const cli = join(dirname(command), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  if (programName(command) === "claude" && existsSync(cli)) {
    const node = Bun.which("node");
    if (node) return { command: node, args: [cli, ...args] };
  }
  return { command: process.env.COMSPEC || "cmd.exe", args: ["/d", "/c", command, ...args] };
}

/** Prepend `dir` to the PATH in `env`, whatever the variable is called there (Windows: `Path`). */
export function prependPath(env: Record<string, string>, dir: string): void {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const current = env[key];
  env[key] = current ? `${dir}${delimiter}${current}` : isWindows ? dir : `${dir}:/usr/local/bin:/usr/bin:/bin`;
}

/** Windows paths for a POSIX-minded consumer (bash, JSON in settings.json, the UI). */
export function slashes(p: string): string {
  return isWindows ? p.replace(/\\/g, "/") : p;
}

/** `~`, `~/x` and (Windows) `~\x` with the home directory filled in. */
export function expandTilde(p: string, home: string): string {
  return p === "~" ? home : /^~[\\/]/.test(p) ? join(home, p.slice(2)) : p;
}
