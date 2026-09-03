// PTY host: a Node child process that owns node-pty terminals on behalf of the Bun daemon.
// node-pty spawns under Bun but never delivers data (Bun cannot read a pty master through
// net.Socket), while Bun 1.3.3 has no Bun.Terminal yet. Speaks NDJSON on stdin/stdout.
// Once the daemon runs on a Bun with Bun.Terminal, sessions.ts can drop this file.
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import * as pty from "node-pty";

export type HostCommand =
  | { op: "spawn"; id: string; command: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }
  | { op: "write"; id: string; data: string }
  | { op: "resize"; id: string; cols: number; rows: number }
  | { op: "kill"; id: string; signal?: string };

export type HostEvent =
  | { ev: "ready" }
  | { ev: "spawned"; id: string; pid: number }
  | { ev: "data"; id: string; data: string }
  | { ev: "exit"; id: string; exitCode: number; signal?: number }
  | { ev: "error"; id: string; message: string };

// `bun install` skips node-pty's postinstall, which is what makes spawn-helper executable.
function fixSpawnHelper(): void {
  try {
    const req = createRequire(import.meta.url);
    const pkgDir = dirname(req.resolve("node-pty/package.json"));
    const helper = join(pkgDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    if (!(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
  } catch {
    // no prebuild dir (built from source) — nothing to fix
  }
}

const terms = new Map<string, pty.IPty>();
const send = (e: HostEvent) => process.stdout.write(JSON.stringify(e) + "\n");

function handle(cmd: HostCommand): void {
  const t = "id" in cmd ? terms.get(cmd.id) : undefined;
  switch (cmd.op) {
    case "spawn": {
      try {
        const term = pty.spawn(cmd.command, cmd.args, { name: "xterm-256color", cols: cmd.cols, rows: cmd.rows, cwd: cmd.cwd, env: cmd.env });
        terms.set(cmd.id, term);
        term.onData((data) => send({ ev: "data", id: cmd.id, data }));
        term.onExit(({ exitCode, signal }) => {
          terms.delete(cmd.id);
          send({ ev: "exit", id: cmd.id, exitCode, signal });
        });
        send({ ev: "spawned", id: cmd.id, pid: term.pid });
      } catch (e) {
        send({ ev: "error", id: cmd.id, message: (e as Error).message });
      }
      return;
    }
    case "write":
      t?.write(cmd.data);
      return;
    case "resize":
      if (t && cmd.cols > 0 && cmd.rows > 0) t.resize(cmd.cols, cmd.rows);
      return;
    case "kill":
      t?.kill(cmd.signal);
      return;
  }
}

fixSpawnHelper();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line) return;
  try {
    handle(JSON.parse(line));
  } catch (e) {
    process.stderr.write(`[pty-host] bad command: ${(e as Error).message}\n`);
  }
});
process.stdin.on("end", () => {
  for (const t of terms.values()) t.kill();
  process.exit(0);
});
send({ ev: "ready" });
