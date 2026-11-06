import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createFamilyRuntime, registerFamilyHub } from "../dist/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-dispatch-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [{ id: "participant_alpha", name: "Иван", role: "parent" }],
    bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }]
  });
  return { dir, db };
}

function cleanup({ dir, db }) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
test("Family button is handled by before_dispatch only for Agent Alpha Telegram session", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const handled = await runtime.beforeDispatch(
      { content: "  🫶 Семья  ", channel: "telegram" },
      { sessionKey: "agent:main:telegram:direct:123", senderId: "123" }
    );
    assert.equal(handled.handled, true);
    assert.match(handled.text, /🫶 Семья/);
    assert.equal(await runtime.beforeDispatch(
      { content: "привет", channel: "telegram" },
      { sessionKey: "agent:main:telegram:direct:123" }
    ), undefined);
    assert.equal(await runtime.beforeDispatch(
      { content: "🫶 Семья", channel: "discord" },
      { sessionKey: "agent:main:discord:direct:123" }
    ), undefined);
    assert.equal(await runtime.beforeDispatch(
      { content: "🫶 Семья", channel: "telegram" },
      { sessionKey: "agent:agent_second:telegram:direct:123" }
    ), undefined);
  } finally { cleanup(fx); }
});

test("reply_payload_sending decorates only the pending Family reply and only once", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const sessionKey = "agent:main:telegram:direct:123";
    const claimed = await runtime.beforeDispatch({ content: "🫶 Семья", channel: "telegram" }, { sessionKey });
    const unrelated = await runtime.replyPayloadSending({
      payload: { text: "другой ответ" }, channel: "telegram", sessionKey
    }, {});
    assert.equal(unrelated, undefined);
    const decorated = await runtime.replyPayloadSending({
      payload: { text: claimed.text }, channel: "telegram", sessionKey
    }, {});
    assert.equal(decorated.payload.text, claimed.text);
    const buttons = decorated.payload.channelData.telegram.buttons.flat();
    assert(buttons.some(b => b.callback_data === "family:section:actions"));
    const second = await runtime.replyPayloadSending({
      payload: { text: claimed.text }, channel: "telegram", sessionKey
    }, {});
    assert.equal(second, undefined);
  } finally { cleanup(fx); }
});

test("plugin registers narrow media inbound claim plus global dispatch hooks", () => {
  const fx = fixture();
  try {
    const hooks = new Map();
    registerFamilyHub({
      registerCommand() {}, registerInteractiveHandler() {}, registerTool() {},
      on(name, handler) { hooks.set(name, handler); }
    }, { db: fx.db, runtimeId: "agent_core", agentId: "main" });
    assert.equal(hooks.has("before_dispatch"), true);
    assert.equal(hooks.has("reply_payload_sending"), true);
    assert.equal(hooks.has("inbound_claim"), true);
  } finally { cleanup(fx); }
});
test("malformed and foreign session keys never claim the Family button", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    for (const sessionKey of [undefined, "", "agent:main", "agent::telegram:x", "agent:main:", "main:telegram:x"]) {
      assert.equal(await runtime.beforeDispatch(
        { content: "🫶 Семья", channel: "telegram" }, { sessionKey }
      ), undefined);
    }
  } finally { cleanup(fx); }
});

test("pending menu decoration is isolated by session", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const a = "agent:main:telegram:direct:111";
    const b = "agent:main:telegram:direct:222";
    const claimed = await runtime.beforeDispatch({ content: "🫶 Семья", channel: "telegram" }, { sessionKey: a });
    assert.equal(await runtime.replyPayloadSending({ payload: { text: claimed.text }, channel: "telegram", sessionKey: b }), undefined);
    assert.ok((await runtime.replyPayloadSending({ payload: { text: claimed.text }, channel: "telegram", sessionKey: a })).payload);
  } finally { cleanup(fx); }
});test("menu decoration preserves existing channel data", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const sessionKey = "agent:main:telegram:direct:123";
    const claimed = await runtime.beforeDispatch({ content: "🫶 Семья", channel: "telegram" }, { sessionKey });
    const result = await runtime.replyPayloadSending({
      payload: { text: claimed.text, channelData: { audit: { trace: "keep" }, telegram: { parse_mode: "HTML" } } },
      channel: "telegram", sessionKey
    });
    assert.equal(result.payload.channelData.audit.trace, "keep");
    assert.equal(result.payload.channelData.telegram.parse_mode, "HTML");
    assert.ok(result.payload.channelData.telegram.buttons.length > 0);
  } finally { cleanup(fx); }
});

