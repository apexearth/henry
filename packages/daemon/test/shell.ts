// The throwaway shell the tests type into: /bin/sh on macOS/Linux, PowerShell on Windows
// (cmd.exe has no pid variable and no arithmetic). Each helper returns the line to send.
export const isWindows = process.platform === "win32";

export const testShell = isWindows ? { command: "powershell.exe", args: ["-NoLogo", "-NoProfile"] } : { command: "/bin/sh", args: [] };

/** Prints `<label>-<shell pid>`. */
export const echoPid = (label: string) => (isWindows ? `echo ${label}-$PID\r` : `echo ${label}-$$\r`);

/** Prints `<label>-<result of an integer expression>`, e.g. echoExpr("smoke", "40+2") -> smoke-42. */
export const echoExpr = (label: string, expr: string) => (isWindows ? `echo ${label}-$(${expr})\r` : `echo ${label}-$((${expr}))\r`);

/** A process that has already exited, for "dead pid" fixtures. */
export const deadCommand = isWindows ? [process.execPath, "--version"] : ["/bin/sh", "-c", "true"];
