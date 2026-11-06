import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createFamilyTool } from "../dist/tool.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-assign-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [
      { id: "participant_alpha", name: "Иван", role: "parent" },
      { id: "participant_beta", name: "Мария", role: "parent" }
    ],
    bindings: [
      { runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" },
      { runtimeId: "agent_core", agentId: "agent_second", memberId: "participant_beta" }
    ]
  });
  return { dir, db };
}
function cleanup(fx) { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
test("assigning an action to another member enqueues one immediate notification", async () => {
  const fx = fixture();
  try {
    const tool = createFamilyTool({
      db: fx.db, runtimeId: "agent_core", agentId: "main",
      toolContext: { senderIsOwner: true, messageChannel: "telegram", agentId: "main", sessionKey: "agent:main:telegram:direct:123" }
    });
    await tool.execute("assign-1", {
      action: "create_action", title: "Купить корм", assigneeId: "participant_beta", dueAt: "2026-09-18"
    });
    const rows = fx.db.prepare("SELECT kind,recipient_member_id AS recipient,payload_json AS payload FROM outbox ORDER BY id").all();
    assert.equal(rows.length, 2);
    const notify = rows.find(row => row.kind === "text");
    assert.equal(notify.recipient, "participant_beta");
    assert.equal(JSON.parse(notify.payload).text, "📌 Иван · новое дело: Купить корм");
  } finally { cleanup(fx); }
});
test("self-assignment still notifies the other family member once and repeated toolCallId does not duplicate", async () => {
  const fx = fixture();
  try {
    const tool = createFamilyTool({
      db: fx.db, runtimeId: "agent_core", agentId: "main",
      toolContext: { senderIsOwner: true, messageChannel: "telegram", agentId: "main", sessionKey: "agent:main:telegram:direct:123" }
    });
    const params = { action: "create_action", title: "Оплатить счёт", assigneeId: "participant_alpha", dueAt: "2026-09-18" };
    await tool.execute("self-1", params);
    await tool.execute("self-1", params);
    const rows = fx.db.prepare("SELECT kind,recipient_member_id AS recipient,payload_json AS payload FROM outbox ORDER BY id").all();
    assert.deepEqual(rows.map(r => r.kind), ["calendar_action_upsert", "text"]);
    assert.equal(rows[1].recipient, "participant_beta");
    assert.equal(JSON.parse(rows[1].payload).text, "📌 Иван · новое дело: Оплатить счёт");
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM actions").get().c, 1);
  } finally { cleanup(fx); }
});
