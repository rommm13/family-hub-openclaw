import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS households (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('parent','child','member'))
);
CREATE TABLE IF NOT EXISTS agent_bindings (
  runtime_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY(runtime_id, agent_id)
);
CREATE TABLE IF NOT EXISTS processed_actions (action_key TEXT PRIMARY KEY, processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`;

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), created_by TEXT NOT NULL REFERENCES members(id),
  title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')), comment TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS plan_participants (plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES members(id), PRIMARY KEY(plan_id,member_id));
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), created_by TEXT NOT NULL REFERENCES members(id), assignee_id TEXT REFERENCES members(id),
  title TEXT NOT NULL, due_at TEXT, all_day INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','cancelled')),
  reminder_policy TEXT NOT NULL DEFAULT 'daily_until_done', google_event_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), created_by TEXT NOT NULL REFERENCES members(id), title TEXT NOT NULL, body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'household' CHECK(visibility IN ('household','parents','selected','owner')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS note_acl (note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES members(id), PRIMARY KEY(note_id,member_id));
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(note_id UNINDEXED, title, body, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS wishes (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), owner_id TEXT NOT NULL REFERENCES members(id), title TEXT NOT NULL,
  target_price REAL, url TEXT, comment TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','removed')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wish_reservations (wish_id TEXT PRIMARY KEY REFERENCES wishes(id) ON DELETE CASCADE, reserved_by TEXT NOT NULL REFERENCES members(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), created_by TEXT NOT NULL REFERENCES members(id), name TEXT NOT NULL,
  maps_url TEXT, place_id TEXT, comment TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), created_by TEXT NOT NULL REFERENCES members(id), question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at TEXT
);
CREATE TABLE IF NOT EXISTS poll_options (id TEXT PRIMARY KEY, poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE, option_index INTEGER NOT NULL, label TEXT NOT NULL, UNIQUE(poll_id,option_index));
CREATE TABLE IF NOT EXISTS poll_participants (poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES members(id), voted_at TEXT, PRIMARY KEY(poll_id,member_id));
CREATE TABLE IF NOT EXISTS poll_votes (poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES members(id), option_id TEXT NOT NULL REFERENCES poll_options(id), voted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(poll_id,member_id));
CREATE TABLE IF NOT EXISTS capsules (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), author_id TEXT NOT NULL REFERENCES members(id), recipient_id TEXT NOT NULL REFERENCES members(id),
  unlock_at TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sealed' CHECK(status IN ('sealed','delivered','cancelled')), automation_job_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS money_goals (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), created_by TEXT NOT NULL REFERENCES members(id), assignee_id TEXT REFERENCES members(id),
  title TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>=0), currency TEXT NOT NULL DEFAULT 'RUB', due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','cancelled')), google_event_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS plan_links (plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY(plan_id,entity_type,entity_id));
CREATE TABLE IF NOT EXISTS calendar_links (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, google_event_id TEXT NOT NULL, calendar_id TEXT NOT NULL, sync_status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(entity_type,entity_id));
CREATE TABLE IF NOT EXISTS entity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, actor_id TEXT REFERENCES members(id), event_type TEXT NOT NULL,
  payload_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT NOT NULL UNIQUE, recipient_member_id TEXT NOT NULL REFERENCES members(id), kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')), attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_at TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS member_routes (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, account_id TEXT, target TEXT NOT NULL, thread_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE outbox ADD COLUMN lease_owner TEXT;
ALTER TABLE outbox ADD COLUMN lease_until TEXT;
CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox(status, available_at, lease_until);
`;

const SCHEMA_V4 = `
ALTER TABLE member_routes RENAME TO member_routes_v3;
CREATE TABLE member_routes (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  channel TEXT NOT NULL, account_id TEXT, target TEXT NOT NULL, thread_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(runtime_id,agent_id,member_id)
);
INSERT INTO member_routes(member_id,runtime_id,agent_id,channel,account_id,target,thread_id,updated_at)
SELECT r.member_id,b.runtime_id,b.agent_id,r.channel,r.account_id,r.target,r.thread_id,r.updated_at
FROM member_routes_v3 r JOIN agent_bindings b ON b.member_id=r.member_id;
DROP TABLE member_routes_v3;
CREATE INDEX IF NOT EXISTS member_routes_member_idx ON member_routes(member_id);
`;

const SCHEMA_V5 = `
ALTER TABLE member_routes ADD COLUMN keyboard_installed_at TEXT;
`;

const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS family_events (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  created_by TEXT NOT NULL REFERENCES members(id),
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  google_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS family_events_household_start_idx ON family_events(household_id,status,start_at);
`;

const SCHEMA_V7 = `
ALTER TABLE outbox ADD COLUMN dead_at TEXT;
CREATE INDEX IF NOT EXISTS outbox_dead_due_idx ON outbox(dead_at,status,available_at);
`;

const SCHEMA_V8 = `
ALTER TABLE notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
`;

const SCHEMA_V9 = `
CREATE TABLE IF NOT EXISTS shopping_items (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES members(id),
  name TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0,1)),
  checked_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS shopping_items_household_checked_idx ON shopping_items(household_id,checked,created_at);
`;

const SCHEMA_V10 = `
CREATE TABLE IF NOT EXISTS surprise_member_state (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  cycle INTEGER NOT NULL DEFAULT 1,
  manual_window_started_at TEXT,
  manual_count INTEGER NOT NULL DEFAULT 0,
  auto_next_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS surprise_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  asset_key TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual','auto')),
  shown_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS surprise_views_member_cycle_idx ON surprise_views(member_id,cycle,asset_key);
CREATE INDEX IF NOT EXISTS surprise_views_member_time_idx ON surprise_views(member_id,shown_at);
`;

const SCHEMA_V11 = `
CREATE TABLE IF NOT EXISTS surprise_assets (
  asset_key TEXT PRIMARY KEY,
  checksum TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS surprise_member_queue (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  asset_key TEXT NOT NULL REFERENCES surprise_assets(asset_key) ON DELETE CASCADE,
  queue_pos INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  last_source TEXT CHECK(last_source IN ('manual','auto') OR last_source IS NULL),
  PRIMARY KEY(member_id,asset_key)
);
CREATE INDEX IF NOT EXISTS surprise_member_queue_next_idx
  ON surprise_member_queue(member_id,seen_count,queue_pos);
CREATE INDEX IF NOT EXISTS surprise_assets_active_idx ON surprise_assets(active,asset_key);
`;

const SCHEMA_V12 = `
CREATE TABLE IF NOT EXISTS capsule_media (
  capsule_id TEXT PRIMARY KEY REFERENCES capsules(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  content_type TEXT,
  caption TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const SCHEMA_V13 = `
CREATE TABLE IF NOT EXISTS capsule_media_drafts (
  author_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL UNIQUE,
  recipient_id TEXT REFERENCES members(id),
  file_path TEXT NOT NULL,
  content_type TEXT,
  caption TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS capsule_media_drafts_expiry_idx ON capsule_media_drafts(expires_at);
`;


const SCHEMA_V14 = `
CREATE TABLE IF NOT EXISTS cashback_periods (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  year INTEGER NOT NULL CHECK(year BETWEEN 2000 AND 2100),
  month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(id),
  updated_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(household_id, year, month)
);
CREATE INDEX IF NOT EXISTS cashback_periods_household_period_idx
  ON cashback_periods(household_id, year DESC, month DESC);
`;

function migrate(db, version, sql) {
  const exists = db.prepare("SELECT 1 AS ok FROM schema_version WHERE version=?").get(version);
  if (exists) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(sql);
    db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(version);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openFamilyDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec(SCHEMA_V1);
  db.prepare("INSERT OR IGNORE INTO schema_version(version) VALUES (1)").run();
  migrate(db, 2, SCHEMA_V2);
  migrate(db, 3, SCHEMA_V3);
  migrate(db, 4, SCHEMA_V4);
  migrate(db, 5, SCHEMA_V5);
  migrate(db, 6, SCHEMA_V6);
  migrate(db, 7, SCHEMA_V7);
  migrate(db, 8, SCHEMA_V8);
  migrate(db, 9, SCHEMA_V9);
  migrate(db, 10, SCHEMA_V10);
  migrate(db, 11, SCHEMA_V11);
  migrate(db, 12, SCHEMA_V12);
  migrate(db, 13, SCHEMA_V13);
  migrate(db, 14, SCHEMA_V14);
  return db;
}

export function bootstrapFamily(db, { household, members, bindings }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO households(id,name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name").run(household.id, household.name);
    const memberStmt = db.prepare(`INSERT INTO members(id,household_id,name,role) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET household_id=excluded.household_id,name=excluded.name,role=excluded.role`);
    for (const member of members) memberStmt.run(member.id, household.id, member.name, member.role);
    const bindStmt = db.prepare(`INSERT INTO agent_bindings(runtime_id,agent_id,member_id) VALUES (?,?,?) ON CONFLICT(runtime_id,agent_id) DO UPDATE SET member_id=excluded.member_id`);
    for (const binding of bindings) bindStmt.run(binding.runtimeId, binding.agentId, binding.memberId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function resolveMemberForAgent(db, runtimeId, agentId) {
  const row = db.prepare(`SELECT m.id,m.name,m.role,m.household_id AS householdId FROM agent_bindings b JOIN members m ON m.id=b.member_id WHERE b.runtime_id=? AND b.agent_id=?`).get(runtimeId, agentId);
  return row ? { ...row } : null;
}

export function claimProcessedAction(db, actionKey) {
  const result = db.prepare("INSERT OR IGNORE INTO processed_actions(action_key) VALUES (?)").run(actionKey);
  return Number(result.changes) === 1;
}


export function upsertMemberRoute(db, memberId, { runtimeId, agentId, channel, accountId = null, to, threadId = null }) {
  if (!runtimeId || !agentId) throw new Error("member route requires runtimeId and agentId");
  db.prepare(`INSERT INTO member_routes(member_id,runtime_id,agent_id,channel,account_id,target,thread_id,updated_at)
    VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(runtime_id,agent_id,member_id) DO UPDATE SET
    keyboard_installed_at=CASE WHEN member_routes.channel=excluded.channel AND COALESCE(member_routes.account_id,'')=COALESCE(excluded.account_id,'') AND member_routes.target=excluded.target AND COALESCE(member_routes.thread_id,'')=COALESCE(excluded.thread_id,'') THEN member_routes.keyboard_installed_at ELSE NULL END,
    channel=excluded.channel,account_id=excluded.account_id,target=excluded.target,
    thread_id=excluded.thread_id,updated_at=CURRENT_TIMESTAMP`).run(memberId, runtimeId, agentId, channel, accountId, to, threadId);
}

export function getMemberRoute(db, memberId, { runtimeId, agentId }) {
  if (!runtimeId || !agentId) throw new Error("member route lookup requires runtimeId and agentId");
  const row = db.prepare(`SELECT channel,account_id AS accountId,target AS "to" FROM member_routes
    WHERE member_id=? AND runtime_id=? AND agent_id=?`).get(memberId, runtimeId, agentId);
  return row ? { ...row } : null;
}

export function getMemberKeyboardInstalledAt(db, memberId, { runtimeId, agentId }) {
  if (!runtimeId || !agentId) throw new Error("keyboard state lookup requires runtimeId and agentId");
  const row = db.prepare(`SELECT keyboard_installed_at AS installedAt FROM member_routes WHERE member_id=? AND runtime_id=? AND agent_id=?`).get(memberId, runtimeId, agentId);
  return row?.installedAt ?? null;
}

export function markMemberKeyboardInstalled(db, memberId, { runtimeId, agentId, installedAt = new Date().toISOString() }) {
  if (!runtimeId || !agentId) throw new Error("keyboard state update requires runtimeId and agentId");
  const result = db.prepare(`UPDATE member_routes SET keyboard_installed_at=? WHERE member_id=? AND runtime_id=? AND agent_id=?`).run(installedAt, memberId, runtimeId, agentId);
  return Number(result.changes) === 1;
}

export function enqueueOutbox(db, { dedupeKey, recipientMemberId, kind, payload, availableAt = null }) {
  if (availableAt) db.prepare(`INSERT OR IGNORE INTO outbox(dedupe_key,recipient_member_id,kind,payload_json,available_at) VALUES (?,?,?,?,?)`)
    .run(dedupeKey, recipientMemberId, kind, JSON.stringify(payload), availableAt);
  else db.prepare(`INSERT OR IGNORE INTO outbox(dedupe_key,recipient_member_id,kind,payload_json) VALUES (?,?,?,?)`)
    .run(dedupeKey, recipientMemberId, kind, JSON.stringify(payload));
  return db.prepare("SELECT id FROM outbox WHERE dedupe_key=?").get(dedupeKey).id;
}

export function claimDueOutbox(db, { workerId, runtimeId, agentId, now, leaseMs }) {
  if (!runtimeId || !agentId) throw new Error("outbox claim requires runtimeId and agentId");
  const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`SELECT o.id FROM outbox o
      JOIN agent_bindings b ON b.member_id=o.recipient_member_id
      WHERE b.runtime_id=? AND b.agent_id=? AND o.status IN ('pending','failed') AND o.dead_at IS NULL AND o.available_at<=?
      AND (o.lease_until IS NULL OR o.lease_until<=?) ORDER BY o.available_at,o.id LIMIT 1`).get(runtimeId, agentId, now, now);
    if (!row) { db.exec("COMMIT"); return null; }
    db.prepare(`UPDATE outbox SET lease_owner=?,lease_until=?,attempts=attempts+1 WHERE id=?`).run(workerId, leaseUntil, row.id);
    const claimed = db.prepare(`SELECT id,dedupe_key AS dedupeKey,recipient_member_id AS recipientMemberId,kind,payload_json AS payloadJson,available_at AS availableAt,attempts FROM outbox WHERE id=?`).get(row.id);
    db.exec("COMMIT");
    return { ...claimed, payload: JSON.parse(claimed.payloadJson) };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function markOutboxFailed(db, id, { workerId, error, retryAt, deadAt = null }) {
  const result = db.prepare(`UPDATE outbox SET status='failed',available_at=?,last_error=?,dead_at=?,lease_owner=NULL,lease_until=NULL
    WHERE id=? AND lease_owner=? AND status!='sent'`).run(retryAt, String(error), deadAt, id, workerId);
  return Number(result.changes) === 1;
}

export function markOutboxSent(db, id, { workerId, sentAt }) {
  const result = db.prepare(`UPDATE outbox SET status='sent',sent_at=?,last_error=NULL,lease_owner=NULL,lease_until=NULL
    WHERE id=? AND lease_owner=? AND status!='sent'`).run(sentAt, id, workerId);
  return Number(result.changes) === 1;
}

export function integrityCheck(db) {
  const row = db.prepare("PRAGMA integrity_check").get();
  return row?.integrity_check === "ok";
}
