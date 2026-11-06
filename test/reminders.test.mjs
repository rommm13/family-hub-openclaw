import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createAction, completeAction } from "../dist/domain.js";
import { enqueueDailyActionReminders } from "../dist/reminders.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-reminders-"));
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
}function cleanup(fx) {
  fx.db.close();
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

function makeAction(db, dueAt) {
  return createAction(db, {
    householdId: "home", createdBy: "participant_alpha", assigneeId: "participant_alpha",
    title: "Купить корм", dueAt, allDay: !String(dueAt ?? "").includes("T")
  }).id;
}

test("daily reminders start only after configured local time and dedupe per day", () => {
  const fx = fixture();
  try {
    makeAction(fx.db, "2026-09-18");
    assert.equal(enqueueDailyActionReminders(fx.db, {
      now: new Date("2026-09-16T05:59:00Z"), timeZone: "Europe/Moscow", reminderTime: "09:00"
    }), 0);
    assert.equal(enqueueDailyActionReminders(fx.db, {
      now: new Date("2026-09-16T06:00:00Z"), timeZone: "Europe/Moscow", reminderTime: "09:00"
    }), 1);
    assert.equal(enqueueDailyActionReminders(fx.db, {
      now: new Date("2026-09-16T10:00:00Z"), timeZone: "Europe/Moscow", reminderTime: "09:00"
    }), 0);
  } finally { cleanup(fx); }
});
test("completed and undated actions do not produce daily reminders", () => {
  const fx = fixture();
  try {
    const dated = makeAction(fx.db, "2026-09-18");
    makeAction(fx.db, null);
    completeAction(fx.db, dated, "participant_alpha");
    assert.equal(enqueueDailyActionReminders(fx.db, {
      now: new Date("2026-09-16T07:00:00Z"), timeZone: "Europe/Moscow", reminderTime: "09:00"
    }), 0);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM outbox").get().c, 0);
  } finally { cleanup(fx); }
});

test("overdue reminder is marked and next day gets a new dedupe key", () => {
  const fx = fixture();
  try {
    makeAction(fx.db, "2026-09-15");
    assert.equal(enqueueDailyActionReminders(fx.db, {
      now: new Date("2026-09-16T07:00:00Z"), timeZone: "Europe/Moscow", reminderTime: "09:00"
    }), 1);
    const first = fx.db.prepare("SELECT dedupe_key AS key,payload_json AS payload FROM outbox").get();
    assert.match(JSON.parse(first.payload).text, /Просрочено/);
    assert.match(first.key, /2026-09-16$/);
    assert.equal(enqueueDailyActionReminders(fx.db, {
      now: new Date("2026-09-17T07:00:00Z"), timeZone: "Europe/Moscow", reminderTime: "09:00"
    }), 1);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM outbox").get().c, 2);
  } finally { cleanup(fx); }
});