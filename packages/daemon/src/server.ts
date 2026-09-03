// HTTP + WS on 127.0.0.1:<port>. Serves packages/ui/dist, /api/*, /hook, /statusline, /ws.
// Later milestones: import { broadcast } from "./server" to push ServerMessages to every window.
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import type { ServerWebSocket } from "bun";
import type { ClientMessage, ServerMessage, StateSnapshot, Usage } from "@henry/shared";
import { config } from "./config";
import * as db from "./db";
import * as git from "./git";
import * as hooks from "./hooks";
import * as overseer from "./overseer";
import { sessions } from "./sessions";

const uiDist = join(import.meta.dir, "../../ui/dist");
const ALL = "all";
const topic = (sessionId: string) => `session:${sessionId}`;

interface WsData {
  attached: Set<string>;
}

type Ws = ServerWebSocket<WsData>;

let server: ReturnType<typeof Bun.serve<WsData>> | undefined;

/** Send to every connected window. */
export function broadcast(msg: ServerMessage): void {
  server?.publish(ALL, JSON.stringify(msg));
}

/** Send to windows attached to one session (PTY traffic only). */
function publishSession(sessionId: string, msg: ServerMessage): void {
  server?.publish(topic(sessionId), JSON.stringify(msg));
}

function send(ws: Ws, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

export function buildState(): StateSnapshot {
  const snapshot = db.latestUsageSnapshot<Usage>();
  const usage: Usage = snapshot?.json ?? { perSession: {}, updatedAt: 0 };
  usage.perSession = db.listSessionUsage();
  return {
    sessions: sessions.list(),
    repos: git.getAllSessionRepos(),
    flags: db.listFlags({ limit: 500 }),
    usage,
    playbook: db.listPlaybook(undefined, 200),
    config,
  };
}

sessions.on("data", (id, data) => publishSession(id, { type: "pty:data", sessionId: id, data }));
sessions.on("exit", (id, exitCode) => publishSession(id, { type: "pty:exit", sessionId: id, exitCode }));
sessions.on("update", (session) => broadcast({ type: "session:update", session }));

async function handleMessage(ws: Ws, msg: ClientMessage): Promise<void> {
  switch (msg.type) {
    case "attach": {
      if (!sessions.get(msg.sessionId)) return;
      ws.data.attached.add(msg.sessionId);
      ws.subscribe(topic(msg.sessionId));
      send(ws, { type: "pty:scrollback", sessionId: msg.sessionId, data: sessions.scrollback(msg.sessionId) });
      const s = sessions.get(msg.sessionId);
      if (s?.status === "exited") send(ws, { type: "pty:exit", sessionId: msg.sessionId, exitCode: s.exitCode ?? 0 });
      return;
    }
    case "detach":
      ws.data.attached.delete(msg.sessionId);
      ws.unsubscribe(topic(msg.sessionId));
      return;
    case "pty:input":
      sessions.write(msg.sessionId, msg.data);
      return;
    case "pty:resize":
      sessions.resize(msg.sessionId, msg.cols, msg.rows);
      return;
    case "session:create": {
      // The manager's "update" listener broadcasts too; this direct send carries the requestId
      // so the creating window can select the new tab.
      const session = await sessions.create({ cwd: msg.cwd, title: msg.title, command: msg.command, args: msg.args });
      send(ws, { type: "session:update", session, requestId: msg.requestId });
      return;
    }
    case "session:kill":
      sessions.kill(msg.sessionId);
      if (!sessions.get(msg.sessionId)) broadcast({ type: "state", ...buildState() });
      return;
    case "flags:markRead":
      db.markFlagsRead(msg.ids);
      return;
    case "playbook:request":
      for (const entry of db.listPlaybook(msg.sessionId).reverse()) send(ws, { type: "playbook:update", entry });
      return;
    case "repo:diff": {
      const { diff, baseline } = await git.diffSinceBaseline(msg.sessionId, msg.repoPath);
      send(ws, { type: "repo:diff", sessionId: msg.sessionId, repoPath: msg.repoPath, diff, baseline });
      return;
    }
    case "state:request":
      send(ws, { type: "state", ...buildState() });
      return;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function serveStatic(pathname: string): Promise<Response> {
  if (!existsSync(join(uiDist, "index.html"))) {
    return new Response(
      `<!doctype html><meta charset=utf-8><title>Henry</title><body style="font:14px monospace;background:#111;color:#ddd;padding:2em">
<h2>Henry daemon is running on :${config.port}</h2><p>No UI build found. Run <code>bun run dev</code> and open
<a href="http://127.0.0.1:5173" style="color:#8cf">http://127.0.0.1:5173</a>, or <code>bun run build</code> then reload this page.</p>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(uiDist, rel === "/" ? "index.html" : rel));
  if (await file.exists()) return new Response(file);
  return new Response(Bun.file(join(uiDist, "index.html")));
}

export function startServer(): void {
  server = Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: config.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const { pathname } = url;
      if (pathname === "/ws") {
        return srv.upgrade(req, { data: { attached: new Set<string>() } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (req.method === "POST" && pathname === "/hook") {
        try {
          hooks.ingestHook(await readJson(req));
        } catch (e) {
          console.error("[hook] ingest failed:", e);
        }
        return json({ ok: true });
      }
      if (req.method === "POST" && pathname === "/statusline") {
        // Claude Code displays whatever the status command prints; the script echoes this body.
        const result = hooks.ingestStatusline(await readJson(req));
        return new Response(result?.text ?? "", { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (pathname === "/api/state") return json(buildState());
      if (pathname === "/api/playbook/status") return json(overseer.overseerStatus());
      if (req.method === "POST" && pathname === "/api/playbook/manual") {
        const body = (await readJson(req)) as { sessionId?: string | null; prompt?: string };
        if (!body.prompt?.trim()) return json({ error: "prompt required" }, 400);
        const entry = await overseer.writeManual(body.sessionId || null, body.prompt.trim());
        return entry ? json({ entry }) : json({ error: overseer.overseerStatus().lastError ?? "overseer wrote nothing" }, 502);
      }
      if (pathname === "/api/events") {
        return json(db.listEvents({ sessionId: url.searchParams.get("session") ?? undefined, limit: Number(url.searchParams.get("limit")) || 200 }));
      }
      if (pathname === "/api/repos") return json(await git.listRepos(config.reposRoot));
      if (pathname === "/api/repo/log") {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const repoPath = url.searchParams.get("repoPath") ?? "";
        return json(await git.logSinceBaseline(sessionId, repoPath));
      }
      if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      return serveStatic(pathname);
    },
    websocket: {
      open(ws) {
        ws.subscribe(ALL);
        send(ws, { type: "state", ...buildState() });
      },
      async message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        } catch {
          return;
        }
        try {
          await handleMessage(ws, msg);
        } catch (e) {
          console.error(`[ws] ${msg.type} failed:`, e);
        }
      },
      close(ws) {
        for (const id of ws.data.attached) ws.unsubscribe(topic(id));
      },
    },
  });
  git.setBroadcast(broadcast);
  git.start();
  console.log(`[henry] listening on http://127.0.0.1:${config.port} (db: ${db.dbPath})`);
}

export function stopServer(): void {
  git.stop();
  sessions.shutdown();
  server?.stop(true);
}
