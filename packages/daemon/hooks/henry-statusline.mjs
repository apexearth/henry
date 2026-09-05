#!/usr/bin/env node
// Claude Code statusLine command -> Henry daemon, for Windows (henry-statusline.sh is the
// macOS/Linux twin). The daemon answers with a compact line ("henry · 5h 42% · 7d 17% · $0.42")
// which Claude Code displays; when the daemon is down this prints nothing. Never fails.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The running daemon publishes its port in <henry home>/port; a session outlives the daemon,
// so the HENRY_PORT in its environment may name a port the daemon left. File first, env next.
function daemonPort() {
  try {
    const home = process.env.HENRY_HOME ? resolve(process.env.HENRY_HOME) : join(homedir(), ".henry");
    const n = Number(readFileSync(join(home, "port"), "utf8").trim());
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  } catch {
    // no daemon has run here, or the home is unreadable
  }
  return process.env.HENRY_PORT || 14711;
}

const timer = setTimeout(() => process.exit(0), 3000);
try {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  // PowerShell may hand the JSON over with a byte-order mark in front.
  const payload = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim() || "{}";
  const body = `{"henrySession":${JSON.stringify(process.env.HENRY_SESSION ?? "")},"payload":${payload}}`;
  const res = await fetch(`http://127.0.0.1:${daemonPort()}/statusline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(1000),
  });
  process.stdout.write(await res.text());
} catch {
  // nothing to show
}
clearTimeout(timer);
process.exit(0);
