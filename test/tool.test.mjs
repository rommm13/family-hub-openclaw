import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createFamilyTool } from "../dist/tool.js";
import { createWish } from "../dist/domain.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-tool-"));
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

function cleanup(fx) {
  fx.db.close();
  fs.rmSync(fx.dir, { recursive: true, force: true });
}
test("family tool fails closed outside trusted Agent Alpha Telegram owner context", () => {
  const fx = fixture();
  try {
    const base = { db: fx.db, runtimeId: "agent_core", agentId: "main" };
    assert.equal(createFamilyTool({ ...base, toolContext: { senderIsOwner: false, messageChannel: "telegram", agentId: "main" } }), null);
    assert.equal(createFamilyTool({ ...base, toolContext: { senderIsOwner: true, messageChannel: "discord", agentId: "main" } }), null);
    assert.equal(createFamilyTool({ ...base, toolContext: { senderIsOwner: true, messageChannel: "telegram", agentId: "agent_second" } }), null);
    const tool = createFamilyTool({ ...base, toolContext: { senderIsOwner: true, messageChannel: "telegram", agentId: "main", sessionKey: "agent:main:telegram:direct:123" } });
    assert.equal(tool.name, "family");
  } finally { cleanup(fx); }
});

test("same toolCallId mutates Family Hub only once", async () => {
  const fx = fixture();
  try {
    const tool = createFamilyTool({ db: fx.db, runtimeId: "agent_core", agentId: "main", toolContext: { senderIsOwner: true, messageChannel: "telegram", agentId: "main", sessionKey: "agent:main:telegram:direct:123" } });
    const params = { action: "create_note", title: "Wi-Fi", body: "Пароль хранится в роутере", visibility: "household" };
    const first = await tool.execute("call-1", params);
    const second = await tool.execute("call-1", params);
    assert.equal(first.details.ok, true);
    assert.equal(second.details.duplicate, true);
    const count = fx.db.prepare("SELECT count(*) AS c FROM notes").get().c;
    assert.equal(count, 1);
  } finally { cleanup(fx); }
});
test("dated action asks for a date unless explicitly allowed undated", async () => {
  const fx = fixture();
  try {
    const tool = createFamilyTool({ db: fx.db, runtimeId: "agent_core", agentId: "main", toolContext: { senderIsOwner: true, messageChannel: "telegram", agentId: "main", sessionKey: "agent:main:telegram:direct:123" } });
    const result = await tool.execute("call-action-1", { action: "create_action", title: "Купить корм", assigneeId: "participant_alpha" });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.needsDate, true);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM actions").get().c, 0);
    const undated = await tool.execute("call-action-2", { action: "create_action", title: "Разобрать кладовку", assigneeId: "participant_alpha", allowUndated: true });
    assert.equal(undated.details.ok, true);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM actions").get().c, 1);
  } finally { cleanup(fx); }
});
test("read operations do not consume mutation idempotency keys", async () => {
  const fx = fixture();
  try {
    const tool = createFamilyTool({ db: fx.db, runtimeId: "agent_core", agentId: "main", toolContext: { senderIsOwner: true, messageChannel: "telegram", agentId: "main", sessionKey: "agent:main:telegram:direct:123" } });
    const result = await tool.execute("call-read-1", { action: "list", section: "notes" });
    assert.equal(result.details.ok, true);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM processed_actions").get().c, 0);
  } finally { cleanup(fx); }
});

test("invalid mutation fails without partial records or burned idempotency key", async () => {
  const fx = fixture();
  try {
    const tool = createFamilyTool({ db: fx.db, runtimeId: "agent_core", agentId: "main", toolContext: { senderIsOwner: true, messageChannel: "telegram", agentId: "main", sessionKey: "agent:main:telegram:direct:123" } });
    await assert.rejects(() => tool.execute("call-bad-1", { action: "create_action", title: "Тест", assigneeId: "nobody", dueAt: "2026-09-18" }), /Unknown family member/);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM actions").get().c, 0);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM processed_actions").get().c, 0);
  } finally { cleanup(fx); }
});

test("family tool reserves another member wish without exposing it to the owner", async () => {
  const fx = fixture();
  try {
    const wish = createWish(fx.db, { householdId: "home", ownerId: "participant_beta", title: "Кофемолка" });
    const tool = createFamilyTool({ db: fx.db, runtimeId: "agent_core", agentId: "main", toolContext: { senderIsOwner: true, messageChannel: "telegram", agentId: "main", sessionKey: "agent:main:telegram:direct:123" } });
    const result = await tool.execute("call-reserve-1", { action: "reserve_wish", wishId: wish.id });
    assert.equal(result.details.ok, true);
    const row = fx.db.prepare("SELECT reserved_by AS reservedBy FROM wish_reservations WHERE wish_id=?").get(wish.id);
    assert.equal(row.reservedBy, "participant_alpha");
  } finally { cleanup(fx); }
});

test("family tool creates polls, exposes options, and hides votes until current member votes", async () => {
  const fx = fixture();
  try {
    const tool = createFamilyTool({ db: fx.db, runtimeId: "agent_core", agentId: "main", toolContext: { senderIsOwner: true, messageChannel: "telegram", agentId: "main", sessionKey: "agent:main:telegram:direct:123" } });
    const created = await tool.execute("call-poll-1", {
      action: "create_poll", question: "Куда поедем?", options: ["Тула", "Коломна"], participants: ["participant_alpha", "participant_beta"]
    });
    assert.equal(created.details.ok, true);
    const pollId = created.details.value.id;
    const before = await tool.execute("call-poll-read-1", { action: "get_poll", pollId });
    assert.deepEqual(before.details.item.options.map(x => x.label), ["Тула", "Коломна"]);
    assert.equal(before.details.item.votes, null);
    const voted = await tool.execute("call-poll-vote-1", { action: "vote_poll", pollId, optionIndex: 1 });
    assert.equal(voted.details.ok, true);
    const after = await tool.execute("call-poll-read-2", { action: "get_poll", pollId });
    assert.equal(after.details.item.votes.length, 1);
    assert.equal(after.details.item.votes[0].memberId, "participant_alpha");
    assert.equal(after.details.item.votes[0].optionIndex, 1);
  } finally { cleanup(fx); }
});
