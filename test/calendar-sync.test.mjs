import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily, claimDueOutbox } from "../dist/db.js";
import { createFamilyTool } from "../dist/tool.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-cal-sync-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [{ id: "participant_alpha", name: "Иван", role: "parent" }],
    bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }]
  });
  return { dir, db };
}function cleanup(fx) {
  fx.db.close();
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

function tool(db) {
  return createFamilyTool({
    db, runtimeId: "agent_core", agentId: "main",
    toolContext: {
      senderIsOwner: true, messageChannel: "telegram", agentId: "main",
      sessionKey: "agent:main:telegram:direct:123"
    }
  });
}

test("dated action transactionally enqueues calendar upsert", async () => {
  const fx = fixture();
  try {
    const result = await tool(fx.db).execute("call-cal-1", {
      action: "create_action", title: "Купить корм", assigneeId: "participant_alpha", dueAt: "2026-09-18"
    });    const actionId = result.details.value.id;
    const row = claimDueOutbox(fx.db, {
      workerId: "test-worker", runtimeId: "agent_core", agentId: "main", now: "2099-09-16T15:00:00.000Z", leaseMs: 60_000
    });
    assert.equal(row.kind, "calendar_action_upsert");
    assert.equal(row.payload.entityType, "action");
    assert.equal(row.payload.entityId, actionId);
    assert.equal(row.payload.summary, "Купить корм");
    assert.equal(row.payload.dueAt, "2026-09-18");
  } finally { cleanup(fx); }
});

test("undated action does not enqueue calendar work", async () => {
  const fx = fixture();
  try {
    await tool(fx.db).execute("call-cal-2", {
      action: "create_action", title: "Разобрать кладовку", assigneeId: "participant_alpha", allowUndated: true
    });
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM outbox").get().c, 0);
  } finally { cleanup(fx); }
});
test("calendar sync persists canonical link and all-day event window", async () => {
  const fx = fixture();
  try {
    const created = await tool(fx.db).execute("call-cal-3", {
      action: "create_action", title: "Купить корм", assigneeId: "participant_alpha", dueAt: "2026-09-18"
    });
    const actionId = created.details.value.id;
    const { syncActionCalendar } = await import("../dist/calendar.js");
    const calls = [];
    const calendar = { ensureEvent: async (input) => { calls.push(input); return { id: "evt-1", created: true }; } };
    const result = await syncActionCalendar({ db: fx.db, calendar, calendarId: "family-cal", actionId });
    assert.equal(result.eventId, "evt-1");
    assert.equal(calls[0].from, "2026-09-18");
    assert.equal(calls[0].to, "2026-09-19");
    assert.equal(calls[0].allDay, true);
    const action = fx.db.prepare("SELECT google_event_id AS eventId FROM actions WHERE id=?").get(actionId);
    assert.equal(action.eventId, "evt-1");
    const link = fx.db.prepare("SELECT google_event_id AS eventId,calendar_id AS calendarId,sync_status AS status FROM calendar_links WHERE entity_type='action' AND entity_id=?").get(actionId);
    assert.deepEqual({ ...link }, { eventId: "evt-1", calendarId: "family-cal", status: "synced" });
  } finally { cleanup(fx); }
});
test("calendar sync keeps timed deadline and updates completed action in place", async () => {
  const fx = fixture();
  try {
    const created = await tool(fx.db).execute("call-cal-4", {
      action: "create_action", title: "Позвонить врачу", assigneeId: "participant_alpha",
      dueAt: "2026-09-18T18:00:00+03:00"
    });
    const actionId = created.details.value.id;
    const { completeAction } = await import("../dist/domain.js");
    const { syncActionCalendar } = await import("../dist/calendar.js");
    const ensured = [];
    const updated = [];
    const calendar = {
      ensureEvent: async (input) => { ensured.push(input); return { id: "evt-2", created: ensured.length === 1 }; },
      updateEvent: async (input) => { updated.push(input); return { id: input.eventId }; }
    };
    await syncActionCalendar({ db: fx.db, calendar, calendarId: "family-cal", actionId });
    assert.equal(ensured[0].allDay, false);
    assert.equal(ensured[0].from, "2026-09-18T18:00:00+03:00");
    assert.equal(new Date(ensured[0].to).getTime() - new Date(ensured[0].from).getTime(), 30 * 60 * 1000);
    completeAction(fx.db, actionId, "participant_alpha");
    await syncActionCalendar({ db: fx.db, calendar, calendarId: "family-cal", actionId });
    assert.equal(updated.at(-1).eventId, "evt-2");
    assert.match(updated.at(-1).summary, /^✅ /);
  } finally { cleanup(fx); }
});
test("timed action stores non-all-day flag", async () => {
  const fx = fixture();
  try {
    const created = await tool(fx.db).execute("call-cal-5", {
      action: "create_action", title: "Позвонить", assigneeId: "participant_alpha",
      dueAt: "2026-09-18T18:00:00+03:00"
    });
    const row = fx.db.prepare("SELECT all_day AS allDay FROM actions WHERE id=?").get(created.details.value.id);
    assert.equal(row.allDay, 0);
  } finally { cleanup(fx); }
});

test("completing dated action enqueues a distinct calendar resync", async () => {
  const fx = fixture();
  try {
    const created = await tool(fx.db).execute("call-cal-6", {
      action: "create_action", title: "Купить корм", assigneeId: "participant_alpha", dueAt: "2026-09-18"
    });
    await tool(fx.db).execute("call-cal-7", {
      action: "complete_action", actionId: created.details.value.id
    });
    const rows = fx.db.prepare("SELECT dedupe_key AS key,kind FROM outbox ORDER BY id").all();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].key, rows[1].key);
    assert.equal(rows[1].kind, "calendar_action_upsert");
  } finally { cleanup(fx); }
});
test("calendar outbox handler syncs action without Telegram delivery", async () => {
  const fx = fixture();
  try {
    const created = await tool(fx.db).execute("call-cal-8", {
      action: "create_action", title: "Купить корм", assigneeId: "participant_alpha", dueAt: "2026-09-18"
    });
    const { createCalendarOutboxHandlers } = await import("../dist/index.js");
    const calls = [];
    const handlers = createCalendarOutboxHandlers({
      db: fx.db, calendarId: "family-cal",
      calendar: { ensureEvent: async (input) => { calls.push(input); return { id: "evt-8", created: true }; } }
    });
    await handlers.calendar_action_upsert({
      kind: "calendar_action_upsert", payload: { entityId: created.details.value.id }
    });
    assert.equal(calls.length, 1);
    assert.equal(fx.db.prepare("SELECT google_event_id AS id FROM actions WHERE id=?").get(created.details.value.id).id, "evt-8");
  } finally { cleanup(fx); }
});

