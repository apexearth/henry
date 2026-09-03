// bun:sqlite at ~/.henry/henry.db. All tables for milestones 1-5 exist from day one;
// later milestones only add queries here.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Flag, HenryEvent, PlaybookEntry, Session, SessionUsage } from "@henry/shared";
import { henryDir } from "./config";

export const dbPath = join(henryDir, "henry.db");
export const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  claude_session_id TEXT,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  command TEXT,
  pid INTEGER,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  parent_session_id TEXT,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_claude ON sessions(claude_session_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  claude_session_id TEXT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  hook_event TEXT,
  tool_name TEXT,
  cwd TEXT,
  repo TEXT,
  payload TEXT NOT NULL,
  severity TEXT NOT NULL,
  rule TEXT,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session_ts ON events(session_id, ts);

CREATE TABLE IF NOT EXISTS flags (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  severity TEXT NOT NULL,
  rule TEXT NOT NULL,
  summary TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS flags_session_ts ON flags(session_id, ts);

CREATE TABLE IF NOT EXISTS playbook (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  trigger TEXT NOT NULL,
  model TEXT
);
CREATE INDEX IF NOT EXISTS playbook_session_ts ON playbook(session_id, ts);

CREATE TABLE IF NOT EXISTS repo_baselines (
  session_id TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  baseline_sha TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (session_id, repo_path)
);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  ts INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_snapshots_ts ON usage_snapshots(ts);

CREATE TABLE IF NOT EXISTS session_usage (
  session_id TEXT PRIMARY KEY,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  model TEXT
);
`);

// Milestone 5: playbook.kind ("entry" | "summary"); added as a migration so existing databases keep working.
if (!(db.prepare("PRAGMA table_info(playbook)").all() as { name: string }[]).some((c) => c.name === "kind")) {
  db.exec("ALTER TABLE playbook ADD COLUMN kind TEXT");
}
// sessions.host: which machine's daemon owns the session (groundwork for multi-machine).
if (!(db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).some((c) => c.name === "host")) {
  db.exec("ALTER TABLE sessions ADD COLUMN host TEXT");
}

// ---- sessions ----

interface SessionRow {
  id: string;
  claude_session_id: string | null;
  cwd: string;
  title: string;
  command: string | null;
  pid: number | null;
  created_at: number;
  status: Session["status"];
  exit_code: number | null;
  parent_session_id: string | null;
  host: string | null;
}

function rowToSession(r: SessionRow): Session {
  const s: Session = { id: r.id, cwd: r.cwd, title: r.title, createdAt: r.created_at, status: r.status };
  if (r.claude_session_id) s.claudeSessionId = r.claude_session_id;
  if (r.command) s.command = r.command;
  if (r.pid != null) s.pid = r.pid;
  if (r.exit_code != null) s.exitCode = r.exit_code;
  if (r.parent_session_id) s.parentSessionId = r.parent_session_id;
  if (r.host) s.host = r.host;
  return s;
}

const qInsertSession = db.prepare(`
  INSERT INTO sessions (id, claude_session_id, cwd, title, command, pid, created_at, status, exit_code, parent_session_id, host)
  VALUES ($id, $claudeSessionId, $cwd, $title, $command, $pid, $createdAt, $status, $exitCode, $parentSessionId, $host)`);

export function insertSession(s: Session): void {
  qInsertSession.run({
    $id: s.id,
    $claudeSessionId: s.claudeSessionId ?? null,
    $cwd: s.cwd,
    $title: s.title,
    $command: s.command ?? null,
    $pid: s.pid ?? null,
    $createdAt: s.createdAt,
    $status: s.status,
    $exitCode: s.exitCode ?? null,
    $parentSessionId: s.parentSessionId ?? null,
    $host: s.host ?? null,
  });
}

const sessionColumns: Record<string, string> = {
  claudeSessionId: "claude_session_id",
  cwd: "cwd",
  title: "title",
  command: "command",
  pid: "pid",
  status: "status",
  exitCode: "exit_code",
  parentSessionId: "parent_session_id",
  host: "host",
};

export function updateSession(id: string, patch: Partial<Session>): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { $id: id };
  for (const [k, v] of Object.entries(patch)) {
    const col = sessionColumns[k];
    if (!col) continue;
    sets.push(`${col} = $${k}`);
    params[`$${k}`] = v ?? null;
  }
  if (patch.status === "exited") {
    sets.push("ended_at = $endedAt");
    params.$endedAt = Date.now();
  }
  if (!sets.length) return;
  db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = $id`).run(params as any);
}

