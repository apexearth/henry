// Runs the daemon (watch mode) and the Vite dev server together. Ctrl+C kills both.
const root = import.meta.dir + "/..";
const procs = [
  Bun.spawn(["bun", "run", "dev"], { cwd: `${root}/packages/daemon`, stdio: ["inherit", "inherit", "inherit"] }),
  Bun.spawn(["bun", "run", "dev"], { cwd: `${root}/packages/ui`, stdio: ["inherit", "inherit", "inherit"] }),
];
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(procs.map((p) => p.exited));
stop();
