import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createNote, createAction } from "../dist/domain.js";
import { createFamilyRuntime, registerFamilyHub } from "../dist/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-ui-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [
      { id: "participant_alpha", name: "Иван", role: "parent" },
      { id: "participant_beta", name: "Мария", role: "parent" }
    ],
    bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }]
  });
  return { dir, db };
}
test("family command renders deterministic Telegram menu", () => {
  const { dir, db } = fixture();
  try {
    const runtime = createFamilyRuntime({ db, runtimeId: "agent_core", agentId: "main" });
    const reply = runtime.command.handler({ isAuthorizedSender: true, agentId: "main" });
    assert.match(reply.text, /🫶 Семья/);
    const buttons = reply.channelData.telegram.buttons.flat();
    assert(buttons.some(b => b.callback_data === "family:section:actions"));
    assert(buttons.some(b => b.callback_data === "family:section:notes"));
    assert(buttons.some(b => b.callback_data === "family:more"));
    // Secondary sections live behind ✨ Ещё so the first screen stays readable.
    assert.equal(buttons.some(b => b.callback_data === "family:section:planning"), false);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("persistent Family button bypasses LLM and receives Telegram menu payload", async () => {
  const { dir, db } = fixture();
  try {
    const runtime = createFamilyRuntime({ db, runtimeId: "agent_core", agentId: "main" });
    const sessionKey = "agent:main:telegram:direct:123";
    const claimed = await runtime.beforeDispatch(
      { content: "🫶 Семья", channel: "telegram" }, { sessionKey, senderId: "123" }
    );
    assert.equal(claimed.handled, true);
    assert.match(claimed.text, /🫶 Семья/);
    const outgoing = await runtime.replyPayloadSending(
      { payload: { text: claimed.text }, channel: "telegram", sessionKey }, {}
    );
    assert(outgoing.payload.channelData.telegram.buttons.length > 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("interactive section edits the same Telegram message", async () => {
  const { dir, db } = fixture();
  try {
    createNote(db, { householdId: "home", createdBy: "participant_alpha", title: "Wi-Fi", body: "Пароль у роутера", visibility: "household" });
    createAction(db, { householdId: "home", createdBy: "participant_alpha", assigneeId: "participant_alpha", title: "Купить корм", dueAt: "2026-09-18" });
    const runtime = createFamilyRuntime({ db, runtimeId: "agent_core", agentId: "main" });
    const edits = [];
    const result = await runtime.interactive.handler({
      auth: { isAuthorizedSender: true },
      callback: { payload: "section:notes" },
      respond: {
        async editMessage(value) { edits.push(value); },
        async reply() { throw new Error("must edit existing menu"); }
      }
    });
    assert.equal(result.handled, true);
    assert.equal(edits.length, 1);
    assert.match(edits[0].text, /Wi-Fi/);
    assert(edits[0].buttons.flat().some(b => b.callback_data === "family:menu"));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("plugin registers command, global dispatch hooks and Telegram namespace", () => {
  const { dir, db } = fixture();
  try {
    const commands = [];
    const hooks = new Map();
    const interactive = [];
    registerFamilyHub({
      registerCommand(command) { commands.push(command); },
      registerInteractiveHandler(registration) { interactive.push(registration); },
      registerTool() {},
      on(name, handler) { hooks.set(name, handler); }
    }, { db, runtimeId: "agent_core", agentId: "main" });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, "family");
    assert.equal(commands[0].requireAuth, true);
    assert.equal(interactive.length, 1);
    assert.equal(interactive[0].channel, "telegram");
    assert.equal(interactive[0].namespace, "family");
    assert.equal(hooks.has("before_dispatch"), true);
    assert.equal(hooks.has("reply_payload_sending"), true);
    assert.equal(hooks.has("inbound_claim"), true);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("interactive registration supports both 2026.9.4 handler and newer handle contracts", () => {
  const { dir, db } = fixture();
  try {
    let registration;
    registerFamilyHub({
      registerCommand() {},
      registerInteractiveHandler(value) { registration = value; },
      registerTool() {}, on() {}
    }, { db, runtimeId: "agent_core", agentId: "main" });
    assert.equal(typeof registration.handler, "function");
    assert.equal(typeof registration.handle, "function");
    assert.equal(registration.handler, registration.handle);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("unauthorized command never exposes the Family menu", () => {
  const { dir, db } = fixture();
  try {
    const runtime = createFamilyRuntime({ db, runtimeId: "agent_core", agentId: "main" });
    const reply = runtime.command.handler({ isAuthorizedSender: false, agentId: "main" });
    assert.match(reply.text, /недоступен/);
    assert.equal(reply.channelData, undefined);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("unauthorized interactive callback is denied without editing menu", async () => {
  const { dir, db } = fixture();
  try {
    const runtime = createFamilyRuntime({ db, runtimeId: "agent_core", agentId: "main" });
    const replies = []; const edits = [];
    const result = await runtime.interactive.handler({
      auth: { isAuthorizedSender: false }, callback: { payload: "section:notes" },
      respond: { async reply(v) { replies.push(v); }, async editMessage(v) { edits.push(v); } }
    });
    assert.equal(result.handled, true);
    assert.equal(edits.length, 0);
    assert.match(replies[0].text, /недоступен/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("unknown interactive callback fails closed with stale-menu reply", async () => {
  const { dir, db } = fixture();
  try {
    const runtime = createFamilyRuntime({ db, runtimeId: "agent_core", agentId: "main" });
    const replies = []; const edits = [];
    await runtime.interactive.handler({
      auth: { isAuthorizedSender: true }, callback: { payload: "section:unknown" },
      respond: { async reply(v) { replies.push(v); }, async editMessage(v) { edits.push(v); } }
    });
    assert.equal(edits.length, 0);
    assert.match(replies[0].text, /Меню устарело/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("plugin registers optional family tool factory with trusted context", () => {
  const { dir, db } = fixture();
  try {
    let factory; let options;
    registerFamilyHub({
      registerCommand() {}, registerInteractiveHandler() {}, on() {},
      registerTool(value, opts) { factory = value; options = opts; }
    }, { db, runtimeId: "agent_core", agentId: "main" });
    assert.equal(typeof factory, "function");
    assert.equal(options.optional, true);
    assert.deepEqual(options.names, ["family"]);
    const denied = factory({ senderIsOwner: false, messageChannel: "telegram", agentId: "main", sessionKey: "agent:main:telegram:direct:123" });
    assert.equal(denied, null);
    const tool = factory({ senderIsOwner: true, messageChannel: "telegram", agentId: "main", sessionKey: "agent:main:telegram:direct:123" });
    assert.equal(tool.name, "family");
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("main menu exposes close action and close removes inline buttons", async () => {
  const { dir, db } = fixture();
  try {
    const runtime = createFamilyRuntime({ db, runtimeId: "agent_core", agentId: "main" });
    const menu = runtime.command.handler({ isAuthorizedSender: true, agentId: "main" });
    assert(menu.channelData.telegram.buttons.flat().some(b => b.callback_data === "family:close"));

    const edits = [];
    const result = await runtime.interactive.handler({
      auth: { isAuthorizedSender: true }, callback: { payload: "close" },
      respond: {
        async editMessage(value) { edits.push(value); },
        async reply() { throw new Error("close must edit existing menu"); }
      }
    });
    assert.equal(result.handled, true);
    assert.deepEqual(edits, [{ text: "🫶 Семья · меню закрыто", buttons: [] }]);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("calendar section renders upcoming Family calendar events and close navigation", async () => {
  const { dir, db } = fixture();
  try {
    const seen = [];
    const calendar = {
      async listUpcomingEvents(input) {
        seen.push(input);
        return [
          { id: "all-day", summary: "Годовщина", start: "2026-09-18", allDay: true },
          { id: "timed", summary: "Семейный ужин", start: "2026-09-19T16:30:00Z", allDay: false }
        ];
      }
    };
    const runtime = createFamilyRuntime({
      db, runtimeId: "agent_core", agentId: "main", calendar,
      now: () => Date.parse("2026-09-16T20:00:00Z"), calendarTimeZone: "Europe/Moscow"
    });
    const edits = [];
    const result = await runtime.interactive.handler({
      auth: { isAuthorizedSender: true }, callback: { payload: "section:calendar" },
      respond: {
        async editMessage(value) { edits.push(value); },
        async reply() { throw new Error("calendar must edit existing menu"); }
      }
    });
    assert.equal(result.handled, true);
    assert.deepEqual(seen, [{ from: "2026-09-16T20:00:00.000Z", max: 10 }]);
    assert.match(edits[0].text, /18\.09 · Годовщина/);
    assert.match(edits[0].text, /19\.09 19:30 · Семейный ужин/);
    const callbacks = edits[0].buttons.flat().map(b => b.callback_data);
    assert(callbacks.includes("family:menu"));
    assert(callbacks.includes("family:close"));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("calendar section degrades gracefully when Google Calendar is unavailable", async () => {
  const { dir, db } = fixture();
  try {
    const runtime = createFamilyRuntime({
      db, runtimeId: "agent_core", agentId: "main",
      calendar: { async listUpcomingEvents() { throw new Error("calendar offline"); } },
      now: () => Date.parse("2026-09-16T20:00:00Z")
    });
    const edits = [];
    await runtime.interactive.handler({
      auth: { isAuthorizedSender: true }, callback: { payload: "section:calendar" },
      respond: { async editMessage(value) { edits.push(value); }, async reply() {} }
    });
    assert.match(edits[0].text, /Календарь временно недоступен/);
    assert(edits[0].buttons.flat().some(b => b.callback_data === "family:close"));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});


test("repeated Telegram menu edit is treated as success instead of blocking the ingress lane", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const result = await runtime.interactive.handler({
      sessionKey: "agent:main:telegram:direct:123",
      auth: { isAuthorizedSender: true },
      callback: { payload: "close" },
      respond: {
        async editMessage() { throw new Error("400: Bad Request: message is not modified"); },
        async reply() {}
      }
    });
    assert.equal(result.handled, true);
  } finally { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});