export function getSession(id: string): Session | undefined {
  const r = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
  return r ? rowToSession(r) : undefined;
}

export function getSessionByClaudeId(claudeSessionId: string): Session | undefined {
  const r = db.prepare("SELECT * FROM sessions WHERE claude_session_id = ? ORDER BY created_at DESC").get(claudeSessionId) as SessionRow | null;
  return r ? rowToSession(r) : undefined;
}

export function listSessions(opts: { status?: Session["status"]; limit?: number } = {}): Session[] {
  const rows = (opts.status
    ? db.prepare("SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(opts.status, opts.limit ?? 1000)
    : db.prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?").all(opts.limit ?? 1000)) as SessionRow[];
  return rows.map(rowToSession);
}

/** Sessions younger than this stay visible in the rail across a daemon restart. */
export const SESSION_RESTORE_WINDOW_MS = 24 * 60 * 60_000;


// ---- events ----

interface EventRow {
  id: string; session_id: string; claude_session_id: string | null; ts: number; kind: HenryEvent["kind"];
  hook_event: string | null; tool_name: string | null; cwd: string | null; repo: string | null; payload: string;
  severity: HenryEvent["severity"]; rule: string | null; summary: string;
}

function rowToEvent(r: EventRow): HenryEvent {
  return {
    id: r.id, sessionId: r.session_id, claudeSessionId: r.claude_session_id ?? undefined, ts: r.ts, kind: r.kind,
    hookEvent: r.hook_event ?? undefined, toolName: r.tool_name ?? undefined, cwd: r.cwd ?? undefined, repo: r.repo ?? undefined,
    payload: JSON.parse(r.payload), severity: r.severity, rule: r.rule ?? undefined, summary: r.summary,
  };
}

const qInsertEvent = db.prepare(`
  INSERT INTO events (id, session_id, claude_session_id, ts, kind, hook_event, tool_name, cwd, repo, payload, severity, rule, summary)
  VALUES ($id, $sessionId, $claudeSessionId, $ts, $kind, $hookEvent, $toolName, $cwd, $repo, $payload, $severity, $rule, $summary)`);

export function insertEvent(e: HenryEvent): void {
  qInsertEvent.run({
    $id: e.id, $sessionId: e.sessionId, $claudeSessionId: e.claudeSessionId ?? null, $ts: e.ts, $kind: e.kind,
    $hookEvent: e.hookEvent ?? null, $toolName: e.toolName ?? null, $cwd: e.cwd ?? null, $repo: e.repo ?? null,
    $payload: JSON.stringify(e.payload ?? null), $severity: e.severity, $rule: e.rule ?? null, $summary: e.summary,
  });
}

export function listEvents(opts: { sessionId?: string; limit?: number } = {}): HenryEvent[] {
  const limit = opts.limit ?? 500;
  const rows = (opts.sessionId
    ? db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY ts DESC LIMIT ?").all(opts.sessionId, limit)
    : db.prepare("SELECT * FROM events ORDER BY ts DESC LIMIT ?").all(limit)) as EventRow[];
  return rows.map(rowToEvent);
}

// ---- flags ----

interface FlagRow { id: string; event_id: string; session_id: string; ts: number; severity: Flag["severity"]; rule: string; summary: string; read: number }

function rowToFlag(r: FlagRow): Flag {
  return { id: r.id, eventId: r.event_id, sessionId: r.session_id, ts: r.ts, severity: r.severity, rule: r.rule, summary: r.summary, read: !!r.read };
}

export function insertFlag(f: Flag): void {
  db.prepare("INSERT INTO flags (id, event_id, session_id, ts, severity, rule, summary, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(f.id, f.eventId, f.sessionId, f.ts, f.severity, f.rule, f.summary, f.read ? 1 : 0);
}

export function listFlags(opts: { sessionId?: string; unreadOnly?: boolean; limit?: number } = {}): Flag[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.sessionId) { where.push("session_id = ?"); params.push(opts.sessionId); }
  if (opts.unreadOnly) where.push("read = 0");
  const sql = `SELECT * FROM flags ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT ?`;
  return (db.prepare(sql).all(...params, opts.limit ?? 500) as FlagRow[]).map(rowToFlag);
}

export function markFlagsRead(ids: string[]): void {
  if (!ids.length) return;
  const q = db.prepare("UPDATE flags SET read = 1 WHERE id = ?");
  db.transaction(() => { for (const id of ids) q.run(id); })();
}

// ---- playbook ----

interface PlaybookRow { id: string; session_id: string | null; ts: number; text: string; trigger: PlaybookEntry["trigger"]; model: string | null; kind: PlaybookEntry["kind"] | null }

function rowToPlaybook(r: PlaybookRow): PlaybookEntry {
  return { id: r.id, sessionId: r.session_id, ts: r.ts, text: r.text, trigger: r.trigger, model: r.model ?? undefined, kind: r.kind ?? undefined };
}

export function insertPlaybook(p: PlaybookEntry): void {
  db.prepare("INSERT INTO playbook (id, session_id, ts, text, trigger, model, kind) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(p.id, p.sessionId, p.ts, p.text, p.trigger, p.model ?? null, p.kind ?? null);
}

/** sessionId: string = that session; null = global entries only; undefined = everything. */
export function listPlaybook(sessionId?: string | null, limit = 200): PlaybookEntry[] {
  const rows = (sessionId === undefined
    ? db.prepare("SELECT * FROM playbook ORDER BY ts DESC LIMIT ?").all(limit)
    : sessionId === null
      ? db.prepare("SELECT * FROM playbook WHERE session_id IS NULL ORDER BY ts DESC LIMIT ?").all(limit)
      : db.prepare("SELECT * FROM playbook WHERE session_id = ? ORDER BY ts DESC LIMIT ?").all(sessionId, limit)) as PlaybookRow[];
  return rows.map(rowToPlaybook);
}

// ---- repo baselines ----

export interface RepoBaseline { sessionId: string; repoPath: string; baselineSha: string; firstSeen: number }

export function upsertBaseline(b: RepoBaseline): void {
  db.prepare("INSERT OR IGNORE INTO repo_baselines (session_id, repo_path, baseline_sha, first_seen) VALUES (?, ?, ?, ?)")
    .run(b.sessionId, b.repoPath, b.baselineSha, b.firstSeen);
}

export function getBaseline(sessionId: string, repoPath: string): RepoBaseline | undefined {
  const r = db.prepare("SELECT * FROM repo_baselines WHERE session_id = ? AND repo_path = ?").get(sessionId, repoPath) as
    | { session_id: string; repo_path: string; baseline_sha: string; first_seen: number } | null;
  return r ? { sessionId: r.session_id, repoPath: r.repo_path, baselineSha: r.baseline_sha, firstSeen: r.first_seen } : undefined;
}

export function listBaselines(sessionId: string): RepoBaseline[] {
  const rows = db.prepare("SELECT * FROM repo_baselines WHERE session_id = ? ORDER BY first_seen").all(sessionId) as
    { session_id: string; repo_path: string; baseline_sha: string; first_seen: number }[];
  return rows.map((r) => ({ sessionId: r.session_id, repoPath: r.repo_path, baselineSha: r.baseline_sha, firstSeen: r.first_seen }));
}

// ---- usage ----

export function insertUsageSnapshot(json: unknown, ts = Date.now()): void {
  db.prepare("INSERT INTO usage_snapshots (ts, json) VALUES (?, ?)").run(ts, JSON.stringify(json));
}

export function latestUsageSnapshot<T = unknown>(): { ts: number; json: T } | undefined {
  const r = db.prepare("SELECT ts, json FROM usage_snapshots ORDER BY ts DESC LIMIT 1").get() as { ts: number; json: string } | null;
  return r ? { ts: r.ts, json: JSON.parse(r.json) as T } : undefined;
}

export function upsertSessionUsage(sessionId: string, u: SessionUsage): void {
  db.prepare(`INSERT INTO session_usage (session_id, input_tokens, output_tokens, cache_read, cache_write, cost_usd, model)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      cache_read = excluded.cache_read, cache_write = excluded.cache_write, cost_usd = excluded.cost_usd, model = excluded.model`)
    .run(sessionId, u.inputTokens, u.outputTokens, u.cacheRead, u.cacheWrite, u.costUsd, u.model ?? null);
}

export function listSessionUsage(): Record<string, SessionUsage> {
  const rows = db.prepare("SELECT * FROM session_usage").all() as
    { session_id: string; input_tokens: number; output_tokens: number; cache_read: number; cache_write: number; cost_usd: number; model: string | null }[];
  const out: Record<string, SessionUsage> = {};
  for (const r of rows) {
    out[r.session_id] = { inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheRead: r.cache_read, cacheWrite: r.cache_write, costUsd: r.cost_usd, model: r.model ?? undefined };
  }
  return out;
}