test("expired pending menu cannot decorate a later reply", async () => {
  const fx = fixture();
  try {
    let now = 1_000;
    const runtime = createFamilyRuntime({
      db: fx.db, runtimeId: "agent_core", agentId: "main", menuTtlMs: 50, now: () => now
    });
    const sessionKey = "agent:main:telegram:direct:123";
    const claimed = await runtime.beforeDispatch({ content: "🫶 Семья", channel: "telegram" }, { sessionKey });
    now = 1_051;
    assert.equal(await runtime.replyPayloadSending({ payload: { text: claimed.text }, channel: "telegram", sessionKey }), undefined);
  } finally { cleanup(fx); }
});test("two rapid Family presses require two matching payload deliveries", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const sessionKey = "agent:main:telegram:direct:123";
    const first = await runtime.beforeDispatch({ content: "🫶 Семья", channel: "telegram" }, { sessionKey });
    const second = await runtime.beforeDispatch({ content: "🫶 Семья", channel: "telegram" }, { sessionKey });
    assert.ok((await runtime.replyPayloadSending({ payload: { text: first.text }, channel: "telegram", sessionKey })).payload);
    assert.ok((await runtime.replyPayloadSending({ payload: { text: second.text }, channel: "telegram", sessionKey })).payload);
    assert.equal(await runtime.replyPayloadSending({ payload: { text: second.text }, channel: "telegram", sessionKey }), undefined);
  } finally { cleanup(fx); }
});

test("non-Telegram payload does not consume pending Telegram menu", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const sessionKey = "agent:main:telegram:direct:123";
    const claimed = await runtime.beforeDispatch({ content: "🫶 Семья", channel: "telegram" }, { sessionKey });
    assert.equal(await runtime.replyPayloadSending({ payload: { text: claimed.text }, channel: "discord", sessionKey }), undefined);
    assert.ok((await runtime.replyPayloadSending({ payload: { text: claimed.text }, channel: "telegram", sessionKey })).payload);
  } finally { cleanup(fx); }
});

test("Family button stores only the trusted direct Telegram route", async () => {
  const fx = fixture();
  try {
    const { getMemberRoute } = await import("../dist/db.js");
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    await runtime.beforeDispatch(
      { content: "🫶 Семья", channel: "telegram", isGroup: false, senderId: "123" },
      { sessionKey: "agent:main:telegram:direct:123", conversationId: "123", accountId: "default" }
    );
    assert.deepEqual(getMemberRoute(fx.db, "participant_alpha", { runtimeId: "agent_core", agentId: "main" }), {
      channel: "telegram", accountId: "default", to: "telegram:123"
    });
    await runtime.beforeDispatch(
      { content: "🫶 Семья", channel: "telegram", isGroup: true, senderId: "-999" },
      { sessionKey: "agent:main:telegram:group:-999", conversationId: "-999", accountId: "default" }
    );
    assert.deepEqual(getMemberRoute(fx.db, "participant_alpha", { runtimeId: "agent_core", agentId: "main" }), {
      channel: "telegram", accountId: "default", to: "telegram:123"
    });
  } finally { cleanup(fx); }
});

test("legacy Family reply-keyboard label still opens the new menu", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const result = await runtime.beforeDispatch(
      { content: "🏠 Семья", channel: "telegram", isGroup: false, senderId: "123" },
      { sessionKey: "agent:main:telegram:direct:123", accountId: "default" }
    );
    assert.equal(result?.handled, true);
    assert.match(result.text, /🫶 Семья/);
  } finally { cleanup(fx); }
});
