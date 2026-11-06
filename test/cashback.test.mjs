import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createFamilyTool } from "../dist/tool.js";
import { createFamilyRuntime } from "../dist/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-cashback-"));
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
function tool(db, agentId) {
  return createFamilyTool({
    db, runtimeId: "agent_core", agentId,
    toolContext: { senderIsOwner: true, messageChannel: "telegram", agentId, sessionKey: `agent:${agentId}:telegram:direct:1` }
  });
}
function cleanup(fx) { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }

test("cashback is shared, monthly and replaceable", async () => {
  const fx = fixture();
  try {
    const agent_core = tool(fx.db, "main");
    const agent_second = tool(fx.db, "agent_second");
    const first = await agent_core.execute("cash-1", {
      action: "set_cashback", cashbackYear: 2026, cashbackMonth: 10,
      cashbackTitle: "Кэшбэк — октябрь 2026", cashbackBody: "Т-Банк\\n• 5% — аптеки"
    });
    assert.equal(first.details.ok, true);
    const seen = await agent_second.execute("cash-read-1", { action: "get_cashback" });
    assert.equal(seen.details.item.title, "Кэшбэк — октябрь 2026");
    assert.match(seen.details.item.body, /5% — аптеки/);
    const replaced = await agent_core.execute("cash-2", {
      action: "set_cashback", cashbackYear: 2026, cashbackMonth: 10,
      cashbackTitle: "Кэшбэк — октябрь 2026", cashbackBody: "Т-Банк\\n• 6% — аптеки"
    });
    assert.equal(replaced.details.ok, true);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM cashback_periods").get().c, 1);
    const exact = await agent_second.execute("cash-read-2", { action: "get_cashback", cashbackYear: 2026, cashbackMonth: 10 });
    assert.match(exact.details.item.body, /6% — аптеки/);
  } finally { cleanup(fx); }
});

test("cashback button opens latest saved month", async () => {
  const fx = fixture();
  try {
    const agent_core = tool(fx.db, "main");
    await agent_core.execute("cash-ui-1", {
      action: "set_cashback", cashbackYear: 2026, cashbackMonth: 10,
      cashbackTitle: "Кэшбэк — октябрь 2026", cashbackBody: "Сбер\\n• 7% — рестораны"
    });
    const rt = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const menu = rt.command.handler({ isAuthorizedSender: true, agentId: "main" });
    // Кэшбэк живёт во вторичном экране ✨ Ещё, чтобы главный экран оставался коротким.
    assert.equal(menu.channelData.telegram.buttons.flat().some(b => b.callback_data === "family:section:cashback"), false);
    const more = [];
    await rt.interactive.handler({
      sessionKey: "agent:main:telegram:direct:1", auth: { isAuthorizedSender: true },
      callback: { payload: "more" },
      respond: { async editMessage(v) { more.push(v); }, async reply() {} }
    });
    assert(more.at(-1).buttons.flat().some(b => b.callback_data === "family:section:cashback"));
    const edits = [];
    await rt.interactive.handler({
      sessionKey: "agent:main:telegram:direct:1", auth: { isAuthorizedSender: true },
      callback: { payload: "section:cashback" },
      respond: { async editMessage(v) { edits.push(v); }, async reply() {} }
    });
    assert.match(edits.at(-1).text, /Кэшбэк — октябрь 2026/);
    assert.match(edits.at(-1).text, /7% — рестораны/);
  } finally { cleanup(fx); }
});
