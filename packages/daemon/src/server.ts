// HTTP + WS on 127.0.0.1:<port>. Serves packages/ui/dist, /api/*, /hook, /statusline, /ws.
// Later milestones: import { broadcast } from "./server" to push ServerMessages to every window.
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import type { ServerWebSocket } from "bun";
import type { ClientMessage, ServerMessage, StateSnapshot, Usage } from "@henry/shared";
import * as activity from "./activity";
import { config, expandHome, isFirstRun, setReposRoot } from "./config";
import * as db from "./db";
import * as engagement from "./engagement";
import * as federation from "./federation";
import type { Client } from "./federation";
import type { FedState, PeerLink } from "./fed-peer";
import * as git from "./git";
import * as files from "./files";
import * as hooks from "./hooks";
import * as overseer from "./overseer";
import { sessions } from "./sessions";

const uiDist = join(import.meta.dir, "../../ui/dist");
const ALL = "all";
const topic = (sessionId: string) => `session:${sessionId}`;

interface WsData {
  client: Client;
}

type Ws = ServerWebSocket<WsData>;

let server: ReturnType<typeof Bun.serve<WsData>> | undefined;

/** Send to every connected window, and on to the peers dialed in to us (local state only). */
export function broadcast(msg: ServerMessage): void {
  toWindows(msg);
  federation.fanout(msg);
}

/** Windows only: what a peer relayed to us must not fan back out. */
export function toWindows(msg: ServerMessage): void {
  server?.publish(ALL, JSON.stringify(msg));
}

/** Send to windows (and peers) attached to one session (PTY traffic only). */
function publishSession(sessionId: string, msg: ServerMessage): void {
  server?.publish(topic(sessionId), JSON.stringify(msg));
  federation.publishInbound(sessionId, msg);
}

/** A window as a Client: JSON frames, pub/sub topics per session. */
function windowClient(ws: Ws): Client {
  return {
    attached: new Set<string>(),
    fromPeer: false,
    get open() {
      return ws.readyState === 1;
    },
    send: (msg) => ws.send(JSON.stringify(msg)),
    subscribe: (id) => ws.subscribe(topic(id)),
    unsubscribe: (id) => ws.unsubscribe(topic(id)),
  };
}

/** Everything in the window's snapshot: this daemon's sessions plus each connected peer's. */
export function buildState(): StateSnapshot {
  return federation.merge(localState());
}

/** What a peer is shown: our sessions, repos, flags, usage, playbook. Never the config (keys). */
function peerState(): FedState {
  const { config: _config, uiBuild: _build, firstRun: _first, ...rest } = localState();
  return rest;
}

function localState(): StateSnapshot {
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
    firstRun: isFirstRun(),
    uiBuild,
  };
}

// The Vite dev server (:14713) has HMR; windows on the daemon's own port see ui/dist, which
// only changes on `bun run build`. Poll its index.html and tell every window to reload, so
// a build is enough and nobody has to remember to refresh. Polling, not fs.watch: dist may
// not exist yet, and vite empties and recreates it.
let uiBuild: string | undefined = readUiBuild();
function readUiBuild(): string | undefined {
  try {
    return String(Math.floor(statSync(join(uiDist, "index.html")).mtimeMs));
  } catch {
    return undefined;
  }
}
let uiBuildTimer: ReturnType<typeof setInterval> | undefined;
function watchUiBuild(): void {
  uiBuildTimer = setInterval(() => {
    const build = readUiBuild();
    if (!build || build === uiBuild) return;
    uiBuild = build;
    broadcast({ type: "ui:build", build });
  }, 1500);
}

sessions.on("data", (id, data) => publishSession(id, { type: "pty:data", sessionId: id, data }));
sessions.on("exit", (id, exitCode) => publishSession(id, { type: "pty:exit", sessionId: id, exitCode }));
sessions.on("update", (session) => broadcast({ type: "session:update", session }));

