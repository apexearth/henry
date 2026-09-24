// Runs the daemon (bun --watch), the Vite dev server and the native shell together; Ctrl+C
// stops all three. Every child is supervised: one that dies comes back after a debounced
// delay that doubles while it keeps dying (1s, 2s, ... 15s) and resets once a run has
// lasted a while. The daemon and Vite are servers, so any exit brings them back; the shell
// is a window, so only a crash does: closing it is a clean exit and stays closed.
//
// The shell is the debug cargo build of packages/shell pointed at Vite (HENRY_URL), so the
// window hot-reloads like a browser tab would. It starts once Vite answers, and an edit
// under src-tauri rebuilds and relaunches it. Without a Rust toolchain, or with --no-shell,
// the other two run alone.
//
// --app is the Start-menu shape (scripts/henry.vbs runs it with no console): the window is the
// app, so closing it stops the daemon and Vite too, and a second launch while they are up just
// opens another window rather than fighting them for their ports. Sessions live in sessiond and
// are untouched either way.
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { spawn as nodeSpawn } from "node:child_process";
import type { Subprocess } from "bun";

const root = join(import.meta.dir, "..");
const VITE_PORT = Number(process.env.HENRY_UI_PORT ?? 14713); // vite.config.ts reads the same variable
const withShell = !process.argv.includes("--no-shell");
const appMode = process.argv.includes("--app");
const tauriDir = join(root, "packages", "shell", "src-tauri");
const shellBin = join(tauriDir, "target", "debug", process.platform === "win32" ? "henry-shell.exe" : "henry-shell");

const log = (msg: string) => console.log(`[dev] ${msg}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let stopping = false;
const running = new Set<Subprocess>();

function spawn(cmd: string[], cwd: string, env?: Record<string, string>): Subprocess {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdio: ["inherit", "inherit", "inherit"] });
  running.add(p);
  void p.exited.then(() => running.delete(p));
  return p;
}

interface Supervised {
  /** Set before killing the current process to have it come back at once, no delay. */
  relaunch: boolean;
  current?: Subprocess;
  done: Promise<void>;
}

const MIN_DELAY = 1_000;
const MAX_DELAY = 15_000;
const STABLE_AFTER = 10_000;

/** Keeps `start()`'s process alive. `restartOnClean: false` lets a zero exit end the loop. */
function supervise(name: string, start: () => Subprocess, restartOnClean: boolean): Supervised {
  const sup: Supervised = { relaunch: false, done: Promise.resolve() };
  sup.done = (async () => {
    let delay = MIN_DELAY;
    while (!stopping) {
      const startedAt = Date.now();
      const p = start();
      sup.current = p;
      const code = await p.exited;
      sup.current = undefined;
      if (stopping) return;
      if (sup.relaunch) {
        sup.relaunch = false;
        continue;
      }
      if (code === 0 && !restartOnClean) {
        if (appMode) {
          log(`${name} closed; stopping`);
          return stop();
        }
        log(`${name} closed (an edit under src-tauri reopens it)`);
        return;
      }
      if (Date.now() - startedAt > STABLE_AFTER) delay = MIN_DELAY;
      log(`${name} ${code === 0 ? "exited" : `died (exit ${code})`}; restarting in ${delay / 1000}s`);
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    }
  })();
  return sup;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

async function waitForPort(port: number): Promise<void> {
  while (!stopping && !(await portOpen(port))) await sleep(250);
}

// ---- shell -------------------------------------------------------------------------------

let building: Promise<boolean> | undefined;
let buildQueued = false;

/** `cargo build` in src-tauri; false (and a log line) when it fails or cargo is missing. */
function buildShell(): Promise<boolean> {
  if (building) {
    buildQueued = true;
    return building;
  }
  building = (async () => {
    let ok = false;
    try {
      log("building shell (cargo build)");
      ok = (await spawn(["cargo", "build"], tauriDir).exited) === 0;
      if (!ok) log("shell build failed; fix the error and save to retry");
    } catch (e) {
      log(`cannot run cargo (${(e as Error).message}); running without the shell`);
    }
    building = undefined;
    if (buildQueued) {
      buildQueued = false;
      return buildShell();
    }
    return ok;
  })();
  return building;
}

let shell: Supervised | undefined;

function launchShell(): void {
  if (shell?.current) return;
  shell = supervise("shell", () => spawn([shellBin], tauriDir, { HENRY_URL: `http://127.0.0.1:${VITE_PORT}` }), false);
}

async function runShell(): Promise<void> {
  if (!(await buildShell())) return;
  if (!existsSync(shellBin)) {
    log(`no shell binary at ${shellBin}`);
    return;
  }
  await waitForPort(VITE_PORT);
  if (stopping) return;
  launchShell();
  watchShellSources();
}

function watchShellSources(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!(await buildShell()) || stopping) return;
      if (shell?.current) {
        shell.relaunch = true;
        shell.current.kill();
      } else {
        launchShell();
      }
    }, 500);
  };
  for (const target of ["src", "capabilities", "Cargo.toml", "tauri.conf.json"]) {
    const p = join(tauriDir, target);
    if (existsSync(p)) watch(p, { recursive: true }, changed);
  }
}

// ---- run ---------------------------------------------------------------------------------

// Each child is a chain (bun run → vite.exe → node, bun run → bun --watch → bun), and on
// Windows killing the head leaves the rest serving. A console's Ctrl+C reaches them all; a
// window closed under --app has no console, so the whole tree goes. sessiond is not in it: it is
// launched through Start-Process, whose PowerShell has long exited.
function killTree(p: Subprocess): void {
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(p.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  else p.kill();
}

function stop(): never {
  stopping = true;
  for (const p of running) killTree(p);
  running.clear();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", () => { for (const p of running) killTree(p); });

if (appMode && (await portOpen(VITE_PORT))) {
  if (existsSync(shellBin)) {
    // Detached: a Bun.spawn child is taken down with this process, which exits right away.
    nodeSpawn(shellBin, [], { cwd: tauriDir, env: { ...process.env, HENRY_URL: `http://127.0.0.1:${VITE_PORT}` }, detached: true, stdio: "ignore" }).unref();
    log("already running; opened a window");
  }
  process.exit(0);
}

const daemon = supervise("daemon", () => spawn(["bun", "run", "dev"], join(root, "packages", "daemon")), true);
const vite = supervise("vite", () => spawn(["bun", "run", "dev"], join(root, "packages", "ui")), true);
if (withShell) void runShell();

await Promise.race([daemon.done, vite.done]);
stop();
