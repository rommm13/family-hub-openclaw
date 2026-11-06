import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createFamilyTool } from "../dist/tool.js";
import { createCalendarOutboxHandlers, createFamilyRuntime, processOutboxOnce } from "../dist/index.js";
import { syncActionCalendar, syncFamilyEventCalendar, reconcileFamilyCalendarEvents } from "../dist/calendar.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-cal-mh-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [{ id: "member-a", name: "Участник A", role: "parent" }],
    bindings: [{ runtimeId: "family-agent", agentId: "main", memberId: "member-a" }]
  });
  return { dir, db };
}
function cleanup(fx) { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }

function tool(db) {
  return createFamilyTool({
    db, runtimeId: "family-agent", agentId: "main",
    now: () => Date.parse("2026-09-19T00:00:00Z"),
    toolContext: {
      senderIsOwner: true, messageChannel: "telegram", agentId: "main",
      sessionKey: "agent:main:telegram:direct:123"
    }
  });
}

function makeSpyCalendar(overrides = {}) {
  const calls = [];
  const calendar = {
    calls,
    async listUpcomingEvents(input) { calls.push(["listUpcomingEvents", input]); return overrides.listUpcomingEvents ? overrides.listUpcomingEvents(input) : []; },
    async getEvent(input) { calls.push(["getEvent", input]); return overrides.getEvent ? overrides.getEvent(input) : null; },
    async ensureEvent(input) { calls.push(["ensureEvent", input]); return overrides.ensureEvent ? overrides.ensureEvent(input) : { id: "spy-evt", created: true }; },
    async updateEvent(input) { calls.push(["updateEvent", input]); return overrides.updateEvent ? overrides.updateEvent(input) : { id: input.eventId }; },
    async deleteEvent(input) { calls.push(["deleteEvent", input]); return overrides.deleteEvent ? overrides.deleteEvent(input) : { id: input.eventId, deleted: true }; }
  };
  return calendar;
}

async function clickUi(runtime, payload) {
  const edits = [];
  await runtime.interactive.handler({
    sessionKey: "agent:main:telegram:direct:123",
    auth: { isAuthorizedSender: true }, callback: { payload },
    respond: { async editMessage(v) { edits.push(v); }, async reply() {} }
  });
  return edits.at(-1);
}