async function handleMessage(client: Client, msg: ClientMessage): Promise<void> {
  // A session relayed from a paired machine: its link answers, in the same shapes. Not for a
  // peer, though: pairing is between two machines, and a peer must not reach our other peers
  // through us (its own pairing with them is the only way).
  const link = "sessionId" in msg && msg.sessionId ? federation.linkOf(msg.sessionId) : undefined;
  if (client.fromPeer && (link || (msg.type === "session:create" && msg.peer))) {
    console.error(`[fed] refused ${msg.type} from a peer aimed at another peer`);
    return;
  }
  if (link) return handleRemote(client, msg, link);
  switch (msg.type) {
    case "attach": {
      const id = msg.sessionId;
      if (!sessions.get(id)) return;
      client.attached.add(id);
      // Scrollback comes from sessiond. Subscribe to live output inside the callback, which
      // runs before any later data event is published, so the window never sees output
      // that is also in the scrollback, nor output from before it out of order.
      sessions.withScrollback(id, (data) => {
        if (!client.open || !client.attached.has(id)) return;
        client.subscribe(id);
        const s = sessions.get(id);
        const exitCode = s?.status === "exited" ? s.exitCode ?? 0 : undefined;
        // A daemon relaying for one of its windows (reqId) gets the exit in the same frame.
        if (msg.reqId !== undefined) client.send({ type: "pty:scrollback", sessionId: id, data, reqId: msg.reqId, exitCode });
        else {
          client.send({ type: "pty:scrollback", sessionId: id, data });
          if (exitCode !== undefined) client.send({ type: "pty:exit", sessionId: id, exitCode });
        }
      });
      return;
    }
    case "detach":
      client.attached.delete(msg.sessionId);
      client.unsubscribe(msg.sessionId);
      return;
    case "pty:input":
      sessions.write(msg.sessionId, msg.data);
      engagement.input(msg.sessionId, msg.data);
      return;
    case "pty:resize":
      sessions.resize(msg.sessionId, msg.cols, msg.rows, msg.redraw);
      return;
    case "session:create": {
      if (msg.peer) {
        const remote = federation.linkNamed(msg.peer);
        if (!remote) return console.error(`[ws] session:create on ${msg.peer}: no such connected peer`);
        remote.create(msg, (session) => client.send({ type: "session:update", session, requestId: msg.requestId }));
        return;
      }
      // The manager's "update" listener broadcasts too; this direct send carries the requestId
      // so the creating window can select the new tab.
      const session = await sessions.create({ cwd: msg.cwd, title: msg.title, kind: msg.kind, command: msg.command, args: msg.args, resume: msg.resume });
      client.send({ type: "session:update", session, requestId: msg.requestId });
      return;
    }
    case "session:kill":
      sessions.kill(msg.sessionId);
      if (!sessions.get(msg.sessionId)) broadcast({ type: "state", ...buildState() });
      return;
    case "flags:markRead":
      db.markFlagsRead(client.fromPeer ? msg.ids : federation.markFlagsRead(msg.ids));
      return;
    case "playbook:request":
      for (const entry of db.listPlaybook(msg.sessionId).reverse()) client.send({ type: "playbook:update", entry });
      return;
    case "repo:diff": {
      const { diff, baseline } = await git.diffSinceBaseline(msg.sessionId, msg.repoPath);
      client.send({ type: "repo:diff", sessionId: msg.sessionId, repoPath: msg.repoPath, diff, baseline });
      return;
    }
    case "state:request":
      client.send({ type: "state", ...buildState() });
      return;
  }
}

function handleRemote(client: Client, msg: ClientMessage, link: PeerLink): void {
  switch (msg.type) {
    case "attach": {
      const id = msg.sessionId;
      client.attached.add(id);
      link.attach(id, (data, exitCode) => {
        if (!client.open || !client.attached.has(id)) return;
        client.subscribe(id);
        client.send({ type: "pty:scrollback", sessionId: id, data });
        if (exitCode !== undefined) client.send({ type: "pty:exit", sessionId: id, exitCode });
      });
      return;
    }
    case "detach":
      if (client.attached.delete(msg.sessionId)) {
        client.unsubscribe(msg.sessionId);
        link.detach(msg.sessionId);
      }
      return;
    case "pty:input":
    case "pty:resize":
    case "session:kill":
    case "playbook:request":
    case "repo:diff":
      link.send(msg);
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
<a href="http://127.0.0.1:14713" style="color:#8cf">http://127.0.0.1:14713</a>, or <code>bun run build</code> then reload this page.</p>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(uiDist, rel === "/" || rel === "\\" ? "index.html" : rel));
  if (await file.exists()) return new Response(file);
  return new Response(Bun.file(join(uiDist, "index.html")));
}

export async function startServer(): Promise<void> {
  // Reconcile with sessiond before answering anyone, so the first /api/state is right.
  await sessions.start();
  // Re-derives each running session's activity from its last hook, then ages it on a tick.
  activity.start();
  engagement.start();
  server = Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: config.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const { pathname } = url;
      if (pathname === "/ws") {
        return srv.upgrade(req, { data: { client: undefined as unknown as Client } }) ? undefined : new Response("upgrade failed", { status: 400 });
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
      if (pathname.startsWith("/api/")) return handleApi(req, url, false);
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      return serveStatic(pathname);
    },
    websocket: {
      open(ws) {
        ws.data.client = windowClient(ws);
        ws.subscribe(ALL);
        ws.data.client.send({ type: "state", ...buildState() });
      },
      async message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        } catch {
          return;
        }
        try {
          await handleMessage(ws.data.client, msg);
        } catch (e) {
          console.error(`[ws] ${msg.type} failed:`, e);
        }
      },
      close(ws) {
        for (const id of ws.data.client.attached) {
          ws.unsubscribe(topic(id));
          federation.linkOf(id)?.detach(id);
        }
      },
    },
  });
  git.setBroadcast(broadcast);
  git.start();
  federation.init({ handleMessage, localState: peerState, handleApi: (req, fromPeer) => handleApi(req, new URL(req.url), fromPeer), toWindows, publishSession, buildState });
  federation.start();
  watchUiBuild();
  console.log(`[henry] listening on http://127.0.0.1:${config.port} (db: ${db.dbPath})`);
}

