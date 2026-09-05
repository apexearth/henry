// Runs each *.test.ts in its own process. `bun test` shares module instances across
// files, and db.ts is a singleton bound to HENRY_HOME at import time, so files that
// each want their own scratch home would otherwise trample one another.
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort();
let failed = 0;
// The daemons these tests spawn are throwaways under scratch homes, but the addresses they
// would bind (the tailnet one, for the phone listener) belong to the machine and to the live
// daemon on it. Loopback only, everywhere; a test that wants a listener names 127.0.0.1.
const env = { ...process.env, HENRY_NO_PUBLIC_LISTENERS: "1" };
for (const f of files) {
  const proc = Bun.spawnSync(["bun", "test", join(dir, f)], { stdout: "inherit", stderr: "inherit", env });
  if (proc.exitCode !== 0) failed++;
}
console.log(`\n[run-all] ${files.length - failed}/${files.length} files passed`);
process.exit(failed ? 1 : 0);