test("1 household: core/outbox/UI calendar paths work; 1->2 households gates all paths dynamically with no remote calls/merges", async () => {
  const fx = fixture();
  try {
    const calendar = makeSpyCalendar({
      listUpcomingEvents: async () => [{ id: "g1", summary: "Remote", start: "2026-09-21", allDay: true, entityType: "family_event", entityId: "fe-1" }]
    });
    const t = tool(fx.db);

    const actionRes = await t.execute("mh-a1", { action: "create_action", title: "Дело", assigneeId: "member-a", dueAt: "2026-09-18" });
    const actionId = actionRes.details.value.id;
    const eventRes = await t.execute("mh-e1", { action: "create_calendar_event", title: "Событие", startAt: "2026-09-21" });
    const familyEventId = eventRes.details.value.id;

    await syncActionCalendar({ db: fx.db, calendar, calendarId: "family-cal", actionId });
    assert.equal(calendar.calls.some(c => c[0] === "ensureEvent"), true, "ensureEvent called with 1 household");
    assert.equal(fx.db.prepare("SELECT google_event_id AS id FROM actions WHERE id=?").get(actionId).id, "spy-evt");

    calendar.calls.length = 0;
    await syncFamilyEventCalendar({ db: fx.db, calendar, calendarId: "family-cal", eventId: familyEventId });
    assert.equal(calendar.calls.some(c => c[0] === "ensureEvent"), true, "family event sync called with 1 household");

    fx.db.prepare("UPDATE family_events SET google_event_id='g-merge',title='Old' WHERE id=?").run(familyEventId);
    calendar.calls.length = 0;
    const rec = await reconcileFamilyCalendarEvents({
      db: fx.db, calendar: makeSpyCalendar({ getEvent: async () => ({ id: "g-merge", summary: "Merged", start: "2026-09-22", end: "2026-09-23", allDay: true, description: null }) }),
      calendarId: "family-cal", from: "2026-09-18", to: "2027-09-18"
    });
    assert.equal(rec.updated, 1);
    assert.equal(fx.db.prepare("SELECT title FROM family_events WHERE id=?").get(familyEventId).title, "Merged");

    const handlers = createCalendarOutboxHandlers({ db: fx.db, calendar, calendarId: "family-cal" });
    calendar.calls.length = 0;
    await handlers.calendar_action_upsert({ kind: "calendar_action_upsert", payload: { entityId: actionId } });
    await handlers.calendar_event_upsert({ kind: "calendar_event_upsert", payload: { entityId: familyEventId } });
    assert.equal(calendar.calls.filter(c => c[0] === "updateEvent" || c[0] === "ensureEvent").length >= 1, true);

    const runtime1 = createFamilyRuntime({ db: fx.db, runtimeId: "family-agent", agentId: "main", calendar, calendarId: "family-cal", now: () => Date.parse("2026-09-17T09:00:00Z") });
    calendar.calls.length = 0;
    const dash = await runtime1.beforeDispatch({ channel: "telegram", content: "🏠 Семья" }, { sessionKey: "agent:main:telegram:direct:123", agentId: "main", conversationId: "123", accountId: "default" });
    assert.equal(dash?.handled, true);
    assert.equal(calendar.calls.some(c => c[0] === "listUpcomingEvents"), true, "dashboard reads remote with 1 household");

    calendar.calls.length = 0;
    await clickUi(runtime1, "section:calendar");
    assert.equal(calendar.calls.some(c => c[0] === "listUpcomingEvents" || c[0] === "getEvent"), true, "calendar UI reads/reconciles with 1 household");

    fx.db.prepare("DELETE FROM outbox WHERE kind IN ('calendar_action_upsert','calendar_event_upsert')").run();
    fx.db.prepare("INSERT INTO households(id,name) VALUES (?,?)").run("home2", "Другая семья");
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS c FROM households").get().c, 2);

    const titleBefore = fx.db.prepare("SELECT title FROM family_events WHERE id=?").get(familyEventId).title;
    calendar.calls.length = 0;
    await assert.rejects(() => syncActionCalendar({ db: fx.db, calendar, calendarId: "family-cal", actionId }), /calendar blocked: multiple households/);
    await assert.rejects(() => syncFamilyEventCalendar({ db: fx.db, calendar, calendarId: "family-cal", eventId: familyEventId }), /calendar blocked: multiple households/);
    const recBlocked = await reconcileFamilyCalendarEvents({
      db: fx.db, calendar, calendarId: "family-cal", from: "2026-09-18", to: "2027-09-18"
    });
    assert.equal(recBlocked.blocked, true);
    assert.equal(recBlocked.checked, 0);
    assert.equal(calendar.calls.length, 0, "no remote calls after 1->2 transition (direct paths)");
    assert.equal(fx.db.prepare("SELECT title FROM family_events WHERE id=?").get(familyEventId).title, titleBefore, "no remote merge");

    calendar.calls.length = 0;
    const nowIso = "2099-09-16T15:00:00.000Z";
    fx.db.prepare(`INSERT OR IGNORE INTO outbox(dedupe_key,recipient_member_id,kind,payload_json,available_at,status)
      VALUES (?,?,?,?,?, 'pending')`).run("mh:block:a", "member-a", "calendar_action_upsert", JSON.stringify({ entityId: actionId }), nowIso);
    fx.db.prepare(`INSERT OR IGNORE INTO outbox(dedupe_key,recipient_member_id,kind,payload_json,available_at,status)
      VALUES (?,?,?,?,?, 'pending')`).run("mh:block:e", "member-a", "calendar_event_upsert", JSON.stringify({ entityId: familyEventId }), nowIso);
    const blockedHandlers = createCalendarOutboxHandlers({ db: fx.db, calendar, calendarId: "family-cal" });
    const res1 = await processOutboxOnce({ db: fx.db, workerId: "w1", runtimeId: "family-agent", agentId: "main", now: nowIso, send: async () => {}, handlers: blockedHandlers });
    const res2 = await processOutboxOnce({ db: fx.db, workerId: "w2", runtimeId: "family-agent", agentId: "main", now: nowIso, send: async () => {}, handlers: blockedHandlers });
    assert.notEqual(res1.status, "sent");
    assert.notEqual(res2.status, "sent");
    assert.ok(["retry", "dead"].includes(res1.status));
    assert.ok(["retry", "dead"].includes(res2.status));
    const outRows = fx.db.prepare("SELECT dedupe_key AS k,status,last_error AS err FROM outbox WHERE dedupe_key IN ('mh:block:a','mh:block:e') ORDER BY id").all();
    assert.equal(outRows.every(r => r.status !== "sent"), true, "blocked outbox jobs not marked sent");
    assert.equal(outRows.every(r => /multiple households/i.test(String(r.err))), true, "blocked outbox jobs have clear error");
    assert.equal(calendar.calls.length, 0, "no remote calls from blocked outbox handlers");

    fx.db.prepare("UPDATE actions SET due_at='2026-09-17' WHERE id=?").run(actionId);
    calendar.calls.length = 0;
    const runtime2 = createFamilyRuntime({ db: fx.db, runtimeId: "family-agent", agentId: "main", calendar, calendarId: "family-cal", now: () => Date.parse("2026-09-17T09:00:00Z") });
    const dash2 = await runtime2.beforeDispatch({ channel: "telegram", content: "🏠 Семья" }, { sessionKey: "agent:main:telegram:direct:123", agentId: "main", conversationId: "123", accountId: "default" });
    assert.equal(dash2?.handled, true);
    assert.equal(calendar.calls.some(c => c[0] === "listUpcomingEvents"), false, "dashboard no remote read when blocked");
    assert.match(dash2.text, /Привет, Участник A/, "local household data remains in dashboard");

    calendar.calls.length = 0;
    const calBlocked = await clickUi(runtime2, "section:calendar");
    assert.equal(calendar.calls.length, 0, "calendar UI no remote reads/reconcile when blocked");
    assert.ok(calBlocked?.text, "calendar UI returns safe response");
    assert.doesNotMatch(calBlocked.text, /Remote/, "no remote cache merged into UI");
    assert.equal(fx.db.prepare("SELECT title FROM family_events WHERE id=?").get(familyEventId).title, titleBefore, "local event unchanged by UI");
  } finally { cleanup(fx); }
});