/**
 * /api/*. A request for a peer's session (`sessionId` of a relayed session, or an explicit
 * `peer=` query) is forwarded over the link and answered by that daemon's copy of this
 * function. Peers may never reach /api/federation/*, so `fromPeer` requests are refused there.
 */
export async function handleApi(req: Request, url: URL, fromPeer: boolean): Promise<Response> {
  const { pathname } = url;
  if (pathname.startsWith("/api/federation/")) return fromPeer ? json({ error: "forbidden" }, 403) : federationApi(req, url);
  // Peers read, and may ask the overseer; they never change this daemon's setup.
  if (fromPeer && req.method !== "GET" && pathname !== "/api/playbook/manual") return json({ error: "forbidden" }, 403);
  if (!fromPeer) {
    const peerName = url.searchParams.get("peer") ?? federation.linkOf(url.searchParams.get("sessionId"))?.rec.name;
    if (peerName) {
      const link = federation.linkNamed(peerName);
      if (!link) return json({ error: `${peerName} is not a connected peer` }, 502);
      url.searchParams.delete("peer");
      return link.http(req.method, url.pathname + url.search, req.method === "GET" ? undefined : await req.text());
    }
  }
  if (pathname === "/api/state") return json(fromPeer ? peerState() : buildState());
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
      // First-run setup: choose the folder that holds every repo. Validated here, not in the
      // UI, because only the daemon can see the filesystem.
      if (req.method === "POST" && pathname === "/api/config") {
        const body = (await readJson(req)) as { reposRoot?: string };
        const typed = (body.reposRoot ?? "").trim().replace(/(.)[\\/]+$/, "$1");
        if (!typed) return json({ error: "path required" }, 400);
        const root = expandHome(typed);
        let isDir = false;
        try {
          isDir = statSync(root).isDirectory();
        } catch {}
        if (!isDir) return json({ error: `${root} is not a folder` }, 400);
        setReposRoot(typed);
        broadcast({ type: "state", ...buildState() });
        return json({ ok: true, reposRoot: config.reposRoot });
      }
      if (pathname === "/api/repos") {
        // `root` previews another folder (first-run setup) without changing config.
        const root = url.searchParams.get("root");
        return json(await git.listRepos(root ? expandHome(root.trim()) : config.reposRoot));
      }
      if (pathname === "/api/repo/log") {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const repoPath = url.searchParams.get("repoPath") ?? "";
        return json(await git.logSinceBaseline(sessionId, repoPath));
      }
      if (pathname === "/api/session/files") return json(await git.sessionFiles(url.searchParams.get("sessionId") ?? ""));
      if (pathname === "/api/repo/files") return json(await git.listFiles(url.searchParams.get("repo") ?? ""));
      if (pathname === "/api/file/diff") {
        const d = await git.fileDiff(url.searchParams.get("sessionId") || undefined, url.searchParams.get("path") ?? "");
        return d ? json(d) : json({ error: "not in a repo" }, 404);
      }
      if (pathname === "/api/file") {
        const peek = files.readPeek(url.searchParams.get("path") ?? "", url.searchParams.get("cwd") ?? undefined);
        return peek ? json(peek) : json({ error: "not found" }, 404);
      }
  return json({ error: "not found" }, 404);
}

/** Pairing and peer management. Loopback only: never proxied, never served to a peer. */
async function federationApi(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  if (pathname === "/api/federation/status") return json(federation.status());
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  if (pathname === "/api/federation/pairing/start") return json(federation.startPairing());
  if (pathname === "/api/federation/pairing/stop") {
    federation.stopPairing();
    return json({ ok: true });
  }
  const body = (await readJson(req)) as { address?: string; code?: string; name?: string; enabled?: boolean };
  if (pathname === "/api/federation/pair") {
    if (!body.address || !body.code) return json({ error: "address and code required" }, 400);
    try {
      return json({ peer: await federation.pair(body.address, body.code) });
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
  }
  if (pathname === "/api/federation/peer/forget") return body.name && federation.forgetPeer(body.name) ? json({ ok: true }) : json({ error: "no such peer" }, 404);
  if (pathname === "/api/federation/peer/enable") {
    return body.name && federation.enablePeer(body.name, body.enabled !== false) ? json({ ok: true }) : json({ error: "no such peer" }, 404);
  }
  return json({ error: "not found" }, 404);
}

/** Stops the daemon's own listeners. sessiond and the sessions in it keep running. */
export function stopServer(): void {
  clearInterval(uiBuildTimer);
  federation.stop();
  activity.stop();
  engagement.stop();
  git.stop();
  sessions.shutdown();
  server?.stop(true);
}
