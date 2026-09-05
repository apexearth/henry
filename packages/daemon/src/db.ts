// bun:sqlite at ~/.henry/henry.db. All tables for milestones 1-5 exist from day one;
// later milestones only add queries here.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Attention, Flag, HenryEvent, PlaybookEntry, Session, SessionUsage } from "@henry/shared";
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
-- Ordering and the retention sweep are both by ts alone, which (session_id, ts) cannot serve.
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);

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

-- A session asking for the human (mcp.ts henry_attention). Live rows have done IS NULL; the
-- rest stay as history until the retention sweep, which is why this is a table and not a Map.
CREATE TABLE IF NOT EXISTS attention (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  message TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  done TEXT,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS attention_session_ts ON attention(session_id, ts);

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

-- One row per minute you were at the keyboard; mask says how Henry knows (shared/human.ts
-- SRC). Nothing about what you were doing in it: the minute is the whole record.
CREATE TABLE IF NOT EXISTS presence (
  minute INTEGER PRIMARY KEY,
  mask INTEGER NOT NULL
);

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

for (const col of ["context_tokens", "context_window"]) {
  if (!(db.prepare("PRAGMA table_info(session_usage)").all() as { name: string }[]).some((c) => c.name === col)) {
    db.exec(`ALTER TABLE session_usage ADD COLUMN ${col} INTEGER`);
  }
}

// Milestone 5: playbook.kind ("entry" | "summary"); added as a migration so existing databases keep working.
if (!(db.prepare("PRAGMA table_info(playbook)").all() as { name: string }[]).some((c) => c.name === "kind")) {
  db.exec("ALTER TABLE playbook ADD COLUMN kind TEXT");
}
// sessions.host: which machine's daemon owns the session (groundwork for multi-machine).
// sessions.kind / claude_active: plain terminals next to Claude sessions.
{
  const cols = new Set((db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("host")) db.exec("ALTER TABLE sessions ADD COLUMN host TEXT");
  if (!cols.has("kind")) db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT");
  if (!cols.has("claude_active")) db.exec("ALTER TABLE sessions ADD COLUMN claude_active INTEGER");
  // Set when the user closes an exited session: it stays for its events but never returns to the rail.
  if (!cols.has("dismissed_at")) db.exec("ALTER TABLE sessions ADD COLUMN dismissed_at INTEGER");
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
  ended_at: number | null;
  parent_session_id: string | null;
  host: string | null;
  kind: Session["kind"] | null;
  claude_active: number | null;
}

function rowToSession(r: SessionRow): Session {
  const s: Session = { id: r.id, cwd: r.cwd, title: r.title, createdAt: r.created_at, status: r.status };
  if (r.claude_session_id) s.claudeSessionId = r.claude_session_id;
  if (r.command) s.command = r.command;
  if (r.pid != null) s.pid = r.pid;
  if (r.exit_code != null) s.exitCode = r.exit_code;
  if (r.ended_at != null) s.endedAt = r.ended_at;
  if (r.parent_session_id) s.parentSessionId = r.parent_session_id;
  if (r.host) s.host = r.host;
  if (r.kind) s.kind = r.kind;
  if (r.claude_active != null) s.claudeActive = r.claude_active === 1;
  return s;
}

const qInsertSession = db.prepare(`
  INSERT INTO sessions (id, claude_session_id, cwd, title, command, pid, created_at, status, exit_code, parent_session_id, host, kind, claude_active)
  VALUES ($id, $claudeSessionId, $cwd, $title, $command, $pid, $createdAt, $status, $exitCode, $parentSessionId, $host, $kind, $claudeActive)`);

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
    $kind: s.kind ?? null,
    $claudeActive: s.claudeActive === undefined ? null : s.claudeActive ? 1 : 0,
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
  endedAt: "ended_at",
  parentSessionId: "parent_session_id",
  host: "host",
  kind: "kind",
  claudeActive: "claude_active",
};

export function updateSession(id: string, patch: Partial<Session>): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { $id: id };
  for (const [k, v] of Object.entries(patch)) {
    const col = sessionColumns[k];
    if (!col) continue;
    sets.push(`${col} = $${k}`);
    params[`$${k}`] = typeof v === "boolean" ? (v ? 1 : 0) : v ?? null;
  }
  if (patch.status === "exited" && patch.endedAt === undefined) {
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

/** Sessions the user has not dismissed, newest first. */
export function listSessions(opts: { status?: Session["status"]; limit?: number } = {}): Session[] {
  const rows = (opts.status
    ? db.prepare("SELECT * FROM sessions WHERE dismissed_at IS NULL AND status = ? ORDER BY created_at DESC LIMIT ?").all(opts.status, opts.limit ?? 1000)
    : db.prepare("SELECT * FROM sessions WHERE dismissed_at IS NULL ORDER BY created_at DESC LIMIT ?").all(opts.limit ?? 1000)) as SessionRow[];
  return rows.map(rowToSession);
}

export function dismissSession(id: string): void {
  db.prepare("UPDATE sessions SET dismissed_at = ? WHERE id = ?").run(Date.now(), id);
}

export function isDismissed(id: string): boolean {
  const r = db.prepare("SELECT dismissed_at FROM sessions WHERE id = ?").get(id) as { dismissed_at: number | null } | null;
  return r?.dismissed_at != null;
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

/** Timestamps of one hook event for a session since `since`, ascending (engagement.ts restore). */
export function listHookTimes(sessionId: string, hookEvent: string, since: number): number[] {
  const rows = db
    .prepare("SELECT ts FROM events WHERE session_id = ? AND kind = 'hook' AND hook_event = ? AND ts >= ? ORDER BY ts ASC")
    .all(sessionId, hookEvent, since) as { ts: number }[];
  return rows.map((r) => r.ts);
}

/** Every prompt you sent since `since`, ascending: the whole basis of human.ts. */
export function listPromptTimes(since: number): { ts: number; sessionId: string }[] {
  const rows = db
    .prepare("SELECT ts, session_id FROM events WHERE kind = 'hook' AND hook_event = 'UserPromptSubmit' AND ts >= ? ORDER BY ts ASC")
    .all(since) as { ts: number; session_id: string }[];
  return rows.map((r) => ({ ts: r.ts, sessionId: r.session_id }));
}

/** Oldest event still in the log; how far back any history claim can honestly reach. */
export function oldestEventTs(): number | undefined {
  const row = db.prepare("SELECT MIN(ts) AS ts FROM events").get() as { ts: number | null } | undefined;
  return row?.ts ?? undefined;
}

// ---- presence: whole minutes you were here (human.ts) ----

const qMarkPresence = db.prepare("INSERT INTO presence (minute, mask) VALUES (?, ?) ON CONFLICT(minute) DO UPDATE SET mask = mask | excluded.mask");

export function markPresence(minutes: number[], mask: number): void {
  if (!minutes.length || !mask) return;
  db.transaction(() => {
    for (const m of minutes) qMarkPresence.run(m, mask);
  })();
}

export function listPresence(since: number): { minute: number; mask: number }[] {
  return db.prepare("SELECT minute, mask FROM presence WHERE minute >= ? ORDER BY minute ASC").all(since) as { minute: number; mask: number }[];
}

export function oldestPresenceMinute(): number | undefined {
  const row = db.prepare("SELECT MIN(minute) AS m FROM presence").get() as { m: number | null } | undefined;
  return row?.m ?? undefined;
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

// ---- attention ----

interface AttentionRow { id: string; session_id: string; ts: number; message: string; deadline: number; done: Attention["done"] | null; done_at: number | null }

function rowToAttention(r: AttentionRow): Attention {
  return { id: r.id, sessionId: r.session_id, ts: r.ts, message: r.message, deadline: r.deadline, done: r.done ?? undefined, doneAt: r.done_at ?? undefined };
}

export function upsertAttention(a: Attention): void {
  db.prepare(`INSERT INTO attention (id, session_id, ts, message, deadline, done, done_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET done = excluded.done, done_at = excluded.done_at, deadline = excluded.deadline`)
    .run(a.id, a.sessionId, a.ts, a.message, a.deadline, a.done ?? null, a.doneAt ?? null);
}

/** Live asks, oldest first: a daemon restart picks up where it left off. */
export function listOpenAttention(): Attention[] {
  return (db.prepare("SELECT * FROM attention WHERE done IS NULL ORDER BY ts ASC").all() as AttentionRow[]).map(rowToAttention);
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

/**
 * Baselines of the sessions still worth watching: the rail's restore set (not dismissed, and
 * either alive or young enough to come back exited). git.start() rebuilds its in-memory
 * session→repo map from these, so a daemon restart does not zero "repos touched"; every
 * older session is left out rather than attaching watchers to repos nobody is in.
 */
export function listLiveBaselines(): RepoBaseline[] {
  const rows = db
    .prepare(`SELECT b.* FROM repo_baselines b JOIN sessions s ON s.id = b.session_id
              WHERE s.dismissed_at IS NULL AND (s.status != 'exited' OR s.created_at >= ?)
              ORDER BY b.first_seen`)
    .all(Date.now() - SESSION_RESTORE_WINDOW_MS) as { session_id: string; repo_path: string; baseline_sha: string; first_seen: number }[];
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
  db.prepare(`INSERT INTO session_usage (session_id, input_tokens, output_tokens, cache_read, cache_write, cost_usd, model, context_tokens, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      cache_read = excluded.cache_read, cache_write = excluded.cache_write, cost_usd = excluded.cost_usd, model = excluded.model,
      context_tokens = excluded.context_tokens, context_window = excluded.context_window`)
    .run(sessionId, u.inputTokens, u.outputTokens, u.cacheRead, u.cacheWrite, u.costUsd, u.model ?? null, u.contextTokens ?? null, u.contextWindow ?? null);
}

// ---- retention ----

export interface PruneCounts {
  events: number;
  flags: number;
  playbook: number;
  snapshots: number;
  presence: number;
  attention: number;
}

/**
 * Drop history older than `days` (0 keeps everything). Sessions are never swept: the rail owns
 * their lifetime, and an old session with no events still costs one row. Deleted pages go on
 * the freelist and get reused; the file only shrinks when a quarter of it is free, which the
 * caller pays for at most once per sweep.
 */
export function pruneHistory(days: number): PruneCounts | undefined {
  if (!Number.isFinite(days) || days <= 0) return undefined;
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  const del = (table: string) => db.prepare(`DELETE FROM ${table} WHERE ts < ?`).run(cutoff).changes;
  const counts = db.transaction((): PruneCounts => ({
    events: del("events"),
    flags: del("flags"),
    playbook: del("playbook"),
    // A live ask outlives the window by its deadline, never by its age.
    attention: db.prepare("DELETE FROM attention WHERE ts < ? AND done IS NOT NULL").run(cutoff).changes,
    // The newest snapshot is the live 5h/7d usage; keep it however old it is.
    snapshots: db.prepare("DELETE FROM usage_snapshots WHERE ts < ? AND ts <> (SELECT MAX(ts) FROM usage_snapshots)").run(cutoff).changes,
    presence: db.prepare("DELETE FROM presence WHERE minute < ?").run(cutoff).changes,
  }))();
  const total = counts.events + counts.flags + counts.playbook + counts.snapshots + counts.presence + counts.attention;
  if (total) {
    try {
      const free = (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
      const pages = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
      if (pages > 0 && free / pages > 0.25) db.exec("VACUUM");
    } catch (e) {
      console.error("[db] vacuum failed:", e);
    }
  }
  return counts;
}

export function listSessionUsage(): Record<string, SessionUsage> {
  const rows = db.prepare("SELECT * FROM session_usage").all() as
    { session_id: string; input_tokens: number; output_tokens: number; cache_read: number; cache_write: number; cost_usd: number; model: string | null; context_tokens: number | null; context_window: number | null }[];
  const out: Record<string, SessionUsage> = {};
  for (const r of rows) {
    out[r.session_id] = { inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheRead: r.cache_read, cacheWrite: r.cache_write, costUsd: r.cost_usd, model: r.model ?? undefined };
    if (r.context_tokens != null) out[r.session_id].contextTokens = r.context_tokens;
    if (r.context_window != null) out[r.session_id].contextWindow = r.context_window;
  }
  return out;
}
