function localClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    minutes: Number(map.hour) * 60 + Number(map.minute)
  };
}

function reminderMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) throw new Error("reminderTime must be HH:MM");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("reminderTime must be HH:MM");
  return hour * 60 + minute;
}

function ruDate(value) {
  const [y, m, d] = String(value).slice(0, 10).split("-");
  return y && m && d ? `${d}.${m}.${y}` : String(value);
}function reminderText(row, now, localDate, timeZone) {
  const allDay = Number(row.allDay) === 1;
  const overdue = allDay
    ? String(row.dueAt).slice(0, 10) < localDate
    : new Date(row.dueAt).getTime() < now.getTime();
  if (overdue) return `⚠️ Просрочено: ${row.title}`;
  if (allDay && String(row.dueAt).slice(0, 10) === localDate) {
    return `⏰ Сегодня: ${row.title}`;
  }
  if (allDay) return `✅ Дело до ${ruDate(row.dueAt)}: ${row.title}`;
  const due = new Date(row.dueAt);
  const stamp = new Intl.DateTimeFormat("ru-RU", {
    timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(due);
  return `✅ Дело до ${stamp}: ${row.title}`;
}

export function enqueueDailyActionReminders(db, {
  now = new Date(), timeZone = "Europe/Moscow", reminderTime = "09:00"
} = {}) {
  const clock = localClock(now, timeZone);
  if (clock.minutes < reminderMinutes(reminderTime)) return 0;
  const rows = db.prepare(`SELECT id,title,due_at AS dueAt,all_day AS allDay,assignee_id AS assigneeId
    FROM actions WHERE status='open' AND assignee_id IS NOT NULL AND due_at IS NOT NULL`).all();
  const insert = db.prepare(`INSERT OR IGNORE INTO outbox
    (dedupe_key,recipient_member_id,kind,payload_json,available_at) VALUES (?,?,?,?,?)`);
  const availableAt = now.toISOString();
  let created = 0;  for (const row of rows) {
    const key = `reminder:action:${row.id}:${clock.date}`;
    const payload = JSON.stringify({ text: reminderText(row, now, clock.date, timeZone) });
    const result = insert.run(key, row.assigneeId, "text", payload, availableAt);
    if (Number(result.changes) === 1) created += 1;
  }
  return created;
}
