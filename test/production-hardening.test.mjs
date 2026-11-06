import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createFamilyCalendarEvent, getFamilyCalendarEvent, updateFamilyCalendarEvent, createNote, updateNote } from "../dist/domain.js";
import { createFamilyRuntime } from "../dist/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-hardening-"));
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

test("title-only calendar edit preserves an explicit end time", () => {
  const fx = fixture();
  try {
    const created = createFamilyCalendarEvent(fx.db, {
      householdId: "home", createdBy: "participant_alpha", title: "Встреча",
      startAt: "2026-09-21T18:00:00+03:00", endAt: "2026-09-21T20:30:00+03:00",
      description: "Длинная встреча"
    });
    updateFamilyCalendarEvent(fx.db, created.id, "participant_alpha", { title: "Семейная встреча" });
    const row = getFamilyCalendarEvent(fx.db, created.id, "participant_alpha");
    assert.equal(row.endAt, "2026-09-21T20:30:00+03:00");
  } finally { cleanup(fx); }
});

test("expired wizard does not consume a later ordinary Telegram message", async () => {
  const fx = fixture();
  try {
    let clock = Date.parse("2026-09-18T06:00:00+03:00");
    const runtime = createFamilyRuntime({
      db: fx.db, runtimeId: "agent_core", agentId: "main",
      now: () => clock, wizardTtlMs: 15 * 60 * 1000
    });
    await runtime.interactive.handler({
      sessionKey: "agent:main:telegram:direct:123",
      auth: { isAuthorizedSender: true }, callback: { payload: "create:notes" },
      respond: { async editMessage() {}, async reply() {} }
    });
    clock += 16 * 60 * 1000;
    const result = await runtime.beforeDispatch(
      { content: "Обычное сообщение после паузы", channel: "telegram" },
      { sessionKey: "agent:main:telegram:direct:123", conversationId: "123", accountId: "default" }
    );
    assert.equal(result, undefined);
  } finally { cleanup(fx); }
});


test("stale note revision cannot overwrite a newer edit", () => {
  const fx = fixture();
  try {
    const note = createNote(fx.db, { householdId: "home", createdBy: "participant_alpha", title: "Wi-Fi", body: "one" });
    const first = updateNote(fx.db, note.id, "participant_alpha", { body: "two", expectedRevision: 1 });
    assert.equal(first.revision, 2);
    assert.throws(
      () => updateNote(fx.db, note.id, "participant_alpha", { body: "stale", expectedRevision: 1 }),
      /changed|conflict|измен/iu
    );
    const row = fx.db.prepare("SELECT body,revision FROM notes WHERE id=?").get(note.id);
    assert.equal(row.body, "two");
    assert.equal(row.revision, 2);
  } finally { cleanup(fx); }
});
