#!/usr/bin/env node
// Claude Code hook -> Henry daemon, for Windows (henry-hook.sh is the macOS/Linux twin; there
// is no curl to lean on here and the hook runs under Git Bash or PowerShell). Never blocks,
// never fails the tool call. settings.json: "command": "node <path>/henry-hook.mjs PreToolUse"
const timer = setTimeout(() => process.exit(0), 3000);
try {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  // PowerShell may hand the JSON over with a byte-order mark in front.
  const payload = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim() || "{}";
  const body = `{"henrySession":${JSON.stringify(process.env.HENRY_SESSION ?? "")},"henryHookEvent":${JSON.stringify(process.argv[2] ?? "")},"payload":${payload}}`;
  await fetch(`http://127.0.0.1:${process.env.HENRY_PORT || 4711}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(1000),
  });
} catch {
  // a stopped daemon costs the session nothing
}
clearTimeout(timer);
process.exit(0);
