import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const execFilePromise = promisify(nodeExecFile);

export function createGwsCliRunner({ command = "gws", env = process.env, execFile = execFilePromise } = {}) {
  return async (args) => {
    const { stdout = "" } = await execFile(command, args, {
      env, shell: false, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    const raw = String(stdout).trim();
    if (!raw) return {};
    try { return JSON.parse(raw); }
    catch { throw new Error("invalid gws JSON response"); }
  };
}

export function isCalendarGateOpen(db, calendarId) {
  if (!calendarId) return false;
  const row = db.prepare("SELECT COUNT(*) AS c FROM households").get();
  return Number(row?.c) === 1;
}

function assertCalendarGateOpen(db, calendarId) {
  if (!isCalendarGateOpen(db, calendarId)) {
    throw new Error("calendar blocked: multiple households");
  }
}

function eventRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.events)) return value.events;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function resultId(value) {
  return value?.id ?? value?.event?.id ?? value?.result?.id ?? null;
}

function isCalendarNotFound(error) {
  const code = Number(error?.code ?? error?.status ?? error?.response?.status);
  return code === 404 || /(?:404|not found)/iu.test(String(error?.message ?? error));
}

function normalizeCalendarEvent(row) {
  if (!row || row.status === "cancelled") return null;
  const allDay = typeof row?.start?.date === "string";
  const start = allDay ? row.start.date : row?.start?.dateTime ?? null;
  const end = allDay ? row?.end?.date ?? null : row?.end?.dateTime ?? null;
  if (!start) return null;
  const meta = row?.extendedProperties?.private ?? {};
  return {
    id: resultId(row), summary: String(row?.summary ?? "Без названия").trim() || "Без названия",
    start: String(start), allDay,
    ...(end ? { end: String(end) } : {}),
    ...(row?.description != null ? { description: row.description } : {}),
    ...(meta.entityType && meta.entityId ? { entityType: meta.entityType, entityId: meta.entityId } : {})
  };
}

function normalizeUpcomingEvent(row) {
  return normalizeCalendarEvent(row);
}

function eventStartMs(event) {
  const raw = event?.start;
  const date = event?.allDay ? new Date(`${raw}T00:00:00Z`) : new Date(raw);
  return date.getTime();
}

function eventBody({ entityType, entityId, summary, from, to, allDay = false, description = undefined }) {
  return {
    summary,
    ...(description === undefined ? {} : { description }),
    start: allDay ? { date: from } : { dateTime: from },
    end: allDay ? { date: to } : { dateTime: to },
    extendedProperties: { private: {
      familyHub: "true",
      entityType: String(entityType),
      entityId: String(entityId)
    } }
  };
}

export function createGwsCalendarAdapter({ run, calendarId }) {
  if (typeof run !== "function") throw new TypeError("calendar run function is required");
  if (!calendarId) throw new TypeError("calendarId is required");

  async function findEvent({ entityType, entityId, from, to }) {
    const params = {
      calendarId,
      timeMin: from,
      timeMax: to,
      singleEvents: true,
      maxResults: 1,
      privateExtendedProperty: [
        "familyHub=true", `entityType=${entityType}`, `entityId=${entityId}`
      ]
    };
    const result = await run(["calendar", "events", "list", "--params", JSON.stringify(params)]);
    return eventRows(result)[0] ?? null;
  }

  async function createEvent(input) {
    const params = { calendarId, sendUpdates: "none" };
    const result = await run([
      "calendar", "events", "insert",
      "--params", JSON.stringify(params),
      "--json", JSON.stringify(eventBody(input))
    ]);
    const id = resultId(result);
    if (!id) throw new Error("gws calendar insert returned no event id");
    return id;
  }

  return {
    async getEvent({ eventId }) {
      try {
        const result = await run(["calendar", "events", "get", "--params", JSON.stringify({ calendarId, eventId })]);
        const row = result?.event ?? result?.result ?? result;
        return normalizeCalendarEvent(row);
      } catch (error) {
        if (isCalendarNotFound(error)) return null;
        throw error;
      }
    },
    async listUpcomingEvents({ from = new Date().toISOString(), max = 10 } = {}) {
      const limit = Math.max(1, Math.min(50, Number(max) || 10));
      const params = {
        calendarId,
        timeMin: from,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: limit
      };
      const result = await run(["calendar", "events", "list", "--params", JSON.stringify(params)]);
      const fromMs = new Date(from).getTime();
      return eventRows(result)
        .map(normalizeUpcomingEvent)
        .filter(Boolean)
        .filter(event => Number.isNaN(fromMs) || eventStartMs(event) >= fromMs)
        .sort((a, b) => eventStartMs(a) - eventStartMs(b))
        .slice(0, limit);
    },
    async ensureEvent(input) {
      const existing = await findEvent(input);
      if (existing?.id) return { id: existing.id, created: false };
      const id = await createEvent(input);
      return { id, created: true };
    },
    async updateEvent({ eventId, ...input }) {
      const params = { calendarId, eventId, sendUpdates: "none" };
      const result = await run([
        "calendar", "events", "patch",
        "--params", JSON.stringify(params),
        "--json", JSON.stringify(eventBody(input))
      ]);
      return { id: resultId(result) ?? eventId };
    },
    async deleteEvent({ eventId }) {
      const output = `/tmp/family-gws-delete-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.out`;
      try {
        await run([
          "calendar", "events", "delete",
          "--params", JSON.stringify({ calendarId, eventId, sendUpdates: "none" }),
          "--output", output
        ]);
      } finally {
        try { fs.rmSync(output, { force: true }); } catch {}
      }
      return { id: eventId, deleted: true };
    }
  };
}

