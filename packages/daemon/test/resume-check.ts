// Manual check: resume a real Claude session through the daemon and confirm the
export {};
// resumed transcript is on screen. Usage: HENRY_PORT=4799 bun test/resume-check.ts <claude-session-id> <cwd>
const [id, cwd] = process.argv.slice(2);
const port = process.env.HENRY_PORT ?? "4799";
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let out = "";
let sid = "";
const done = new Promise<void>((resolve) => {
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === "session:update" && m.requestId === "r1") { sid = m.session.id; ws.send(JSON.stringify({ type: "attach", sessionId: sid })); }
    if (m.type === "pty:data" || m.type === "pty:scrollback") out += m.data;
    if (/Reply with just the word ok/.test(out)) resolve();
  };
});
ws.onopen = () => ws.send(JSON.stringify({ type: "session:create", cwd, resume: id, requestId: "r1" }));
await Promise.race([done, Bun.sleep(25_000)]);
console.log("resumed session", sid, "saw prior turn:", /Reply with just the word ok/.test(out));
const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
console.log("--- last 800 chars of terminal ---\n" + plain.slice(-800));
ws.send(JSON.stringify({ type: "session:kill", sessionId: sid }));
await Bun.sleep(500);
process.exit(0);
