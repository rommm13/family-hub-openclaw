import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openFamilyDb, bootstrapFamily, upsertMemberRoute, getMemberRoute,
  enqueueOutbox, claimDueOutbox
} from "../dist/db.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-routing-"));
  const file = path.join(dir, "family.sqlite");
  const db = openFamilyDb(file);
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [
      { id: "participant_alpha", name: "Иван", role: "parent" },
      { id: "participant_beta", name: "Мария", role: "parent" }
    ],
    bindings: [
      { runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" },
      { runtimeId: "agent_second", agentId: "main", memberId: "participant_beta" }
    ]
  });
  return { dir, file, db };
}
test("member routes are scoped to the bound runtime and agent", () => {
  const fx = fixture();
  try {
    upsertMemberRoute(fx.db, "participant_alpha", {
      runtimeId: "agent_core", agentId: "main", channel: "telegram", accountId: "default", to: "telegram:111"
    });
    upsertMemberRoute(fx.db, "participant_beta", {
      runtimeId: "agent_second", agentId: "main", channel: "telegram", accountId: "default", to: "telegram:222"
    });
    assert.equal(getMemberRoute(fx.db, "participant_alpha", { runtimeId: "agent_second", agentId: "main" }), null);
    assert.equal(getMemberRoute(fx.db, "participant_beta", { runtimeId: "agent_core", agentId: "main" }), null);
    assert.equal(getMemberRoute(fx.db, "participant_alpha", { runtimeId: "agent_core", agentId: "main" }).to, "telegram:111");
    assert.equal(getMemberRoute(fx.db, "participant_beta", { runtimeId: "agent_second", agentId: "main" }).to, "telegram:222");
  } finally { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});
test("outbox leases only work addressed to the current runtime member", () => {
  const fx = fixture();
  try {
    const participant_alphaId = enqueueOutbox(fx.db, {
      dedupeKey: "msg:participant_alpha", recipientMemberId: "participant_alpha", kind: "text", payload: { text: "Ивану" }, availableAt: "2000-01-01T00:00:00Z"
    });
    const svetaId = enqueueOutbox(fx.db, {
      dedupeKey: "msg:sveta", recipientMemberId: "participant_beta", kind: "text", payload: { text: "Марии" }, availableAt: "2000-01-01T00:00:00Z"
    });
    const agent_core = claimDueOutbox(fx.db, {
      workerId: "agent_core-worker", runtimeId: "agent_core", agentId: "main", now: "2026-09-16T12:00:00Z", leaseMs: 60000
    });
    const agent_second = claimDueOutbox(fx.db, {
      workerId: "agent_second-worker", runtimeId: "agent_second", agentId: "main", now: "2026-09-16T12:00:00Z", leaseMs: 60000
    });
    assert.equal(agent_core.id, participant_alphaId);
    assert.equal(agent_second.id, svetaId);
  } finally { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});
test("Agent Alpha cannot lease a Maria-only outbox item", () => {
  const fx = fixture();
  try {
    const svetaId = enqueueOutbox(fx.db, {
      dedupeKey: "msg:sveta-only", recipientMemberId: "participant_beta", kind: "text",
      payload: { text: "Марии" }, availableAt: "2000-01-01T00:00:00Z"
    });
    const agent_core = claimDueOutbox(fx.db, {
      workerId: "agent_core-worker", runtimeId: "agent_core", agentId: "main",
      now: "2026-09-16T12:00:00Z", leaseMs: 60000
    });
    assert.equal(agent_core, null);
    const agent_second = claimDueOutbox(fx.db, {
      workerId: "agent_second-worker", runtimeId: "agent_second", agentId: "main",
      now: "2026-09-16T12:00:00Z", leaseMs: 60000
    });
    assert.equal(agent_second.id, svetaId);
  } finally { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test("v4 migration backfills legacy route from agent_bindings, not a hardcoded runtime", async () => {
  const fx = fixture();
  let migrated = null;
  try {
    fx.db.exec(`DELETE FROM schema_version WHERE version>=4;
      DROP INDEX IF EXISTS outbox_dead_due_idx;
      ALTER TABLE outbox DROP COLUMN dead_at;
      ALTER TABLE notes DROP COLUMN revision;
      DROP TABLE IF EXISTS surprise_member_queue;
      DROP TABLE IF EXISTS surprise_assets;
      DROP TABLE IF EXISTS surprise_views;
      DROP TABLE IF EXISTS surprise_member_state;
      DROP TABLE IF EXISTS shopping_items;
      DROP TABLE member_routes;
      CREATE TABLE member_routes (
        member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        channel TEXT NOT NULL, account_id TEXT, target TEXT NOT NULL, thread_id TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO member_routes(member_id,channel,account_id,target) VALUES ('participant_beta','telegram','default','telegram:222');
      DELETE FROM agent_bindings;
      INSERT INTO agent_bindings(runtime_id,agent_id,member_id) VALUES ('agent_second','main','participant_beta');`);
    fx.db.close();
    const { openFamilyDb } = await import("../dist/db.js");
    migrated = openFamilyDb(fx.file);
    assert.equal(getMemberRoute(migrated, "participant_beta", { runtimeId: "agent_second", agentId: "main" }).to, "telegram:222");
    assert.equal(getMemberRoute(migrated, "participant_beta", { runtimeId: "agent_core", agentId: "main" }), null);
  } finally { try { migrated?.close(); } catch {} try { fx.db.close(); } catch {} fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test("one Family runtime accepts both bound Telegram agents without mixing identity", async () => {
  const fx = fixture();
  try {
    fx.db.prepare("INSERT INTO agent_bindings(runtime_id,agent_id,member_id) VALUES (?,?,?) ON CONFLICT(runtime_id,agent_id) DO UPDATE SET member_id=excluded.member_id").run("agent_core","agent_second","participant_beta");
    const { createFamilyRuntime } = await import("../dist/index.js");
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const agent_second = await runtime.beforeDispatch(
      { content: "🫶 Семья", channel: "telegram" },
      { sessionKey: "agent:agent_second:telegram:direct:222", conversationId: "222", accountId: "agent_second" }
    );
    assert.equal(agent_second.handled, true);
    assert.match(agent_second.text, /Семья/);
    const route = getMemberRoute(fx.db, "participant_beta", { runtimeId: "agent_core", agentId: "agent_second" });
    assert.equal(route.to, "telegram:222");
    assert.equal(route.accountId, "agent_second");
  } finally { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});