function actionWindow(dueAt) {
  const raw = String(dueAt ?? "").trim();
  if (!raw) throw new Error("dated action has no dueAt");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(raw + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return { from: raw, to: d.toISOString().slice(0, 10), allDay: true };
  }
  const start = new Date(raw);
  if (Number.isNaN(start.getTime())) throw new Error("invalid action dueAt");
  return {
    from: raw,
    to: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
    allDay: false
  };
}

export async function syncActionCalendar({ db, calendar, calendarId, actionId }) {
  assertCalendarGateOpen(db, calendarId);
  const action = db.prepare(
    "SELECT id,title,due_at AS dueAt,status,google_event_id AS googleEventId FROM actions WHERE id=?"
  ).get(actionId);
  if (!action) throw new Error("Action not found");
  const window = actionWindow(action.dueAt);
  const summary = action.status === "completed" ? `✅ ${action.title}` : action.status === "cancelled" ? `❌ ${action.title}` : action.title;
  const input = { entityType: "action", entityId: action.id, summary, ...window };
  let eventId = action.googleEventId ?? null;
  let created = false;
  if (eventId && typeof calendar.updateEvent === "function") {
    try {
      await calendar.updateEvent({ eventId, ...input });
    } catch (error) {
      if (!isCalendarNotFound(error)) throw error;
      const ensured = await calendar.ensureEvent(input);
      eventId = ensured.id;
      created = ensured.created === true;
      if (eventId && !created && typeof calendar.updateEvent === "function") {
        await calendar.updateEvent({ eventId, ...input });
      }
    }
  } else {
    const ensured = await calendar.ensureEvent(input);
    eventId = ensured.id;
    created = ensured.created === true;
    if (eventId && !created && typeof calendar.updateEvent === "function") {
      await calendar.updateEvent({ eventId, ...input });
    }
  }
  if (!eventId) throw new Error("calendar sync returned no event id");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE actions SET google_event_id=? WHERE id=?").run(eventId, action.id);
    db.prepare(`INSERT INTO calendar_links(entity_type,entity_id,google_event_id,calendar_id,sync_status)
      VALUES ('action',?,?,?,'synced')
      ON CONFLICT(entity_type,entity_id) DO UPDATE SET
      google_event_id=excluded.google_event_id,calendar_id=excluded.calendar_id,sync_status='synced'`)
      .run(action.id, eventId, calendarId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { eventId, created };
}

export async function syncFamilyEventCalendar({ db, calendar, calendarId, eventId }) {
  assertCalendarGateOpen(db, calendarId);
  const row = db.prepare(`SELECT id,title,start_at AS startAt,end_at AS endAt,all_day AS allDay,description,
    google_event_id AS googleEventId,status FROM family_events WHERE id=?`).get(eventId);
  if (!row) throw new Error("Family event not found");
  const input = {
    entityType: "family_event", entityId: row.id, summary: row.title,
    from: row.startAt, to: row.endAt, allDay: Number(row.allDay) === 1,
    description: row.description ?? undefined
  };
  let googleEventId = row.googleEventId ?? null;
  if (row.status === "cancelled") {
    if (googleEventId && typeof calendar.deleteEvent === "function") {
      try { await calendar.deleteEvent({ eventId: googleEventId }); }
      catch (error) { if (!isCalendarNotFound(error)) throw error; }
    }
    db.prepare(`INSERT INTO calendar_links(entity_type,entity_id,google_event_id,calendar_id,sync_status)
      VALUES ('family_event',?,?,?,'cancelled')
      ON CONFLICT(entity_type,entity_id) DO UPDATE SET sync_status='cancelled',calendar_id=excluded.calendar_id`).run(
        row.id, googleEventId ?? `cancelled:${row.id}`, calendarId
      );
    return { eventId: googleEventId, deleted: Boolean(googleEventId) };
  }
  if (googleEventId) {
    try {
      await calendar.updateEvent({ eventId: googleEventId, ...input });
    } catch (error) {
      if (!isCalendarNotFound(error)) throw error;
      const ensured = await calendar.ensureEvent(input);
      googleEventId = ensured.id;
    }
  } else {
    const ensured = await calendar.ensureEvent(input);
    googleEventId = ensured.id;
  }
  if (!googleEventId) throw new Error("calendar sync returned no family event id");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE family_events SET google_event_id=? WHERE id=?").run(googleEventId, row.id);
    db.prepare(`INSERT INTO calendar_links(entity_type,entity_id,google_event_id,calendar_id,sync_status)
      VALUES ('family_event',?,?,?,'synced')
      ON CONFLICT(entity_type,entity_id) DO UPDATE SET
      google_event_id=excluded.google_event_id,calendar_id=excluded.calendar_id,sync_status='synced'`)
      .run(row.id, googleEventId, calendarId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { eventId: googleEventId };
}


export async function reconcileFamilyCalendarEvents({ db, calendar, calendarId, from, to, limit = 50 }) {
  if (!isCalendarGateOpen(db, calendarId)) return { checked: 0, updated: 0, deleted: 0, blocked: true };
  if (!calendar || typeof calendar.getEvent !== "function") return { checked: 0, updated: 0, deleted: 0 };
  const rows = db.prepare(`SELECT id,title,start_at AS startAt,end_at AS endAt,all_day AS allDay,description,google_event_id AS googleEventId
    FROM family_events
    WHERE status='active' AND google_event_id IS NOT NULL AND start_at>=? AND start_at<=?
    ORDER BY start_at LIMIT ?`).all(from, to, Math.max(1, Math.min(200, Number(limit) || 50)));
  let updated = 0; let deleted = 0;
  for (const row of rows) {
    const remote = await calendar.getEvent({ eventId: row.googleEventId });
    if (!remote) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE family_events SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'").run(row.id);
        db.prepare(`INSERT INTO calendar_links(entity_type,entity_id,google_event_id,calendar_id,sync_status)
          VALUES ('family_event',?,?,?,'deleted_remote')
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET google_event_id=excluded.google_event_id,calendar_id=excluded.calendar_id,sync_status='deleted_remote'`)
          .run(row.id, row.googleEventId, calendarId);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      deleted += 1;
      continue;
    }
    const next = {
      title: remote.summary,
      startAt: remote.start,
      endAt: remote.end,
      allDay: remote.allDay ? 1 : 0,
      description: remote.description ?? null
    };
    const changed = row.title !== next.title || row.startAt !== next.startAt || (row.endAt ?? null) !== (next.endAt ?? null) || Number(row.allDay) !== next.allDay || (row.description ?? null) !== next.description;
    if (changed) {
      db.prepare(`UPDATE family_events SET title=?,start_at=?,end_at=?,all_day=?,description=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(next.title, next.startAt, next.endAt, next.allDay, next.description, row.id);
      updated += 1;
    }
    db.prepare(`INSERT INTO calendar_links(entity_type,entity_id,google_event_id,calendar_id,sync_status)
      VALUES ('family_event',?,?,?,'synced')
      ON CONFLICT(entity_type,entity_id) DO UPDATE SET google_event_id=excluded.google_event_id,calendar_id=excluded.calendar_id,sync_status='synced'`)
      .run(row.id, row.googleEventId, calendarId);
  }
  return { checked: rows.length, updated, deleted };
}
