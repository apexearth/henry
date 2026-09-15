// `?demo`: the page with no daemon behind it. WebSocket and fetch are replaced before anything
// connects, and answer from ./world.ts and ./screens.ts, so every component renders exactly as
// it does live, on data that is the same every time. For screenshots, and for poking at the UI
// on a machine with no sessions. Nothing here runs unless the query string asks for it.
//
// Installs itself at import time and is main.tsx's first import: ws.ts reads localStorage while
// it is being evaluated, so the storage shadow below has to be in place before that module loads.
import type { ClientMessage, ServerMessage } from "@henry/shared";
import { screen } from "./screens";
import * as world from "./world";

export function demoEnabled(): boolean {
  const v = new URLSearchParams(location.search).get("demo");
  return v !== null && v !== "0";
}

/** In-memory Storage, so a demo opened on the live origin leaves the real window's remembered
 * session, layout, recent files and hidden rows exactly as they were. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(String(k)) ?? null,
    setItem: (k, v) => void m.set(String(k), String(v)),
    removeItem: (k) => void m.delete(String(k)),
    clear: () => m.clear(),
  };
}

type Handler = ((e: { data: string }) => void) | null;

/** Enough of a WebSocket for ws.ts: opens on the next tick, answers attach and resize with a
 * screen, and swallows the rest. Typing goes nowhere; the sessions are pictures. */
class DemoSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: Handler = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** Latest reported size per attached session; a screen is drawn once both are known. */
  private sizes = new Map<string, { cols: number; rows: number }>();
  private attached = new Set<string>();

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      this.push({ type: "state", ...world.state });
      // Events are not part of the snapshot; the feed is what the Flags panel expands into.
      for (const event of [...world.events].sort((a, b) => a.ts - b.ts)) this.push({ type: "event", event });
    }, 0);
  }

  private push(m: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }

  private draw(sessionId: string): void {
    const size = this.sizes.get(sessionId);
    if (!size || !this.attached.has(sessionId)) return;
    this.push({ type: "pty:scrollback", sessionId, data: screen(sessionId, size.cols, size.rows) });
    const s = world.sessions.find((x) => x.id === sessionId);
    if (s?.status === "exited") this.push({ type: "pty:exit", sessionId, exitCode: s.exitCode ?? 0 });
  }

  send(raw: string): void {
    const m = JSON.parse(raw) as ClientMessage;
    switch (m.type) {
      case "attach":
        this.attached.add(m.sessionId);
        this.draw(m.sessionId);
        return;
      case "detach":
        this.attached.delete(m.sessionId);
        return;
      case "pty:resize": {
        const prev = this.sizes.get(m.sessionId);
        this.sizes.set(m.sessionId, { cols: m.cols, rows: m.rows });
        if (!prev || prev.cols !== m.cols || prev.rows !== m.rows || m.redraw) this.draw(m.sessionId);
        return;
      }
      case "repo:diff":
        this.push({ type: "repo:diff", sessionId: m.sessionId, repoPath: m.repoPath, diff: world.diffs[m.repoPath] ?? "", baseline: "a81d0f4" });
        return;
      case "flags:markRead":
        for (const f of world.flags) if (m.ids.includes(f.id)) f.read = true;
        return;
      case "state:request":
        this.push({ type: "state", ...world.state });
        return;
      default:
        return;
    }
  }

  close(): void {
    this.readyState = 3;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The REST surface the panels read. Anything unlisted 404s, which every caller already handles. */
function route(url: URL, method: string): Response {
  const q = url.searchParams;
  const p = url.pathname;
  if (method === "POST") {
    if (p === "/api/presence") return new Response(null, { status: 204 });
    if (p === "/api/playbook/manual") {
      return json({ entry: { id: "pm", sessionId: null, ts: Date.now(), trigger: "manual", kind: "entry", model: "claude-opus-5",
        text: "ANSWER: The rate limiter is on `feat/rate-limits` in atlas, two commits ahead and not pushed; its tests pass. Nothing else has touched that branch." } });
    }
    return json({ error: "read-only demo" }, 400);
  }
  switch (p) {
    case "/api/phone/me": return json({ required: false });
    case "/api/human": return json(world.human());
    case "/api/prs": return json({ repos: world.prs });
    case "/api/session/files": return json(world.sessionFiles[q.get("sessionId") ?? ""] ?? { sessionId: q.get("sessionId"), repos: [] });
    case "/api/repo/files": return json(world.fileIndex[q.get("repo") ?? ""] ?? []);
    case "/api/repo/changes": return json([]);
    case "/api/repo/log": return json({ commits: world.logs[q.get("repoPath") ?? ""] ?? [] });
    case "/api/repo/prs": return json(world.prs.find((r) => r.repo === q.get("repoPath")) ?? { repo: q.get("repoPath"), name: "", prs: [] });
    case "/api/repo/grep": return json({ hits: [], truncated: false });
    case "/api/repos": return json(world.repoPicker);
    case "/api/playbook/status": return json({ backend: "api", model: "claude-opus-5", lastRunAt: world.NOW - 2 * 60_000, running: 0 });
    case "/api/voice/status": return json({ ready: false, reason: "voice is off in this demo" });
    case "/api/history": return json(world.histories[q.get("sessionId") ?? ""] ?? { sessionId: q.get("sessionId"), turns: [], complete: true, reason: "no transcript in the demo" });
    case "/api/federation/status": return json(world.federation);
    case "/api/phone/status": return json(world.phone);
    case "/api/file": {
      const path = q.get("path") ?? "";
      const base = { path, repoPath: world.ATLAS, rel: path.slice(world.ATLAS.length + 1), truncated: false };
      if (path === `${world.ATLAS}/docs/bucket.svg`) {
        return json({ ...base, size: world.BUCKET_SVG.length, binary: true, image: "image/svg+xml", content: btoa(world.BUCKET_SVG) });
      }
      const content = world.peek[path];
      if (content === undefined) return json({ error: "not in the demo" }, 404);
      return json({ ...base, size: content.length, binary: false, content });
    }
    case "/api/file/diff": return json({ baseline: "a81d0f4", diff: "" });
    default: return json({ error: "not in the demo" }, 404);
  }
}

function installDemo(): void {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(window, name, { value: memoryStorage(), configurable: true });
  }
  const realFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
    return Promise.resolve(route(url, (init?.method ?? "GET").toUpperCase()));
  };
  window.WebSocket = DemoSocket as unknown as typeof WebSocket;
  document.title = "henry · demo";
}

if (demoEnabled()) installDemo();
