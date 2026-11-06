import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily, upsertMemberRoute, enqueueOutbox } from "../dist/db.js";
import { createAction } from "../dist/domain.js";
import { runFamilyMaintenance } from "../dist/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-maint-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [{ id: "participant_alpha", name: "Иван", role: "parent" }],
    bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }]
  });
  return { dir, db };
}
function cleanup(fx) { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
test("maintenance generates daily reminders once and drains them", async () => {
  const fx = fixture();
  try {
    upsertMemberRoute(fx.db, "participant_alpha", { runtimeId: "agent_core", agentId: "main", channel: "telegram", accountId: "default", to: "telegram:123" });
    createAction(fx.db, {
      householdId: "home", createdBy: "participant_alpha", assigneeId: "participant_alpha",
      title: "Купить корм", dueAt: "2026-09-18", allDay: true
    });
    const sent = [];
    const result = await runFamilyMaintenance({
      db: fx.db, workerId: "agent_core", runtimeId: "agent_core", agentId: "main", now: new Date("2026-09-16T06:00:00Z"),
      reminderTime: "09:00", reminderTimezone: "Europe/Moscow",
      send: async (route, text) => sent.push({ route, text }), handlers: {}
    });
    assert.equal(result.remindersCreated, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Купить корм/);
  } finally { cleanup(fx); }
});
test("maintenance dispatches typed calendar job through handlers", async () => {
  const fx = fixture();
  try {
    enqueueOutbox(fx.db, {
      dedupeKey: "calendar:probe", recipientMemberId: "participant_alpha", kind: "calendar_action_upsert",
      payload: { entityId: "action-1" }, availableAt: "2000-01-01T00:00:00.000Z"
    });
    const calls = [];
    const result = await runFamilyMaintenance({
      db: fx.db, workerId: "agent_core", runtimeId: "agent_core", agentId: "main", now: new Date("2026-09-16T12:00:00Z"),
      reminderTime: "23:59", reminderTimezone: "Europe/Moscow",
      send: async () => { throw new Error("text send must not be used"); },
      handlers: { calendar_action_upsert: async row => calls.push(row.payload.entityId) }
    });
    assert.equal(result.processed, 1);
    assert.deepEqual(calls, ["action-1"]);
  } finally { cleanup(fx); }
});
test("configured service runs reminder maintenance on startup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-maint-service-"));
  const dbPath = path.join(dir, "family.sqlite");
  const indexApi = await import("../dist/index.js");
  let service; let gatewayStop;
  const sent = [];
  const api = {
    pluginConfig: { dbPath, runtimeId: "agent_core", agentId: "main", reminderTime: "00:00", reminderTimezone: "Europe/Moscow" },
    runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText: async ctx => sent.push(ctx) }) } } },
    registerCommand() {}, registerInteractiveHandler() {}, registerTool() {},
    registerHttpRoute() {},
    registerService(v) { service = v; },
    on(name, handler) { if (name === "gateway_stop") gatewayStop = handler; }
  };
  try {
    indexApi.registerConfiguredFamilyHub(api);
    const peer = openFamilyDb(dbPath);
    bootstrapFamily(peer, {
      household: { id: "home", name: "Семья" }, members: [{ id: "participant_alpha", name: "Иван", role: "parent" }],
      bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }]
    });
    upsertMemberRoute(peer, "participant_alpha", { runtimeId: "agent_core", agentId: "main", channel: "telegram", accountId: "default", to: "telegram:123" });
    createAction(peer, {
      householdId: "home", createdBy: "participant_alpha", assigneeId: "participant_alpha",
      title: "Проверить reminder", dueAt: "2099-01-01", allDay: true
    });
    peer.close();
    const cfg = { marker: "gateway-config" };
    await service.start({ config: cfg, logger: { warn() {}, error() {}, info() {}, debug() {} } });
    await service.stop({ config: cfg, logger: { warn() {}, error() {}, info() {}, debug() {} } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].cfg, cfg);
    assert.equal(sent[0].to, "telegram:123");
    assert.match(sent[0].text, /Проверить reminder/);
  } finally {
    if (service?.stop) await service.stop({ config: {}, logger: { warn() {}, error() {}, info() {}, debug() {} } });
    if (gatewayStop) await gatewayStop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
