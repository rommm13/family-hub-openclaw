import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as dbApi from "../dist/db.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-outbox-"));
  const file = path.join(dir, "family.sqlite");
  const db = dbApi.openFamilyDb(file);
  dbApi.bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [{ id: "participant_alpha", name: "Иван", role: "parent" }],
    bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }]
  });
  return { dir, file, db };
}
function cleanup(fx) {
  fx.db.close();
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

test("migration v4 stores runtime-scoped trusted member routes", () => {
  const fx = fixture();
  try {
    assert.deepEqual(
      fx.db.prepare("select version from schema_version order by version").all().map(r => r.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
    );
    dbApi.upsertMemberRoute(fx.db, "participant_alpha", {
      runtimeId: "agent_core", agentId: "main", channel: "telegram", accountId: "default", to: "telegram:100000001"
    });
    assert.deepEqual(dbApi.getMemberRoute(fx.db, "participant_alpha", { runtimeId: "agent_core", agentId: "main" }), {
      channel: "telegram", accountId: "default", to: "telegram:100000001"
    });
    dbApi.upsertMemberRoute(fx.db, "participant_alpha", {
      runtimeId: "agent_core", agentId: "main", channel: "telegram", accountId: "family", to: "telegram:999"
    });
    assert.deepEqual(dbApi.getMemberRoute(fx.db, "participant_alpha", { runtimeId: "agent_core", agentId: "main" }), {
      channel: "telegram", accountId: "family", to: "telegram:999"
    });
  } finally { cleanup(fx); }
});

test("outbox dedupes enqueue and leases one due row to one worker", () => {
  const fx = fixture();
  const peer = dbApi.openFamilyDb(fx.file);
  try {
    const first = dbApi.enqueueOutbox(fx.db, {
      dedupeKey: "action:a1:created", recipientMemberId: "participant_alpha",
      kind: "action_created", payload: { actionId: "a1" }, availableAt: "2026-09-16T12:00:00.000Z"
    });
    const duplicate = dbApi.enqueueOutbox(fx.db, {
      dedupeKey: "action:a1:created", recipientMemberId: "participant_alpha",
      kind: "action_created", payload: { actionId: "a1" }, availableAt: "2026-09-16T12:00:00.000Z"
    });
    assert.equal(duplicate, first);

    const now = "2026-09-16T12:00:00.000Z";
    const a = dbApi.claimDueOutbox(fx.db, { workerId: "agent_core", runtimeId: "agent_core", agentId: "main", now, leaseMs: 60000 });
    const b = dbApi.claimDueOutbox(peer, { workerId: "agent_second", runtimeId: "agent_core", agentId: "main", now, leaseMs: 60000 });
    assert.equal(a.id, first);
    assert.equal(a.attempts, 1);
    assert.equal(b, null);
  } finally {
    peer.close();
    cleanup(fx);
  }
});

test("failed delivery is retried after backoff and sent rows stay terminal", () => {
  const fx = fixture();
  try {
    const id = dbApi.enqueueOutbox(fx.db, {
      dedupeKey: "action:a2:reminder", recipientMemberId: "participant_alpha",
      kind: "action_reminder", payload: { actionId: "a2" }, availableAt: "2026-09-16T12:00:00.000Z"
    });
    const t0 = "2026-09-16T12:00:00.000Z";
    const first = dbApi.claimDueOutbox(fx.db, { workerId: "agent_core", runtimeId: "agent_core", agentId: "main", now: t0, leaseMs: 60000 });
    assert.equal(first.id, id);
    dbApi.markOutboxFailed(fx.db, id, {
      workerId: "agent_core", error: "telegram unavailable",
      retryAt: "2026-09-16T12:05:00.000Z"
    });
    assert.equal(dbApi.claimDueOutbox(fx.db, {
      workerId: "agent_core", runtimeId: "agent_core", agentId: "main", now: "2026-09-16T12:04:59.000Z", leaseMs: 60000
    }), null);
    const retry = dbApi.claimDueOutbox(fx.db, {
      workerId: "agent_core", runtimeId: "agent_core", agentId: "main", now: "2026-09-16T12:05:00.000Z", leaseMs: 60000
    });
    assert.equal(retry.attempts, 2);
    dbApi.markOutboxSent(fx.db, id, { workerId: "agent_core", sentAt: "2026-09-16T12:05:01.000Z" });
    assert.equal(dbApi.claimDueOutbox(fx.db, {
      workerId: "agent_core", runtimeId: "agent_core", agentId: "main", now: "2026-09-17T12:00:00.000Z", leaseMs: 60000
    }), null);
  } finally { cleanup(fx); }
});

test("worker sends through stored route and marks successful delivery", async () => {
  const fx = fixture();
  try {
    dbApi.upsertMemberRoute(fx.db, "participant_alpha", {
      runtimeId: "agent_core", agentId: "main", channel: "telegram", accountId: "default", to: "telegram:123"
    });
    const id = dbApi.enqueueOutbox(fx.db, {
      dedupeKey: "msg:1", recipientMemberId: "participant_alpha", kind: "text",
      payload: { text: "Купить корм" }, availableAt: "2026-09-16T11:59:00.000Z"
    });
    const indexApi = await import("../dist/index.js");
    const sent = [];
    const result = await indexApi.processOutboxOnce({
      db: fx.db, workerId: "agent_core", runtimeId: "agent_core", agentId: "main", now: "2026-09-16T12:00:00.000Z",
      leaseMs: 60000, retryDelayMs: 300000,
      send: async (route, text) => sent.push({ route, text })
    });
    assert.equal(result.status, "sent");
    assert.equal(result.id, id);
    assert.deepEqual(sent, [{
      route: { channel: "telegram", accountId: "default", to: "telegram:123" },
      text: "Купить корм"
    }]);
  } finally { cleanup(fx); }
});

test("configured plugin registers one lightweight outbox service", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-service-"));
  const dbPath = path.join(dir, "family.sqlite");
  let service = null;
  let gatewayStop = null;
  let httpRoute = null;
  const indexApi = await import("../dist/index.js");
  const api = {
    pluginConfig: { dbPath, runtimeId: "agent_core", agentId: "main" },
    runtime: { channel: { outbound: { loadAdapter: async () => undefined } } },
    registerCommand() {}, registerInteractiveHandler() {}, registerTool() {},
    registerHttpRoute(value) { httpRoute = value; },
    registerService(value) { service = value; },
    on(name, handler) { if (name === "gateway_stop") gatewayStop = handler; }
  };
  try {
    indexApi.registerConfiguredFamilyHub(api);
    assert.equal(service?.id, "family-hub-outbox");
    assert.equal(typeof service?.start, "function");
    assert.equal(typeof service?.stop, "function");
    assert.equal(httpRoute?.path, "/family-app");
    assert.equal(httpRoute?.auth, "plugin");
    assert.equal(typeof httpRoute?.handler, "function");
  } finally {
    if (gatewayStop) await gatewayStop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("outbox service drains backlog through OpenClaw outbound adapter on start", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-service-send-"));
  const dbPath = path.join(dir, "family.sqlite");
  let service = null;
  let gatewayStop = null;
  const sent = [];
  const indexApi = await import("../dist/index.js");
  const api = {
    pluginConfig: { dbPath, runtimeId: "agent_core", agentId: "main" },
    runtime: { channel: { outbound: { loadAdapter: async (channel) => {
      assert.equal(channel, "telegram");
      return { sendText: async (ctx) => { sent.push(ctx); return { messageId: "1" }; } };
    } } } },
    registerCommand() {}, registerInteractiveHandler() {}, registerTool() {},
    registerHttpRoute() {},
    registerService(value) { service = value; },
    on(name, handler) { if (name === "gateway_stop") gatewayStop = handler; }
  };
  try {
    indexApi.registerConfiguredFamilyHub(api);
    const peer = dbApi.openFamilyDb(dbPath);
    dbApi.bootstrapFamily(peer, {
      household: { id: "home", name: "Семья" },
      members: [{ id: "participant_alpha", name: "Иван", role: "parent" }],
      bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }]
    });
    dbApi.upsertMemberRoute(peer, "participant_alpha", {
      runtimeId: "agent_core", agentId: "main", channel: "telegram", accountId: "default", to: "telegram:123"
    });
    const id = dbApi.enqueueOutbox(peer, {
      dedupeKey: "service:1", recipientMemberId: "participant_alpha", kind: "text",
      payload: { text: "Сервисное сообщение" }, availableAt: "2000-01-01T00:00:00.000Z"
    });
    peer.close();
    const cfg = { marker: "gateway-config" };
    await service.start({ config: cfg, logger: { warn() {}, error() {}, info() {}, debug() {} } });
    await service.stop({ config: cfg, logger: { warn() {}, error() {}, info() {}, debug() {} } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].cfg, cfg);
    assert.equal(sent[0].to, "telegram:123");
    assert.equal(sent[0].accountId, "default");
    assert.equal(sent[0].text, "Сервисное сообщение");
    const verify = dbApi.openFamilyDb(dbPath);
    assert.equal(verify.prepare("select status from outbox where id=?").get(id).status, "sent");
    verify.close();
  } finally {
    if (service?.stop) await service.stop({ config: {}, logger: { warn() {}, error() {}, info() {}, debug() {} } });
    if (gatewayStop) await gatewayStop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("worker dispatches typed calendar work without Telegram route", async () => {
  const fx = fixture();
  try {
    const id = dbApi.enqueueOutbox(fx.db, {
      dedupeKey: "calendar:action:a1:upsert", recipientMemberId: "participant_alpha",
      kind: "calendar_action_upsert",
      payload: { entityType: "action", entityId: "a1", summary: "Купить корм", dueAt: "2026-09-18" },
      availableAt: "2026-09-16T11:59:00.000Z"
    });
    const indexApi = await import("../dist/index.js");
    const handled = [];
    const result = await indexApi.processOutboxOnce({
      db: fx.db, workerId: "agent_core", runtimeId: "agent_core", agentId: "main", now: "2026-09-16T12:00:00.000Z",
      handlers: { calendar_action_upsert: async (row) => handled.push(row) },
      send: async () => { throw new Error("telegram send must not run"); }
    });
    assert.equal(result.status, "sent");
    assert.equal(result.id, id);
    assert.equal(handled.length, 1);
    assert.equal(handled[0].kind, "calendar_action_upsert");
    assert.equal(handled[0].payload.entityId, "a1");
  } finally { cleanup(fx); }
});

test("outbox uses bounded backoff and dead-letters the fifth failure", async () => {
  const fx = fixture();
  try {
    const hasDeadAt = fx.db.prepare("PRAGMA table_info(outbox)").all().some(row => row.name === "dead_at");
    assert.equal(hasDeadAt, true);
    dbApi.upsertMemberRoute(fx.db, "participant_alpha", {
      runtimeId: "agent_core", agentId: "main", channel: "telegram", accountId: "default", to: "telegram:123"
    });
    const id = dbApi.enqueueOutbox(fx.db, {
      dedupeKey: "poison:1", recipientMemberId: "participant_alpha", kind: "text",
      payload: { text: "poison" }, availableAt: "2026-09-18T00:00:00.000Z"
    });
    const { processOutboxOnce } = await import("../dist/index.js");
    const times = [
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:05:00.000Z",
      "2026-09-18T00:20:00.000Z",
      "2026-09-18T01:20:00.000Z",
      "2026-09-18T07:20:00.000Z"
    ];
    const expectedNext = [
      "2026-09-18T00:05:00.000Z",
      "2026-09-18T00:20:00.000Z",
      "2026-09-18T01:20:00.000Z",
      "2026-09-18T07:20:00.000Z"
    ];
    for (let i = 0; i < 5; i += 1) {
      const result = await processOutboxOnce({
        db: fx.db, workerId: "worker-" + i, runtimeId: "agent_core", agentId: "main",
        now: times[i], send: async () => { throw new Error("provider down"); }
      });
      if (i < 4) {
        assert.equal(result.status, "retry");
        const row = fx.db.prepare("SELECT attempts,available_at AS availableAt,dead_at AS deadAt FROM outbox WHERE id=?").get(id);
        assert.equal(row.attempts, i + 1);
        assert.equal(row.availableAt, expectedNext[i]);
        assert.equal(row.deadAt, null);
      } else {
        assert.equal(result.status, "dead");
        const row = fx.db.prepare("SELECT attempts,dead_at AS deadAt FROM outbox WHERE id=?").get(id);
        assert.equal(row.attempts, 5);
        assert.equal(row.deadAt, times[i]);
      }
    }
    assert.equal(dbApi.claimDueOutbox(fx.db, {
      workerId: "future", runtimeId: "agent_core", agentId: "main",
      now: "2099-01-01T00:00:00.000Z", leaseMs: 60000
    }), null);
  } finally { cleanup(fx); }
});