test("resync updates an existing open action after title or deadline changes", async () => {
  const fx = fixture();
  try {
    const created = await tool(fx.db).execute("call-cal-open-update", {
      action: "create_action", title: "Старое название", assigneeId: "participant_alpha",
      dueAt: "2026-09-18T18:00:00+03:00"
    });
    const actionId = created.details.value.id;
    const { updateAction } = await import("../dist/domain.js");
    const { syncActionCalendar } = await import("../dist/calendar.js");
    const updated = [];
    let ensureCalls = 0;
    const calendar = {
      ensureEvent: async () => {
        ensureCalls += 1;
        return { id: "evt-open", created: true };
      },
      updateEvent: async input => {
        updated.push(input);
        return { id: input.eventId };
      }
    };
    await syncActionCalendar({ db: fx.db, calendar, calendarId: "family-cal", actionId });
    updateAction(fx.db, actionId, "participant_alpha", {
      title: "Новое название", dueAt: "2026-09-19T19:30:00+03:00"
    });
    await syncActionCalendar({ db: fx.db, calendar, calendarId: "family-cal", actionId });
    assert.equal(ensureCalls, 1, "existing action must update by google_event_id without creating/searching again");
    assert.equal(updated.length, 1);
    assert.equal(updated[0].eventId, "evt-open");
    assert.equal(updated[0].summary, "Новое название");
    assert.equal(updated[0].from, "2026-09-19T19:30:00+03:00");
  } finally { cleanup(fx); }
});
