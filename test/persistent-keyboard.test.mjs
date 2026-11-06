import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as dbApi from "../dist/db.js";
import { createFamilyRuntime } from "../dist/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-keyboard-"));
  const db = dbApi.openFamilyDb(path.join(dir, "family.sqlite"));
  dbApi.bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [{ id: "participant_alpha", name: "Иван", role: "parent" }],
    bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }]
  });
  return { dir, db };
}
function cleanup(fx) { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
const scope = { runtimeId: "agent_core", agentId: "main" };
test("keyboard install state persists per runtime route and resets when route changes", () => {
  const fx = fixture();
  try {
    dbApi.upsertMemberRoute(fx.db, "participant_alpha", { ...scope, channel: "telegram", accountId: "default", to: "telegram:111" });
    assert.equal(dbApi.getMemberKeyboardInstalledAt?.(fx.db, "participant_alpha", scope) ?? null, null);
    assert.equal(typeof dbApi.markMemberKeyboardInstalled, "function");
    dbApi.markMemberKeyboardInstalled(fx.db, "participant_alpha", { ...scope, installedAt: "2026-09-16T12:00:00Z" });
    assert.equal(dbApi.getMemberKeyboardInstalledAt(fx.db, "participant_alpha", scope), "2026-09-16T12:00:00Z");
    dbApi.upsertMemberRoute(fx.db, "participant_alpha", { ...scope, channel: "telegram", accountId: "default", to: "telegram:111" });
    assert.equal(dbApi.getMemberKeyboardInstalledAt(fx.db, "participant_alpha", scope), "2026-09-16T12:00:00Z");
    dbApi.upsertMemberRoute(fx.db, "participant_alpha", { ...scope, channel: "telegram", accountId: "default", to: "telegram:222" });
    assert.equal(dbApi.getMemberKeyboardInstalledAt(fx.db, "participant_alpha", scope), null);
  } finally { cleanup(fx); }
});test("trusted direct Telegram traffic installs persistent Family keyboard only once", async () => {
  const fx = fixture();
  try {
    const calls = [];
    const runtime = createFamilyRuntime({
      db: fx.db, runtimeId: "agent_core", agentId: "main",
      ensurePersistentKeyboard: async input => { calls.push(input); return true; }
    });
    const event = { content: "Привет", channel: "telegram", isGroup: false, senderId: "111" };
    const ctx = { sessionKey: "agent:main:telegram:direct:111", conversationId: "111", accountId: "default" };
    assert.equal(await runtime.beforeDispatch(event, ctx), undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].route.to, "telegram:111");
    assert.equal(calls[0].buttonText, "🫶 Семья");
    assert.ok(dbApi.getMemberKeyboardInstalledAt(fx.db, "participant_alpha", scope));
    assert.equal(await runtime.beforeDispatch({ ...event, content: "Ещё сообщение" }, ctx), undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
  } finally { cleanup(fx); }
});
test("group traffic never installs a persistent reply keyboard", async () => {
  const fx = fixture();
  try {
    let calls = 0;
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main", ensurePersistentKeyboard: async () => { calls += 1; return true; } });
    const result = await runtime.beforeDispatch(
      { content: "Привет", channel: "telegram", isGroup: true, senderId: "-100" },
      { sessionKey: "agent:main:telegram:group:-100", conversationId: "-100", accountId: "default" }
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result, undefined);
    assert.equal(calls, 0);
    assert.equal(dbApi.getMemberRoute(fx.db, "participant_alpha", scope), null);
  } finally { cleanup(fx); }
});

test("keyboard install failure does not block the message and remains retryable", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main", ensurePersistentKeyboard: async () => { throw new Error("offline"); } });
    const result = await runtime.beforeDispatch(
      { content: "Обычное сообщение", channel: "telegram", isGroup: false, senderId: "111" },
      { sessionKey: "agent:main:telegram:direct:111", conversationId: "111", accountId: "default" }
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result, undefined);
    assert.equal(dbApi.getMemberKeyboardInstalledAt(fx.db, "participant_alpha", scope), null);
  } finally { cleanup(fx); }
});
test("configured plugin supplies live gateway config to keyboard installer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-keyboard-service-"));
  const dbPath = path.join(dir, "family.sqlite");
  const { registerConfiguredFamilyHub } = await import("../dist/index.js");
  let service; let beforeDispatch; let gatewayStop;
  const calls = [];
  const api = {
    pluginConfig: { dbPath, runtimeId: "agent_core", agentId: "main" },
    runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText: async () => ({ messageId: "1" }) }) } } },
    registerCommand() {}, registerInteractiveHandler() {}, registerTool() {},
    registerHttpRoute() {},
    registerService(value) { service = value; },
    on(name, handler) {
      if (name === "before_dispatch") beforeDispatch = handler;
      if (name === "gateway_stop") gatewayStop = handler;
    }
  };
  try {
    registerConfiguredFamilyHub(api, { installPersistentKeyboard: async input => { calls.push(input); return true; } });
    const peer = dbApi.openFamilyDb(dbPath);
    dbApi.bootstrapFamily(peer, {
      household: { id: "home", name: "Семья" },
      members: [{ id: "participant_alpha", name: "Иван", role: "parent" }],
      bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }]
    });
    peer.close();
    const gatewayCfg = { marker: "live-gateway-config" };
    await service.start({ config: gatewayCfg, logger: { warn() {}, error() {}, info() {}, debug() {} } });
    await beforeDispatch(
      { content: "Привет", channel: "telegram", isGroup: false, senderId: "111" },
      { sessionKey: "agent:main:telegram:direct:111", conversationId: "111", accountId: "default" }
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cfg, gatewayCfg);
    assert.equal(calls[0].route.to, "telegram:111");
  } finally {
    if (service?.stop) await service.stop({ config: {}, logger: { warn() {}, error() {}, info() {}, debug() {} } });
    if (gatewayStop) await gatewayStop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
