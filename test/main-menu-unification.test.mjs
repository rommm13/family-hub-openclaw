import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createPlan, createPlace, createMoneyGoal } from "../dist/domain.js";
import { createFamilyRuntime } from "../dist/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-main-unify-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [{ id: "participant_alpha", name: "Иван", role: "parent" }],
    bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }]
  });
  return { dir, db };
}
function cleanup(fx) {
  fx.db.close();
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

test("main menu keeps eight finger-sized family shortcuts and hides secondary sections", () => {
  const fx = fixture();
  try {
    const rt = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const menu = rt.command.handler({ isAuthorizedSender: true, agentId: "main" });
    const rows = menu.channelData.telegram.buttons;
    const labels = rows.flat().map(x => x.text);
    assert.deepEqual(labels, [
      "📌 Дела", "🛒 Купить",
      "🗓 Вместе", "📝 Записки",
      "📍 Куда", "🎁 Хочу",
      "💝 Сюрприз", "✨ Ещё",
      "👋 Закрыть"
    ]);
    // Two buttons per row keeps every target finger-sized on iPhone.
    for (const row of rows.slice(0, -1)) assert.equal(row.length, 2);
    assert.equal(labels.includes("📦 Капсулы"), false);
    assert.equal(labels.includes("💳 Кэшбэк"), false);
  } finally {
    cleanup(fx);
  }
});

test("planning section merges plans places and goals into one view", async () => {
  const fx = fixture();
  try {
    createPlan(fx.db, { householdId: "home", createdBy: "participant_alpha", title: "Отпуск", participants: ["participant_alpha"] });
    createPlace(fx.db, { householdId: "home", createdBy: "participant_alpha", name: "Тбилиси" });
    createMoneyGoal(fx.db, { householdId: "home", createdBy: "participant_alpha", assigneeId: "participant_alpha", title: "На отпуск", amount: 100000, currency: "RUB", dueAt: "2027-06-01" });
    const rt = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const edits = [];
    await rt.interactive.handler({
      sessionKey: "agent:main:telegram:direct:1",
      auth: { isAuthorizedSender: true },
      callback: { payload: "section:planning" },
      respond: { async editMessage(v) { edits.push(v); }, async reply() {} }
    });
    const view = edits.at(-1);
    assert.match(view.text, /🧳 Планы/);
    assert.match(view.text, /📍 Куда/);
    assert.match(view.text, /🌱 Цели/);
    assert.match(view.text, /Отпуск/);
    assert.match(view.text, /Тбилиси/);
    assert.match(view.text, /На отпуск/);
    const callbacks = view.buttons.flat().map(x => x.callback_data);
    assert(callbacks.includes("family:create:plans"));
    assert(callbacks.includes("family:create:places"));
    assert(callbacks.includes("family:create:goals"));
  } finally {
    cleanup(fx);
  }
});

test("legacy More callback now opens the secondary Ещё screen", async () => {
  const fx = fixture();
  try {
    const rt = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const edits = [];
    await rt.interactive.handler({
      sessionKey: "agent:main:telegram:direct:1",
      auth: { isAuthorizedSender: true },
      callback: { payload: "more" },
      respond: { async editMessage(v) { edits.push(v); }, async reply() {} }
    });
    const labels = edits.at(-1).buttons.flat().map(x => x.text);
    assert(labels.includes("🧭 Планы"));
    assert(labels.includes("💬 Выбрать"));
    assert(labels.includes("📦 Капсулы"));
    assert.equal(labels.includes("📌 Дела"), false);
  } finally {
    cleanup(fx);
  }
});
