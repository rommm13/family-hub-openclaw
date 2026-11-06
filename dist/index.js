import { randomUUID } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import {
  openFamilyDb, resolveMemberForAgent, upsertMemberRoute, getMemberRoute,
  getMemberKeyboardInstalledAt, markMemberKeyboardInstalled,
  claimDueOutbox, markOutboxSent, markOutboxFailed, enqueueOutbox
} from "./db.js";
import { listSection, searchNotes, getPollForViewer, createCapsule, unlockCapsule, getFamilyCalendarEvent } from "./domain.js";
import { createFamilyTool, executeFamilyAction } from "./tool.js";
import { createGwsCliRunner, createGwsCalendarAdapter, syncActionCalendar, syncFamilyEventCalendar, reconcileFamilyCalendarEvents, isCalendarGateOpen } from "./calendar.js";
import { enqueueDailyActionReminders } from "./reminders.js";
import { selectManualSurprise, releaseManualSurprise, stageSurpriseAsset } from "./surprises.js";
import { familyMiniapp } from "../miniapp/api.mjs";
import { createFamilyNotifications } from "../miniapp/push-notify.mjs";
import {
  CARD_TITLE, SECTION_META, HELP_TEXT,
  card, hand, bullet, safe, code, safeUrl, title as sectionTitle, metaLine, countLabel,
  emptyNote, emptyCard, loadingCard, errorCard,
  mainNavigationButtons, moreNavigationButtons
} from "./theme.js";

const DEFAULT_BUTTON = CARD_TITLE;
const NAV_ONLY_SECTIONS = new Set(["more", "help", "surprise"]);
const SECTIONS = Object.entries(SECTION_META)
  .filter(([key]) => !NAV_ONLY_SECTIONS.has(key))
  .map(([key, meta]) => [key, `${meta.icon} ${meta.label}`]);
const SECTION_LABELS = new Map(SECTIONS);

function mainButtons() {
  return mainNavigationButtons();
}

function moreView() {
  return {
    text: card({
      heading: sectionTitle("more"),
      meta: SECTION_META.more.hint,
      body: hand("Планы, цели, голосования и капсулы")
    }),
    buttons: moreNavigationButtons()
  };
}

function helpView() {
  return {
    text: HELP_TEXT,
    buttons: [[
      { text: "‹ К семье", callback_data: "family:menu" },
      { text: "👋 Закрыть", callback_data: "family:close" }
    ]]
  };
}

export function buildMainMenu(member) {
  return {
    text: card({ heading: `**${CARD_TITLE}**`, meta: "семейный хаб", body: hand("Выбирай раздел ниже"), showRule: false }),
    channelData: { telegram: { buttons: mainButtons() } }
  };
}
function resolveMember(db, runtimeId, agentId) {
  const actual = String(agentId ?? "").trim();
  return actual ? resolveMemberForAgent(db, runtimeId, actual) : null;
}

function fmtDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString("ru-RU");
}

function navigationButtons() {
  return [[
    { text: "‹ К семье", callback_data: "family:menu" },
    { text: "👋 Закрыть", callback_data: "family:close" }
  ]];
}

const CREATE_LABELS = {
  actions: "➕ Добавить дело",
  shopping: "＋ Добавить",
  notes: "➕ Новая заметка",
  wishes: "➕ Добавить желание",
  places: "➕ Добавить место",
  plans: "➕ Новый план",
  polls: "➕ Новое голосование",
  capsules: "➕ Новая капсула",
  goals: "➕ Новая цель"
};

function shortButtonText(value, max = 46) {
  const text = String(value ?? "Без названия").replace(/\s+/g, " ").trim() || "Без названия";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function itemButtonText(section, row) {
  if (section === "actions") return `${row.status === "completed" ? "✅" : "☑️"} ${shortButtonText(row.title)}`;
  if (section === "shopping") return `${row.checked ? "●" : "○"} ${shortButtonText(row.name)}`;
  if (section === "notes") return `📝 ${shortButtonText(row.title)}`;
  if (section === "wishes") return `🎁 ${shortButtonText(row.title)}`;
  if (section === "places") return `📍 ${shortButtonText(row.name)}`;
  if (section === "plans") return `🧳 ${shortButtonText(row.title)}`;
  if (section === "polls") return `🗳 ${shortButtonText(row.question)}`;
  if (section === "capsules") return `⏳ ${shortButtonText(fmtDate(row.unlockAt))}`;
  if (section === "cashback") return `💳 ${shortButtonText(row.title)}`;
  if (section === "goals") return `💰 ${shortButtonText(row.title)}`;
  return shortButtonText(row.title ?? row.name ?? row.question);
}

function sectionButtons(section, rows) {
  const buttons = [];
  const createLabel = CREATE_LABELS[section];
  if (section === "shopping") {
    buttons.push([{ text: createLabel, callback_data: "family:create:shopping" }]);
    for (const row of rows) buttons.push([{ text: itemButtonText(section, row), callback_data: `family:shopping:toggle:${row.id}` }]);
    if (rows.some(row => row.checked)) buttons.push([{ text: "✓ Убрать купленное", callback_data: "family:shopping:clear" }]);
    buttons.push(...navigationButtons());
    return buttons;
  }
  if (createLabel) {
    const firstRow = [{ text: createLabel, callback_data: `family:create:${section}` }];
    if (section === "notes") firstRow.push({ text: "🔎 Поиск", callback_data: "family:search:notes" });
    buttons.push(firstRow);
  }
  for (const row of rows) {
    if (!row?.id) continue;
    buttons.push([{ text: itemButtonText(section, row), callback_data: `family:item:${section}:${row.id}` }]);
  }
  buttons.push(...navigationButtons());
  return buttons;
}

function isSkip(value) {
  return /^(?:-|пропустить|нет|не надо|без комментария)$/iu.test(String(value ?? "").trim());
}

function localDateParts(value, timeZone = "Europe/Moscow") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(value)).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function addLocalDays(parts, days) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function dateString(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function parseWizardDate(value, nowValue, { allowUndated = false } = {}) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/ё/g, "е");
  if (allowUndated && /^(?:без срока|когда-нибудь|когда нибудь)$/u.test(raw)) return null;
  const today = localDateParts(nowValue);
  let parts = null; let time = null;
  let m = /^(сегодня|завтра)(?:\s+(\d{1,2}):(\d{2}))?$/u.exec(raw);
  if (m) {
    parts = addLocalDays(today, m[1] === "завтра" ? 1 : 0);
    if (m[2]) time = [Number(m[2]), Number(m[3])];
  }
  if (!parts) {
    m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?:\s+(\d{1,2}):(\d{2}))?$/u.exec(raw);
    if (m) {
      parts = { year: Number(m[3] ?? today.year), month: Number(m[2]), day: Number(m[1]) };
      if (m[4]) time = [Number(m[4]), Number(m[5])];
    }
  }
  if (!parts) {
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[t\s](\d{2}):(\d{2})(?::\d{2})?(?:[+-]\d{2}:?\d{2}|z)?)?$/iu.exec(raw);
    if (m) {
      parts = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
      if (m[4]) time = [Number(m[4]), Number(m[5])];
    }
  }
  if (!parts) return undefined;
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month || check.getUTCDate() !== parts.day) return undefined;
  if (!time) return dateString(parts);
  if (time[0] > 23 || time[1] > 59) return undefined;
  return `${dateString(parts)}T${String(time[0]).padStart(2, "0")}:${String(time[1]).padStart(2, "0")}:00+03:00`;
}

function wizardButtons() {
  return [[
    { text: "✖ Отмена", callback_data: "family:wizard:cancel" },
    { text: "🏠 Меню", callback_data: "family:menu" }
  ]];
}

function promptCard(icon, heading, question, hint = "") {
  return card({
    heading: `**${icon} ${safe(heading)}**`,
    meta: "новый шаг",
    body: [safe(question), hint ? hand(hint) : ""].filter(Boolean).join("\n\n")
  });
}

function startPrompt(section, mode = "create") {
  if (mode === "search") return promptCard("🔎", "Поиск заметок", "Что найти?");
  const prompts = {
    shopping: ["🛒", "Купить", "Что добавить? Можно несколько через запятую или с новой строки.", "Например: молоко, хлеб, корм"],
    notes: ["📝", "Новая заметка", "Название?"],
    wishes: ["🎁", "Новое желание", "Что хочешь?"],
    places: ["📍", "Новое место", "Название места?"],
    plans: ["🧳", "Новый план", "Название?"],
    polls: ["💬", "Новое голосование", "Вопрос?"],
    capsules: ["📦", "Новая капсула", "Кому открыть?", "Напиши имя члена семьи"],
    calendar: ["🗓", "Новое событие", "Название события?"],
    goals: ["🌱", "Новая цель", "Название цели?"],
    actions: ["📌", "Новое дело", "Что нужно сделать?"]
  };
  const entry = prompts[section];
  return entry ? promptCard(entry[0], entry[1], entry[2], entry[3] ?? "") : null;
}

function parseOptions(value) {
  return String(value ?? "").split(/[\n,;]+/u).map(v => v.trim()).filter(Boolean);
}

function editPrompt(section) {
  const prompts = {
    notes: "Новое название? Напиши «-», чтобы оставить прежнее.",
    wishes: "Новое название? «-» оставить прежнее.",
    places: "Новое название? «-» оставить прежнее.",
    plans: "Новое название? «-» оставить прежнее.",
    goals: "Новое название? «-» оставить прежнее.",
    actions: "Новое название? «-» оставить прежнее.",
    calendar: "Новое название? «-» оставить прежнее."
  };
  const question = prompts[section];
  return question ? promptCard("✏️", `Правка · ${SECTION_META[section]?.label ?? section}`, question) : null;
}

function formatCalendarStart(event, timeZone) {
  const raw = String(event?.start ?? "");
  if (event?.allDay && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw.slice(8, 10)}.${raw.slice(5, 7)}`;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", {
    timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.day}.${parts.month} ${parts.hour}:${parts.minute}`;
}

function localDateKey(value, timeZone) {
  const date = new Date(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayLabel(stamp, timeZone) {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone, weekday: "long", day: "numeric", month: "long"
    }).format(new Date(stamp));
  } catch {
    return "";
  }
}

async function dashboardView(db, member, calendar, calendarId, now, timeZone) {
  const lines = [];
  const stamp = Number(now());
  const today = localDateKey(stamp, timeZone);
  if ((!calendarId || isCalendarGateOpen(db, calendarId)) && calendar && typeof calendar.listUpcomingEvents === "function") {
    try {
      const events = await calendar.listUpcomingEvents({ from: new Date(stamp).toISOString(), max: 1 });
      if (events[0]) lines.push(`🗓 ${formatCalendarStart(events[0], timeZone)} · ${safe(events[0].summary)}`);
    } catch {}
  }
  const actions = listSection(db, "actions", member.id, 50)
    .filter(row => row.dueAt && String(row.dueAt).slice(0, 10) <= today)
    .slice(0, 3);
  for (const row of actions) lines.push(`☑️ ${safe(row.title)}`);
  const shopping = listSection(db, "shopping", member.id, 100).filter(row => !row.checked);
  if (shopping.length) lines.push(`🛒 Купить · ${shopping.length}`);
  const body = lines.length
    ? [`**Сегодня**`, bullet(lines), hand(`Привет, ${member.name}`)].join("\n\n")
    : hand("На сегодня пусто. Самое время что-то добавить");
  return {
    text: card({ heading: `**${CARD_TITLE}**`, meta: dayLabel(stamp, timeZone), body }),
    channelData: { telegram: { buttons: mainButtons() } }
  };
}

async function calendarView(db, calendar, calendarId, now, timeZone) {
  const buttons = [[{ text: "➕ Событие", callback_data: "family:create:calendar" }], ...navigationButtons()];
  if (calendarId && !isCalendarGateOpen(db, calendarId)) {
    return { text: errorCard("calendar"), buttons };
  }
  if (!calendar || typeof calendar.listUpcomingEvents !== "function") {
    return { text: errorCard("calendar"), buttons };
  }
  try {
    const from = new Date(now()).toISOString();
    const rows = await calendar.listUpcomingEvents({ from, max: 10 });
    const itemButtons = rows
      .filter(event => event.entityType === "family_event" && event.entityId)
      .map(event => [{ text: `📅 ${shortButtonText(event.summary)}`, callback_data: `family:item:calendar:${event.entityId}` }]);
    return {
      text: rows.length
        ? card({
          sectionKey: "calendar",
          meta: countLabel("calendar", rows.length),
          body: bullet(rows.map(event => `${formatCalendarStart(event, timeZone)} · ${safe(event.summary)}`))
        })
        : emptyCard("calendar"),
      buttons: [buttons[0], ...itemButtons, ...buttons.slice(1)]
    };
  } catch {
    return { text: errorCard("calendar"), buttons };
  }
}

function renderRows(section, rows) {
  if (!rows.length) return hand(emptyNote(section));
  if (section === "actions") return bullet(rows.map(r => `${safe(r.title)}${r.dueAt ? ` · до ${fmtDate(r.dueAt)}` : ""}`));
  if (section === "shopping") return rows.map(r => `${r.checked ? "●" : "○"} ${safe(r.name)}`).join("\n");
  if (section === "notes") return bullet(rows.map(r => safe(r.title)));
  if (section === "wishes") return bullet(rows.map(r => `${safe(r.title)}${r.targetPrice ? ` · ${r.targetPrice.toLocaleString("ru-RU")} ₽` : ""}`));
  if (section === "places") return bullet(rows.map(r => safe(r.name)));
  if (section === "plans") return bullet(rows.map(r => safe(r.title)));
  if (section === "polls") return bullet(rows.map(r => safe(r.question)));
  if (section === "capsules") return bullet(rows.map(r => `Капсула · ${fmtDate(r.unlockAt)}`));
  if (section === "cashback") return `${safe(rows[0].title)}\n\n${safe(rows[0].body)}`;
  if (section === "goals") return bullet(rows.map(r => `${Number(r.amount).toLocaleString("ru-RU")} ${safe(r.currency)} · ${safe(r.title)} · до ${fmtDate(r.dueAt)}`));
  return hand(emptyNote(section));
}

function planningView(db, member) {
  const plans = listSection(db, "plans", member.id, 20);
  const places = listSection(db, "places", member.id, 20);
  const goals = listSection(db, "goals", member.id, 20);
  const block = (heading, section, rows) => [
    `**${heading}**`,
    rows.length ? renderRows(section, rows) : hand(emptyNote(section))
  ].join("\n");
  const buttons = [
    [
      { text: "＋ План", callback_data: "family:create:plans" },
      { text: "＋ Место", callback_data: "family:create:places" }
    ],
    [{ text: "＋ Цель", callback_data: "family:create:goals" }]
  ];
  for (const row of plans) buttons.push([{ text: itemButtonText("plans", row), callback_data: `family:item:plans:${row.id}` }]);
  for (const row of places) buttons.push([{ text: itemButtonText("places", row), callback_data: `family:item:places:${row.id}` }]);
  for (const row of goals) buttons.push([{ text: itemButtonText("goals", row), callback_data: `family:item:goals:${row.id}` }]);
  buttons.push(...navigationButtons());
  return {
    text: card({
      heading: sectionTitle("planning"),
      meta: "планы, места и цели",
      body: [
        block("🧳 Планы", "plans", plans),
        block("📍 Куда", "places", places),
        block("🌱 Цели", "goals", goals)
      ]
    }),
    buttons
  };
}

function sectionView(db, section, member) {
  if (section === "planning") return planningView(db, member);
  const label = SECTION_LABELS.get(section);
  if (!label || section === "calendar") return null;
  const rows = listSection(db, section, member.id, 20);
  return {
    text: rows.length
      ? card({
        sectionKey: section,
        meta: countLabel(section, rows.length),
        body: renderRows(section, rows)
      })
      : emptyCard(section),
    buttons: sectionButtons(section, rows)
  };
}

function sectionBackButtons(section) {
  const rows = [];
  if (["plans", "places", "goals"].includes(section)) {
    rows.push([{ text: "🧭 Планы", callback_data: "family:section:planning" }]);
  }
  rows.push([
    { text: "‹ К семье", callback_data: "family:menu" },
    { text: "👋 Закрыть", callback_data: "family:close" }
  ]);
  return rows;
}

function memberName(db, id) {
  if (!id) return "не назначен";
  return db.prepare("SELECT name FROM members WHERE id=?").get(id)?.name ?? id;
}

function itemView(db, section, id, member) {
  if (!SECTION_LABELS.has(section)) return null;
  if (section === "calendar") {
    const row = getFamilyCalendarEvent(db, id, member.id);
    if (!row || row.status !== "active") return null;
    const text = card({
      heading: `**📅 ${safe(row.title)}**`,
      meta: metaLine("событие семьи"),
      body: [row.startAt, row.description ? safe(row.description) : null].filter(Boolean).join("\n\n")
    });
    return { text, buttons: [[
      { text: "✎ Поправить", callback_data: `family:do:edit:calendar:${id}` },
      { text: "× Удалить", callback_data: `family:do:delete:calendar:${id}` }
    ], ...sectionBackButtons(section)] };
  }
  if (section === "polls") {
    let poll;
    try { poll = getPollForViewer(db, id, member.id); } catch { return null; }
    if (!poll) return null;
    const lines = poll.options.map(o => `${o.optionIndex + 1}. ${safe(o.label)}`);
    if (poll.votes) {
      const counts = new Map(poll.options.map(o => [o.optionIndex, 0]));
      for (const vote of poll.votes) counts.set(vote.optionIndex, (counts.get(vote.optionIndex) ?? 0) + 1);
      lines.push("", ...poll.options.map(o => `${safe(o.label)}: ${counts.get(o.optionIndex) ?? 0}`));
    }
    const buttons = [];
    if (poll.status === "active") {
      for (const o of poll.options) buttons.push([{ text: `🗳 ${o.label}`, callback_data: `family:vote:${id}:${o.optionIndex}` }]);
      buttons.push([{ text: "🔒 Закрыть", callback_data: `family:do:close:polls:${id}` }]);
    }
    buttons.push(...sectionBackButtons(section));
    return {
      text: card({
        heading: "**🗳 Голосование**",
        meta: poll.status === "active" ? "результаты видны после голоса" : "закрыто",
        body: [`**${safe(poll.question)}**`, bullet(lines)].join("\n\n")
      }),
      buttons
    };
  }
  const row = listSection(db, section, member.id, 100).find(item => item.id === id);
  if (!row) return null;
  const buttons = [];
  let text = "";
  if (section === "actions") {
    text = card({
      heading: `**☑️ ${safe(row.title)}**`,
      meta: row.status === "completed" ? "готово" : "дело",
      body: [
        `Исполнитель: ${safe(memberName(db, row.assigneeId))}`,
        row.dueAt ? `Срок: ${code(fmtDate(row.dueAt))}` : "Без срока"
      ].join("\n")
    });
    buttons.push([
      { text: "✓ Готово", callback_data: `family:do:complete:actions:${id}` },
      { text: "✎ Поправить", callback_data: `family:do:edit:actions:${id}` }
    ]);
    buttons.push([{ text: "× Отменить", callback_data: `family:do:cancel:actions:${id}` }]);
  } else if (section === "notes") {
    text = card({
      heading: `**📝 ${safe(row.title)}**`,
      meta: "общая заметка",
      body: safe(row.body)
    });
    buttons.push([
      { text: "✎ Поправить", callback_data: `family:do:edit:notes:${id}` },
      { text: "× Удалить", callback_data: `family:do:delete:notes:${id}` }
    ]);
  } else if (section === "wishes") {
    const extra = [
      row.targetPrice != null ? `${Number(row.targetPrice).toLocaleString("ru-RU")} ₽` : null,
      row.url ? safeUrl(row.url) : null,
      row.comment ? safe(row.comment) : null
    ].filter(Boolean).join("\n");
    text = card({
      heading: `**🎁 ${safe(row.title)}**`,
      meta: row.ownerId === member.id ? "твоё желание" : "желание семьи",
      body: extra
    });
    if (row.ownerId === member.id) {
      buttons.push([
        { text: "✎ Поправить", callback_data: `family:do:edit:wishes:${id}` },
        { text: "× Удалить", callback_data: `family:do:remove:wishes:${id}` }
      ]);
    } else {
      buttons.push([{ text: row.reservedBy ? "✓ Это я подарю" : "🤫 Это я подарю", callback_data: `family:reserve:wishes:${id}` }]);
    }
  } else if (section === "places") {
    text = card({
      heading: `**📍 ${safe(row.name)}**`,
      meta: "место из списка «Куда»",
      body: [row.comment ? safe(row.comment) : null, row.mapsUrl ? safeUrl(row.mapsUrl) : null].filter(Boolean).join("\n")
    });
    buttons.push([
      { text: "✎ Поправить", callback_data: `family:do:edit:places:${id}` },
      { text: "× Удалить", callback_data: `family:do:delete:places:${id}` }
    ]);
  } else if (section === "plans") {
    text = card({
      heading: `**🧳 ${safe(row.title)}**`,
      meta: "план",
      body: row.comment ? safe(row.comment) : hand("Пока без комментария")
    });
    buttons.push([
      { text: "✏️ Изменить", callback_data: `family:do:edit:plans:${id}` },
      { text: "📦 Архив", callback_data: `family:do:archive:plans:${id}` }
    ]);
  } else if (section === "goals") {
    text = card({
      heading: `**💰 ${safe(row.title)}**`,
      meta: `цель · до ${fmtDate(row.dueAt)}`,
      body: `${code(`${Number(row.amount).toLocaleString("ru-RU")} ${row.currency}`)}`
    });
    buttons.push([
      { text: "✓ Готово", callback_data: `family:do:complete:goals:${id}` },
      { text: "✎ Поправить", callback_data: `family:do:edit:goals:${id}` }
    ]);
  } else if (section === "cashback") {
    text = card({
      heading: `**💳 ${safe(row.title)}**`,
      meta: "кэшбэк месяца",
      body: safe(row.body)
    });
  } else if (section === "capsules") {
    text = card({
      heading: `**⏳ Капсула**`,
      meta: `открытие · ${fmtDate(row.unlockAt)}`,
      body: row.payload ? safe(row.payload) : hand("Содержимое скрыто до срока")
    });
    if (row.authorId === member.id && row.status === "sealed") {
      buttons.push([{ text: "× Отменить", callback_data: `family:do:cancel:capsules:${id}` }]);
    }
  }
  buttons.push(...sectionBackButtons(section));
  return { text, buttons };
}

const DESTRUCTIVE_LABELS = {
  "delete:notes": "Удалить заметку?",
  "remove:wishes": "Удалить желание?",
  "delete:places": "Удалить место?",
  "archive:plans": "Переместить план в архив?",
  "close:polls": "Закрыть голосование?",
  "complete:goals": "Отметить цель выполненной?",
  "complete:actions": "Отметить дело выполненным?",
  "cancel:actions": "Отменить дело?",
  "cancel:capsules": "Отменить запечатанную капсулу?",
  "delete:calendar": "Удалить событие из семейного календаря?"
};

function confirmationView(op, section, id) {
  const text = DESTRUCTIVE_LABELS[`${op}:${section}`];
  if (!text) return null;
  return {
    text: card({
      heading: `**⚠️ ${safe(text)}**`,
      meta: "подтверди действие",
      body: hand("Отменить это будет нельзя"),
      showRule: false
    }),
    buttons: [[
      { text: "✅ Да", callback_data: `family:apply:${op}:${section}:${id}` },
      { text: "⬅️ Нет", callback_data: `family:item:${section}:${id}` }
    ], [{ text: "👋 Закрыть", callback_data: "family:close" }]]
  };
}

function unauthorizedText() {
  return "❌ Family Hub недоступен для этого пользователя.";
}


export async function processOutboxOnce({ db, workerId, runtimeId, agentId, now, leaseMs = 60000, retryDelayMs = 300000, maxAttempts = 5, send, handlers = {} }) {
  const row = claimDueOutbox(db, { workerId, runtimeId, agentId, now, leaseMs });
  if (!row) return { status: "idle" };
  const retryDelays = [retryDelayMs, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000];
  try {
    const handler = handlers[row.kind];
    if (handler) {
      await handler(row);
    } else {
      const route = getMemberRoute(db, row.recipientMemberId, { runtimeId, agentId });
      const text = String(row.payload?.text ?? "").trim();
      if (!route || !text) throw new Error(!route ? "member route missing" : "outbox text missing");
      await send(route, text);
    }
    markOutboxSent(db, row.id, { workerId, sentAt: now });
    return { status: "sent", id: row.id };
  } catch (error) {
    const message = error?.message ?? String(error);
    if (Number(row.attempts) >= maxAttempts) {
      markOutboxFailed(db, row.id, { workerId, error: message, retryAt: now, deadAt: now });
      return { status: "dead", id: row.id };
    }
    const delay = retryDelays[Math.min(Math.max(Number(row.attempts) - 1, 0), retryDelays.length - 1)];
    const retryAt = new Date(Date.parse(now) + delay).toISOString();
    markOutboxFailed(db, row.id, { workerId, error: message, retryAt });
    return { status: "retry", id: row.id };
  }
}

export async function runFamilyMaintenance({
  db, workerId, runtimeId, agentId, now = new Date(), reminderTime = "09:00", reminderTimezone = "Europe/Moscow",
  send, handlers = {}, generateReminders = true, maxItems = 8
}) {
  const remindersCreated = generateReminders
    ? enqueueDailyActionReminders(db, { now, timeZone: reminderTimezone, reminderTime })
    : 0;
  let processed = 0;
  const stamp = now instanceof Date ? now.toISOString() : String(now);
  for (let i = 0; i < maxItems; i += 1) {
    const result = await processOutboxOnce({
      db, workerId, runtimeId, agentId, now: stamp, leaseMs: 60000, retryDelayMs: 300000, send, handlers
    });
    if (result.status === "idle") break;
    processed += 1;
  }
  return { remindersCreated, processed };
}

export function createCalendarOutboxHandlers({ db, calendar, calendarId }) {
  return {
    async calendar_action_upsert(row) {
      if (!calendar || !calendarId) throw new Error("family calendar not configured");
      if (!isCalendarGateOpen(db, calendarId)) throw new Error("calendar blocked: multiple households");
      const actionId = String(row?.payload?.entityId ?? "").trim();
      if (!actionId) throw new Error("calendar action entityId missing");
      return syncActionCalendar({ db, calendar, calendarId, actionId });
    },
    async calendar_event_upsert(row) {
      if (!calendar || !calendarId) throw new Error("family calendar not configured");
      if (!isCalendarGateOpen(db, calendarId)) throw new Error("calendar blocked: multiple households");
      const eventId = String(row?.payload?.entityId ?? "").trim();
      if (!eventId) throw new Error("family calendar event entityId missing");
      return syncFamilyEventCalendar({ db, calendar, calendarId, eventId });
    }
  };
}

export function createCapsuleOutboxHandlers({ db, sendMedia = null }) {
  return {
    async capsule_unlock(row) {
      const capsuleId = String(row?.payload?.entityId ?? "").trim();
      if (!capsuleId) throw new Error("capsule entityId missing");
      const capsule = db.prepare(`SELECT c.id,c.status,c.payload,c.recipient_id AS recipientId,m.name AS authorName,
        cm.file_path AS mediaPath,cm.content_type AS contentType,cm.caption
        FROM capsules c JOIN members m ON m.id=c.author_id
        LEFT JOIN capsule_media cm ON cm.capsule_id=c.id WHERE c.id=?`).get(capsuleId);
      if (!capsule) throw new Error("Capsule not found");
      if (capsule.status === "cancelled") return { id: capsuleId, status: "cancelled" };
      if (capsule.mediaPath) {
        enqueueOutbox(db, {
          dedupeKey: `capsule:${capsuleId}:delivery`,
          recipientMemberId: capsule.recipientId,
          kind: "capsule_media",
          payload: {
            entityId: capsuleId,
            filePath: capsule.mediaPath,
            contentType: capsule.contentType ?? null,
            caption: capsule.caption || `💌 Открытка · ${capsule.authorName}`
          },
          availableAt: row.availableAt ?? null
        });
      } else {
        enqueueOutbox(db, {
          dedupeKey: `capsule:${capsuleId}:delivery`,
          recipientMemberId: capsule.recipientId,
          kind: "text",
          payload: { text: `📦 Капсула от ${capsule.authorName}

${capsule.payload}` },
          availableAt: row.availableAt ?? null
        });
      }
      return unlockCapsule(db, capsuleId);
    },
    async capsule_media(row) {
      if (typeof sendMedia !== "function") throw new Error("capsule media sender unavailable");
      return sendMedia(row);
    }
  };
}

export function createFamilyRuntime({ db, runtimeId, agentId = "main", buttonText = DEFAULT_BUTTON, menuTtlMs = 15_000, wizardTtlMs = 15 * 60 * 1000, mediaWizardTtlMs = 2 * 60 * 60 * 1000, now = Date.now, random = Math.random, ensurePersistentKeyboard = null, calendar = null, calendarId = null, calendarTimeZone = "Europe/Moscow", surpriseAssetDir = null, capsuleMediaDir = null, sendSurpriseMedia = null, surpriseManualLimit = 10, surpriseUnlimitedMemberIds = [] }) {
  const command = {
    name: "family",
    description: "Открыть семейный хаб.",
    acceptsArgs: false,
    requireAuth: true,
    handler(ctx) {
      if (ctx?.isAuthorizedSender !== true) return { text: unauthorizedText() };
      const member = resolveMember(db, runtimeId, ctx?.agentId ?? agentId);
      return member ? buildMainMenu(member) : { text: unauthorizedText() };
    }
  };

  const pendingMenus = new Map();
  const pendingWizards = new Map();
  const installingKeyboards = new Set();
  const wizardKey = (member, _sessionKey = null) => {
    // OpenClaw may normalize the same Telegram DM to different session keys
    // between interactive callbacks and ordinary inbound text. Scope wizard
    // state to the trusted bound family member instead of the transport key.
    return `${runtimeId}:${member.id}`;
  };
  const familyMembers = member => db.prepare("SELECT id,name,role FROM members WHERE household_id=? ORDER BY role,name").all(member.householdId).map(row => ({ ...row }));
  const normalizeMemberText = value => String(value ?? "").trim().toLowerCase().replaceAll("ё", "е");
  const resolveWizardMember = (member, value) => {
    const raw = normalizeMemberText(value);
    if (["мне", "я", "себе"].includes(raw)) return member.id;
    const matches = familyMembers(member).filter(row => {
      const name = normalizeMemberText(row.name);
      if (name === raw || name.startsWith(raw)) return true;
      const first = name.split(/\s+/u)[0] ?? "";
      return raw.length >= 3 && !raw.includes(" ") && first.length >= 3 && raw.slice(0, 3) === first.slice(0, 3);
    });
    return matches.length === 1 ? matches[0].id : null;
  };
  const resolveMentionedMember = (member, value) => {
    const raw = normalizeMemberText(value);
    const words = raw.match(/[\p{L}\p{N}]+/gu) ?? [];
    const matches = familyMembers(member).filter(row => {
      if (row.id === member.id) return false;
      const first = normalizeMemberText(row.name).split(/\s+/u)[0] ?? "";
      const stem = first.slice(0, 3);
      return stem.length >= 3 && words.some(word => word.startsWith(stem));
    });
    if (matches.length === 1) return matches[0];
    const others = familyMembers(member).filter(row => row.id !== member.id);
    if (others.length === 1 && /(?:\bв\s+ответ\b|\bему\b|\bей\b|\bмужу\b|\bжене\b)/iu.test(raw)) return others[0];
    return null;
  };
  const isMediaSendIntent = (member, value) => {
    const raw = normalizeMemberText(value);
    const words = raw.match(/[\p{L}\p{N}]+/gu) ?? [];
    const sendVerb = /(?:отправ|пришл|перешл|переда|пошл|отошл|скин)/u.test(raw);
    const familyTarget = familyMembers(member).some(row => {
      const stem = normalizeMemberText(row.name).split(/\s+/u)[0]?.slice(0, 3) ?? "";
      return stem.length >= 3 && words.some(word => word.startsWith(stem));
    }) || words.some(word => ["ему","ей","мужу","жене"].includes(word)) ||
      /в\s+ответ/u.test(raw);
    const capsuleContext = /(?:в\s+ответ|открытк|капсул|love\s*is|лав\s*из)/iu.test(raw);
    return sendVerb && familyTarget && capsuleContext;
  };
  const parseMediaCapsuleDate = (value, nowValue) => {
    let raw = String(value ?? "").trim().toLowerCase().replace(/ё/g, "е");
    raw = raw
      .replace(/^(сегодня|завтра)\s+в\s+(\d{1,2}:\d{2})$/u, "$1 $2")
      .replace(/^(\d{1,2}\.\d{1,2}(?:\.\d{4})?)\s+в\s+(\d{1,2}:\d{2})$/u, "$1 $2");
    const bare = /^(?:в\s+)?(\d{1,2}):(\d{2})$/u.exec(raw);
    let parsed;
    if (bare) {
      const hour = Number(bare[1]); const minute = Number(bare[2]);
      if (hour > 23 || minute > 59) return { status: "invalid" };
      const today = localDateParts(nowValue);
      parsed = dateString(today) + "T" + String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0") + ":00+03:00";
    } else {
      parsed = parseWizardDate(raw, nowValue);
    }
    if (!parsed || !String(parsed).includes("T")) return { status: "invalid" };
    const when = new Date(parsed).getTime();
    const current = new Date(nowValue).getTime();
    if (!Number.isFinite(when)) return { status: "invalid" };
    if (when <= current) return { status: "past" };
    return { status: "ok", value: parsed };
  };
  const deleteMediaDraft = (memberId) => {
    db.prepare("DELETE FROM capsule_media_drafts WHERE author_id=?").run(memberId);
  };
  const persistMediaDraft = (member, wizard) => {
    db.prepare(`INSERT INTO capsule_media_drafts(author_id,draft_id,recipient_id,file_path,content_type,caption,expires_at,updated_at)
      VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(author_id) DO UPDATE SET
        draft_id=excluded.draft_id,recipient_id=excluded.recipient_id,file_path=excluded.file_path,
        content_type=excluded.content_type,caption=excluded.caption,expires_at=excluded.expires_at,updated_at=CURRENT_TIMESTAMP`)
      .run(member.id, wizard.id, wizard.data.recipientId ?? null, wizard.data.mediaPath,
        wizard.data.contentType ?? null, wizard.data.caption ?? null, new Date(wizard.expiresAt).toISOString());
  };
  const loadMediaDraft = (member, sessionKey = null) => {
    const row = db.prepare(`SELECT draft_id AS draftId,recipient_id AS recipientId,file_path AS filePath,
      content_type AS contentType,caption,expires_at AS expiresAt
      FROM capsule_media_drafts WHERE author_id=?`).get(member.id);
    if (!row) return null;
    const expiresAt = Date.parse(row.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Number(now())) {
      deleteMediaDraft(member.id);
      return null;
    }
    const recipient = row.recipientId ? familyMembers(member).find(item => item.id === row.recipientId) : null;
    return {
      id: row.draftId,
      key: wizardKey(member, sessionKey),
      section: "capsules",
      mode: recipient ? "capsule-media" : "capsule-media-recipient",
      step: 1,
      data: {
        recipientId: recipient?.id ?? null,
        recipientName: recipient?.name ?? null,
        mediaPath: row.filePath,
        contentType: row.contentType ?? null,
        caption: row.caption ?? null
      },
      expiresAt
    };
  };
  const finishMediaCapsuleWizard = (member, wizard, unlockAt) => {
    const unlockDate = new Date(unlockAt);
    if (Number.isNaN(unlockDate.getTime())) {
      return { handled: true, text: "Не понял дату. Например: сегодня 19:00 или завтра 09:00." };
    }
    const actionKey = `family-ui-media-capsule:${runtimeId}:${member.id}:${wizard.id}`;
    db.exec("BEGIN IMMEDIATE");
    try {
      const claim = db.prepare("INSERT OR IGNORE INTO processed_actions(action_key) VALUES (?)").run(actionKey);
      if (Number(claim.changes) === 0) {
        db.exec("ROLLBACK");
        pendingWizards.delete(wizard.key);
        deleteMediaDraft(member.id);
        return { handled: true, text: "✓ Эта открытка уже запланирована." };
      }
      const capsule = createCapsule(db, {
        householdId: member.householdId,
        authorId: member.id,
        recipientId: wizard.data.recipientId,
        unlockAt,
        payload: "🖼 Открытка"
      });
      db.prepare("INSERT INTO capsule_media(capsule_id,file_path,content_type,caption) VALUES (?,?,?,?)")
        .run(capsule.id, wizard.data.mediaPath, wizard.data.contentType ?? null, wizard.data.caption ?? null);
      enqueueOutbox(db, {
        dedupeKey: `capsule:${capsule.id}:unlock`,
        recipientMemberId: wizard.data.recipientId,
        kind: "capsule_unlock",
        payload: { entityId: capsule.id },
        availableAt: unlockDate.toISOString()
      });
      db.prepare("DELETE FROM capsule_media_drafts WHERE author_id=?").run(member.id);
      db.exec("COMMIT");
      pendingWizards.delete(wizard.key);
      return { handled: true, text: `✅ Открытка запечатана. Получатель: ${wizard.data.recipientName}. Время: ${fmtDate(unlockAt)}.` };
    } catch (error) {
      db.exec("ROLLBACK");
      persistMediaDraft(member, wizard);
      throw error;
    }
  };
  const beginWizard = (member, section, mode = "create", sessionKey = null) => {
    const prompt = startPrompt(section, mode);
    if (!prompt) return null;
    const key = wizardKey(member, sessionKey);
    pendingWizards.set(key, { id: randomUUID(), key, section, mode, step: 0, data: {}, expiresAt: Number(now()) + wizardTtlMs });
    return { text: prompt, buttons: wizardButtons() };
  };
  const beginEditWizard = (member, section, recordId, sessionKey = null) => {
    const prompt = editPrompt(section);
    if (!prompt) return null;
    const key = wizardKey(member, sessionKey);
    const data = { recordId };
    if (section === "notes") {
      const note = listSection(db, "notes", member.id, 100).find(row => row.id === recordId);
      if (!note) return null;
      data.expectedRevision = note.revision;
    }
    pendingWizards.set(key, { id: randomUUID(), key, section, mode: "edit", step: 0, data, expiresAt: Number(now()) + wizardTtlMs });
    return { text: prompt, buttons: wizardButtons() };
  };
  const finishWizard = (member, wizard, params, confirmation) => {
    try {
      const response = executeFamilyAction({
        db, member, params,
        actionKey: `family-ui:${runtimeId}:${agentId}:${member.id}:${wizard.id}`
      });
      if (response?.details?.ok !== true) return { handled: true, text: response?.details?.message ?? "Не удалось сохранить." };
      pendingWizards.delete(wizard.key);
      return { handled: true, text: confirmation };
    } catch (error) {
      pendingWizards.delete(wizard.key);
      if (/note changed/i.test(String(error?.message ?? error))) {
        return { handled: true, text: "Заметка уже изменилась. Открой её снова, чтобы не потерять новую версию." };
      }
      throw error;
    }
  };
  const handleWizardInput = (member, wizard, rawInput) => {
    wizard.expiresAt = Number(now()) + (String(wizard.mode).startsWith("capsule-media") ? mediaWizardTtlMs : wizardTtlMs);
    const value = String(rawInput ?? "").trim();
    if (!value) return { handled: true, text: "Напиши значение текстом." };
    if (/^(?:отмена|отменить)$/iu.test(value)) {
      pendingWizards.delete(wizard.key);
      if (String(wizard.mode).startsWith("capsule-media")) deleteMediaDraft(member.id);
      return { handled: true, text: "Отменено." };
    }
    if (String(wizard.mode).startsWith("capsule-media")) persistMediaDraft(member, wizard);
    if (wizard.mode === "search" && wizard.section === "notes") {
      const rows = searchNotes(db, value, member.id);
      pendingWizards.delete(wizard.key);
      const body = rows.length
        ? rows.map(row => `**${safe(row.title)}**\n${safe(row.body)}`).join("\n\n")
        : hand("Ничего не найдено");
      return {
        handled: true,
        text: card({
          heading: "**🔎 Поиск заметок**",
          meta: rows.length ? `найдено: ${rows.length}` : "пусто",
          body
        })
      };
    }
    const data = wizard.data;
    if (wizard.mode === "capsule-media-recipient") {
      const recipientId = resolveWizardMember(member, value);
      if (!recipientId || recipientId === member.id) {
        return { handled: true, text: "Кому отправить? " + familyMembers(member).filter(row => row.id !== member.id).map(row => row.name).join(" / ") };
      }
      const recipient = familyMembers(member).find(row => row.id === recipientId);
      if (!recipient) return { handled: true, text: "Не нашёл получателя в семье." };
      wizard.mode = "capsule-media";
      wizard.data.recipientId = recipient.id;
      wizard.data.recipientName = recipient.name;
      persistMediaDraft(member, wizard);
      return { handled: true, text: "💌 Получатель: " + recipient.name + ". Когда отправить? Например: сегодня 19:00 или завтра 09:00." };
    }
    if (wizard.mode === "capsule-media") {
      const parsed = parseMediaCapsuleDate(value, now());
      if (parsed.status === "past") {
        return { handled: true, text: "Это время уже прошло. Укажи будущее время, например: сегодня 20:00 или завтра 09:00." };
      }
      if (parsed.status !== "ok") {
        return { handled: true, text: "Когда отправить? Нужны дата и время: сегодня 19:00, завтра 09:00 или 20.09 12:00." };
      }
      return finishMediaCapsuleWizard(member, wizard, parsed.value);
    }
    if (wizard.mode === "edit") {
      if (wizard.section === "notes") {
        if (wizard.step === 0) { if (!isSkip(value)) data.title = value; wizard.step = 1; return { handled: true, text: "Новый текст заметки? «-» оставить прежний." }; }
        if (!isSkip(value)) data.body = value;
        return finishWizard(member, wizard, { action: "update_note", noteId: data.recordId, title: data.title, body: data.body, expectedRevision: data.expectedRevision }, "✓ Заметка сохранена.");
      }
      if (wizard.section === "wishes") {
        if (wizard.step === 0) { if (!isSkip(value)) data.title = value; wizard.step = 1; return { handled: true, text: "Новая цена, ссылка или комментарий? «-» оставить как есть." }; }
        const params = { action: "update_wish", wishId: data.recordId, title: data.title };
        if (!isSkip(value)) {
          const n = Number(value.replace(/\s+/g, "").replace(",", "."));
          if (Number.isFinite(n) && n >= 0) params.targetPrice = n;
          else if (/^https?:\/\//iu.test(value)) params.url = value;
          else params.comment = value;
        }
        return finishWizard(member, wizard, params, "✅ Желание сохранено.");
      }
      if (wizard.section === "places") {
        if (wizard.step === 0) { if (!isSkip(value)) data.title = value; wizard.step = 1; return { handled: true, text: "Новая ссылка Google Maps или комментарий? «-» оставить как есть." }; }
        const params = { action: "update_place", familyPlaceId: data.recordId, title: data.title };
        if (!isSkip(value)) { if (/^https?:\/\//iu.test(value)) params.mapsUrl = value; else params.comment = value; }
        return finishWizard(member, wizard, params, "✅ Место сохранено.");
      }
      if (wizard.section === "plans") {
        if (wizard.step === 0) { if (!isSkip(value)) data.title = value; wizard.step = 1; return { handled: true, text: "Новый комментарий? «-» оставить прежний." }; }
        if (!isSkip(value)) data.comment = value;
        return finishWizard(member, wizard, { action: "update_plan", planId: data.recordId, title: data.title, comment: data.comment }, "✅ План сохранён.");
      }
      if (wizard.section === "calendar") {
        if (wizard.step === 0) { if (!isSkip(value)) data.title = value; wizard.step = 1; return { handled: true, text: "Новая дата/время? Например: 21.09 18:00. «-» оставить прежнее." }; }
        if (wizard.step === 1) {
          if (!isSkip(value)) {
            const startAt = parseWizardDate(value, now());
            if (startAt === undefined || startAt === null) return { handled: true, text: "Не понял дату. Например: 21.09 18:00 или «-»." };
            data.startAt = startAt;
          }
          wizard.step = 2; return { handled: true, text: "Новый комментарий? «-» оставить прежний." };
        }
        if (!isSkip(value)) data.description = value;
        return finishWizard(member, wizard, {
          action: "update_calendar_event", calendarEventId: data.recordId,
          title: data.title, startAt: data.startAt, description: data.description
        }, "✅ Событие сохранено.");
      }
    if (wizard.section === "goals") {
        if (wizard.step === 0) { if (!isSkip(value)) data.title = value; wizard.step = 1; return { handled: true, text: "Новая сумма? «-» оставить прежнюю." }; }
        if (wizard.step === 1) {
          if (!isSkip(value)) {
            const amount = Number(value.replace(/\s+/g, "").replace(",", "."));
            if (!Number.isFinite(amount) || amount < 0) return { handled: true, text: "Нужна сумма числом или «-»." };
            data.amount = amount;
          }
          wizard.step = 2; return { handled: true, text: "Новый срок? Например: 15.01.2027. «-» оставить прежний." };
        }
        if (!isSkip(value)) {
          const dueAt = parseWizardDate(value, now());
          if (dueAt === undefined || dueAt === null) return { handled: true, text: "Не понял дату. Например: 15.01.2027 или «-»." };
          data.dueAt = dueAt;
        }
        return finishWizard(member, wizard, { action: "update_goal", goalId: data.recordId, title: data.title, amount: data.amount, dueAt: data.dueAt }, "✅ Цель сохранена.");
      }
      if (wizard.section === "actions") {
        if (wizard.step === 0) { if (!isSkip(value)) data.title = value; wizard.step = 1; return { handled: true, text: `Новый исполнитель? ${familyMembers(member).map(row => row.name).join(" / ")} / мне / «-» оставить` }; }
        if (wizard.step === 1) {
          if (!isSkip(value)) {
            const assigneeId = resolveWizardMember(member, value);
            if (!assigneeId) return { handled: true, text: `Не понял. Выбери: ${familyMembers(member).map(row => row.name).join(" / ")} / мне / «-»` };
            data.assigneeId = assigneeId;
          }
          wizard.step = 2; return { handled: true, text: "Новый срок? Например: 20.09 12:00. «-» оставить прежний." };
        }
        if (!isSkip(value)) {
          const dueAt = parseWizardDate(value, now());
          if (dueAt === undefined || dueAt === null) return { handled: true, text: "Не понял дату. Например: 20.09 12:00 или «-»." };
          data.dueAt = dueAt;
        }
        return finishWizard(member, wizard, { action: "update_action", actionId: data.recordId, title: data.title, assigneeId: data.assigneeId, dueAt: data.dueAt }, "✅ Дело сохранено.");
      }
    }
    if (wizard.section === "shopping") {
      const items = parseOptions(value);
      if (!items.length) return { handled: true, text: "Напиши, что добавить в покупки." };
      return finishWizard(member, wizard, { action: "add_shopping_items", items }, `✓ Добавлено: ${items.length}`);
    }
    if (wizard.section === "notes") {
      if (wizard.step === 0) { data.title = value; wizard.step = 1; return { handled: true, text: "Текст заметки?" }; }
      return finishWizard(member, wizard, { action: "create_note", title: data.title, body: value }, `✅ Заметка «${data.title}» сохранена.`);
    }
    if (wizard.section === "wishes") {
      if (wizard.step === 0) { data.title = value; wizard.step = 1; return { handled: true, text: "Цена, ссылка или комментарий? Можно написать «-»." }; }
      const params = { action: "create_wish", title: data.title };
      if (!isSkip(value)) {
        const n = Number(value.replace(/\s+/g, "").replace(",", "."));
        if (Number.isFinite(n) && n >= 0) params.targetPrice = n;
        else if (/^https?:\/\//iu.test(value)) params.url = value;
        else params.comment = value;
      }
      return finishWizard(member, wizard, params, `✅ Желание «${data.title}» добавлено.`);
    }
    if (wizard.section === "places") {
      if (wizard.step === 0) { data.title = value; wizard.step = 1; return { handled: true, text: "Ссылка Google Maps или комментарий? Можно «-»." }; }
      const params = { action: "create_place", title: data.title };
      if (!isSkip(value)) {
        if (/^https?:\/\//iu.test(value)) params.mapsUrl = value; else params.comment = value;
      }
      return finishWizard(member, wizard, params, `✅ Место «${data.title}» добавлено.`);
    }
    if (wizard.section === "plans") {
      if (wizard.step === 0) { data.title = value; wizard.step = 1; return { handled: true, text: "Комментарий к плану? Можно «-»." }; }
      const participants = familyMembers(member).map(row => row.id);
      return finishWizard(member, wizard, {
        action: "create_plan", title: data.title, comment: isSkip(value) ? undefined : value, participants
      }, `✅ План «${data.title}» создан.`);
    }
    if (wizard.section === "polls") {
      if (wizard.step === 0) { data.question = value; wizard.step = 1; return { handled: true, text: "Варианты ответа через запятую или каждый с новой строки." }; }
      const options = parseOptions(value);
      if (options.length < 2) return { handled: true, text: "Нужно хотя бы два варианта ответа." };
      const participants = familyMembers(member).map(row => row.id);
      return finishWizard(member, wizard, { action: "create_poll", question: data.question, options, participants }, "✅ Голосование создано.");
    }
    if (wizard.section === "capsules") {
      if (wizard.step === 0) {
        const recipientId = resolveWizardMember(member, value);
        if (!recipientId) return { handled: true, text: `Не понял. Выбери: ${familyMembers(member).map(row => row.name).join(" / ")}` };
        data.recipientId = recipientId; wizard.step = 1;
        return { handled: true, text: "Когда открыть? Например: 20.09 12:00" };
      }
      if (wizard.step === 1) {
        const unlockAt = parseWizardDate(value, now());
        if (unlockAt === undefined || unlockAt === null) return { handled: true, text: "Не понял дату. Например: 20.09 12:00" };
        data.unlockAt = unlockAt; wizard.step = 2;
        return { handled: true, text: "Сообщение капсулы?" };
      }
      return finishWizard(member, wizard, {
        action: "create_capsule", recipientId: data.recipientId, unlockAt: data.unlockAt, payload: value
      }, "✅ Капсула запечатана.");
    }
    if (wizard.section === "calendar") {
      if (wizard.step === 0) { data.title = value; wizard.step = 1; return { handled: true, text: "Когда событие? Например: 21.09 или 21.09 18:00" }; }
      if (wizard.step === 1) {
        const startAt = parseWizardDate(value, now());
        if (startAt === undefined || startAt === null) return { handled: true, text: "Не понял дату. Например: 21.09 или 21.09 18:00" };
        data.startAt = startAt; wizard.step = 2;
        return { handled: true, text: "Комментарий или детали? Можно «-»." };
      }
      return finishWizard(member, wizard, {
        action: "create_calendar_event", title: data.title, startAt: data.startAt,
        description: isSkip(value) ? undefined : value
      }, `✅ Событие «${data.title}» добавлено в семейный календарь.`);
    }
    if (wizard.section === "goals") {
      if (wizard.step === 0) { data.title = value; wizard.step = 1; return { handled: true, text: "Сумма в рублях?" }; }
      if (wizard.step === 1) {
        const amount = Number(value.replace(/\s+/g, "").replace(",", "."));
        if (!Number.isFinite(amount) || amount < 0) return { handled: true, text: "Нужна сумма числом." };
        data.amount = amount; wizard.step = 2; return { handled: true, text: "Когда достичь цели? Например: 30.12.2026" };
      }
      const dueAt = parseWizardDate(value, now());
      if (dueAt === undefined || dueAt === null) return { handled: true, text: "Не понял дату. Например: 30.12.2026" };
      return finishWizard(member, wizard, { action: "create_goal", title: data.title, amount: data.amount, dueAt, assigneeId: member.id }, `✅ Цель «${data.title}» создана.`);
    }
    if (wizard.section === "actions") {
      if (wizard.step === 0) { data.title = value; wizard.step = 1; return { handled: true, text: `Кому? ${familyMembers(member).map(row => row.name).join(" / ")} / мне` }; }
      if (wizard.step === 1) {
        const assigneeId = resolveWizardMember(member, value);
        if (!assigneeId) return { handled: true, text: `Не понял. Выбери: ${familyMembers(member).map(row => row.name).join(" / ")} / мне` };
        data.assigneeId = assigneeId; wizard.step = 2; return { handled: true, text: "Когда? Например: 19.09 14:00, завтра 14:00 или без срока" };
      }
      const dueAt = parseWizardDate(value, now(), { allowUndated: true });
      if (dueAt === undefined) return { handled: true, text: "Когда? Например: 19.09 14:00, завтра 14:00 или без срока" };
      const params = { action: "create_action", title: data.title, assigneeId: data.assigneeId };
      if (dueAt === null) params.allowUndated = true; else params.dueAt = dueAt;
      return finishWizard(member, wizard, params, `✅ Дело «${data.title}» добавлено.`);
    }
    pendingWizards.delete(wizard.key);
    return { handled: true, text: "Этот сценарий больше недоступен. Открой 🫶 Семья заново." };
  };
  const applyItemOperation = (member, op, section, id, extra = {}) => {
    let params = null;
    if (op === "delete" && section === "notes") params = { action: "delete_note", noteId: id };
    else if (op === "remove" && section === "wishes") params = { action: "remove_wish", wishId: id };
    else if (op === "delete" && section === "places") params = { action: "delete_place", familyPlaceId: id };
    else if (op === "archive" && section === "plans") params = { action: "archive_plan", planId: id };
    else if (op === "close" && section === "polls") params = { action: "close_poll", pollId: id };
    else if (op === "complete" && section === "goals") params = { action: "complete_goal", goalId: id };
    else if (op === "complete" && section === "actions") params = { action: "complete_action", actionId: id };
    else if (op === "cancel" && section === "actions") params = { action: "cancel_action", actionId: id };
    else if (op === "cancel" && section === "capsules") params = { action: "cancel_capsule", capsuleId: id };
    else if (op === "delete" && section === "calendar") params = { action: "delete_calendar_event", calendarEventId: id };
    else if (op === "reserve" && section === "wishes") params = { action: "reserve_wish", wishId: id };
    else if (op === "vote" && section === "polls") params = { action: "vote_poll", pollId: id, optionIndex: Number(extra.optionIndex) };
    if (!params) throw new Error(`Unsupported family UI operation: ${op}:${section}`);
    return executeFamilyAction({
      db, member, params,
      actionKey: `family-ui-action:${runtimeId}:${agentId}:${member.id}:${op}:${section}:${id}:${extra.optionIndex ?? ""}`
    });
  };
  const sessionAgentId = (sessionKey) => {
    const raw = String(sessionKey ?? "").trim().toLowerCase();
    if (!raw.startsWith("agent:")) return null;
    const end = raw.indexOf(":", 6);
    return end > 6 && end < raw.length - 1 ? raw.slice(6, end) : null;
  };
  const sessionDirectTarget = (sessionKey) => {
    const raw = String(sessionKey ?? "").trim();
    const marker = ":telegram:direct:";
    const lower = raw.toLowerCase();
    const index = lower.indexOf(marker);
    if (index < 0) return null;
    const target = raw.slice(index + marker.length).split(":")[0].trim();
    return target || null;
  };
  const fallbackAccountId = (activeAgentId, ctx) => {
    const explicit = String(ctx?.accountId ?? ctx?.callback?.accountId ?? "").trim();
    if (explicit) return explicit;
    return activeAgentId === "main" ? "default" : activeAgentId;
  };
  const queueMenu = (sessionKey, menu) => {
    const key = String(sessionKey ?? "").trim();
    if (!key) return;
    const currentTime = now();
    const current = (pendingMenus.get(key) ?? []).filter(item => item.expiresAt > currentTime);
    current.push({ text: menu.text, channelData: menu.channelData, expiresAt: currentTime + menuTtlMs });
    pendingMenus.set(key, current.slice(-4));
  };
  const inboundClaim = async (event, ctx) => {
    if (event?.channel !== "telegram" || event?.isGroup === true) return undefined;
    const activeAgentId = sessionAgentId(ctx?.sessionKey) ?? String(ctx?.agentId ?? "").trim().toLowerCase();
    if (!activeAgentId) return undefined;
    const member = resolveMember(db, runtimeId, activeAgentId);
    if (!member) return undefined;
    const content = String(event?.content ?? "").trim();
    const replyContext = String(event?.replyToBody ?? "").trim();
    const intentText = [content, replyContext].filter(Boolean).join(" ");
    if (!isMediaSendIntent(member, intentText)) return undefined;
    const media = Array.isArray(event?.media) ? event.media : [];
    const local = media.find(item => String(item?.path ?? "").trim());
    if (!local) {
      if (event?.mediaStagingPending === true) {
        return { handled: true, reply: { text: "Картинка ещё загружается. Пришли её ещё раз вместе с подписью, кому отправить." } };
      }
      return undefined;
    }
    const recipient = resolveMentionedMember(member, intentText);
    const stagedPath = stageSurpriseAsset(local.path, capsuleMediaDir);
    const key = wizardKey(member, ctx?.sessionKey);
    const wizard = {
      id: randomUUID(), key, section: "capsules", mode: recipient ? "capsule-media" : "capsule-media-recipient", step: 1,
      data: {
        recipientId: recipient?.id ?? null,
        recipientName: recipient?.name ?? null,
        mediaPath: stagedPath,
        contentType: local.contentType ?? local.kind ?? null,
        caption: null
      },
      expiresAt: Number(now()) + mediaWizardTtlMs
    };
    pendingWizards.set(key, wizard);
    persistMediaDraft(member, wizard);
    if (!recipient) {
      return {
        handled: true,
        reply: { text: "Кому отправить? " + familyMembers(member).filter(row => row.id !== member.id).map(row => row.name).join(" / ") }
      };
    }
    return {
      handled: true,
      reply: { text: "💌 Получатель: " + recipient.name + ". Когда отправить? Например: сегодня 19:00 или завтра 09:00." }
    };
  };
  const beforeDispatch = async (event, ctx) => {
    if (event?.channel !== "telegram") return undefined;
    const activeAgentId = sessionAgentId(ctx?.sessionKey) ?? String(ctx?.agentId ?? "").trim().toLowerCase();
    if (!activeAgentId) return undefined;
    const menuText = String(event?.content ?? "").trim();
    const wantsMenu = menuText === buttonText || menuText === "🏠 Семья";
    const member = resolveMember(db, runtimeId, activeAgentId);
    if (!member) return undefined;
    const directSession = String(ctx?.sessionKey ?? "").toLowerCase().includes(":telegram:direct:");
    const routeTarget = String(ctx?.conversationId ?? event?.senderId ?? ctx?.senderId ?? sessionDirectTarget(ctx?.sessionKey) ?? "").trim();
    if (directSession && event?.isGroup !== true && routeTarget) {
      const route = {
        runtimeId, agentId: activeAgentId, channel: "telegram", accountId: fallbackAccountId(activeAgentId, ctx),
        to: routeTarget.startsWith("telegram:") ? routeTarget : `telegram:${routeTarget}`
      };
      upsertMemberRoute(db, member.id, route);
      if (typeof ensurePersistentKeyboard === "function" && !getMemberKeyboardInstalledAt(db, member.id, { runtimeId, agentId: activeAgentId })) {
        const installKey = `${runtimeId}:${activeAgentId}:${member.id}:${route.accountId}:${route.to}`;
        if (!installingKeyboards.has(installKey)) {
          installingKeyboards.add(installKey);
          void Promise.resolve().then(() => ensurePersistentKeyboard({ route, member, buttonText })).then(installed => {
            if (installed === true) markMemberKeyboardInstalled(db, member.id, { runtimeId, agentId: activeAgentId, installedAt: new Date(now()).toISOString() });
          }).catch(() => {}).finally(() => installingKeyboards.delete(installKey));
        }
      }
    }
    const activeWizardKey = wizardKey(member, ctx?.sessionKey);
    if (wantsMenu) {
      pendingWizards.delete(activeWizardKey);
      deleteMediaDraft(member.id);
    }
    if (!wantsMenu) {
      let wizard = pendingWizards.get(activeWizardKey);
      if (!wizard) {
        wizard = loadMediaDraft(member, ctx?.sessionKey);
        if (wizard) pendingWizards.set(activeWizardKey, wizard);
      }
      if (wizard && wizard.expiresAt <= Number(now())) {
        pendingWizards.delete(activeWizardKey);
        if (String(wizard.mode).startsWith("capsule-media")) deleteMediaDraft(member.id);
        return undefined;
      }
      if (wizard) return handleWizardInput(member, wizard, event?.content);
      return undefined;
    }
    const menu = await dashboardView(db, member, calendar, calendarId, now, calendarTimeZone);
    queueMenu(ctx?.sessionKey, menu);
    return { handled: true, text: menu.text };
  };
  const replyPayloadSending = async (event) => {
    if (event?.channel !== "telegram") return undefined;
    const key = String(event?.sessionKey ?? "").trim();
    if (!key) return undefined;
    let payload = event?.payload ?? {};
    let changed = false;
    let isFamilyMenu = false;

    const pending = pendingMenus.get(key) ?? [];
    const currentTime = Number(now());
    const live = pending.filter(item => item.expiresAt > currentTime);
    const index = live.findIndex(item => item.text === payload?.text);
    if (index >= 0) {
      const [menu] = live.splice(index, 1);
      if (live.length) pendingMenus.set(key, live); else pendingMenus.delete(key);
      const existing = payload?.channelData ?? {};
      const telegram = existing.telegram ?? {};
      payload = {
        ...payload,
        channelData: {
          ...existing,
          telegram: { ...telegram, ...menu.channelData.telegram }
        }
      };
      changed = true;
      isFamilyMenu = true;
    } else if (pending.length) {
      if (live.length) pendingMenus.set(key, live); else pendingMenus.delete(key);
    }

    return changed ? { payload } : undefined;
  };
  const interactive = {
    channel: "telegram",
    namespace: "family",
    async handler(ctx) {
      const editMessage = async (value) => {
        try {
          return await ctx.respond.editMessage(value);
        } catch (error) {
          if (/message is not modified/iu.test(String(error?.message ?? error))) return undefined;
          throw error;
        }
      };
      if (ctx?.auth?.isAuthorizedSender !== true) {
        await ctx.respond.reply({ text: unauthorizedText() });
        return { handled: true };
      }
      const activeAgentId = sessionAgentId(ctx?.sessionKey) ?? agentId;
      const member = resolveMember(db, runtimeId, activeAgentId);
      if (!member) {
        await ctx.respond.reply({ text: unauthorizedText() });
        return { handled: true };
      }
      const callbackTarget = sessionDirectTarget(ctx?.sessionKey);
      if (callbackTarget) {
        upsertMemberRoute(db, member.id, {
          runtimeId,
          agentId: activeAgentId,
          channel: "telegram",
          accountId: fallbackAccountId(activeAgentId, ctx),
          to: callbackTarget.startsWith("telegram:") ? callbackTarget : `telegram:${callbackTarget}`
        });
      }
      const payload = String(ctx?.callback?.payload ?? "");
      if (payload === "close") {
        pendingWizards.delete(wizardKey(member, ctx?.sessionKey));
        await editMessage({ text: "🫶 Семья · меню закрыто", buttons: [] });
        return { handled: true };
      }
      if (payload === "menu") {
        pendingWizards.delete(wizardKey(member, ctx?.sessionKey));
        const menu = await dashboardView(db, member, calendar, calendarId, now, calendarTimeZone);
        await editMessage({ text: menu.text, buttons: menu.channelData.telegram.buttons });
        return { handled: true };
      }
      if (payload === "more") {
        const view = moreView();
        await editMessage({ text: view.text, buttons: view.buttons });
        return { handled: true };
      }
      if (payload === "help") {
        const view = helpView();
        await editMessage({ text: view.text, buttons: view.buttons });
        return { handled: true };
      }
      if (payload === "surprise") {
        const backRow = [[{ text: "‹ К семье", callback_data: "family:menu" }]];
        if (typeof sendSurpriseMedia !== "function") {
          await editMessage({
            text: card({
              sectionKey: "surprise",
              meta: "семейные сюрпризы",
              body: hand("Картинки пока недоступны")
            }),
            buttons: backRow
          });
          return { handled: true };
        }
        const surprise = selectManualSurprise({
          db, memberId: member.id, assetDir: surpriseAssetDir, now: Number(now()), random,
          manualLimit: surpriseManualLimit, unlimitedMemberIds: surpriseUnlimitedMemberIds
        });
        if (surprise.status === "empty") {
          await editMessage({
            text: card({
              sectionKey: "surprise",
              meta: "семейные сюрпризы",
              body: hand(emptyNote("surprise"))
            }),
            buttons: backRow
          });
          return { handled: true };
        }
        if (surprise.status === "cooldown") {
          const minutes = Math.max(1, Math.ceil((surprise.cooldownUntil - Number(now())) / 60000));
          await editMessage({
            text: card({
              sectionKey: "surprise",
              meta: `следующий вкладыш через ${minutes} мин`,
              body: hand("Пока хватит секретов")
            }),
            buttons: backRow
          });
          return { handled: true };
        }
        try {
          await sendSurpriseMedia({
            member, agentId: activeAgentId, filePath: surprise.filePath, source: "manual",
            caption: "💝 Семейный сюрприз ♡"
          });
        } catch (error) {
          releaseManualSurprise({ db, memberId: member.id, viewId: surprise.viewId });
          await editMessage({
            text: card({
              sectionKey: "surprise",
              meta: "не отправилось",
              body: hand("Просмотр не засчитан — можно нажать ещё раз")
            }),
            buttons: [[{ text: "Ещё раз ✨", callback_data: "family:surprise" }], ...backRow]
          });
          return { handled: true };
        }
        const remainLine = surprise.limit == null
          ? "Можно смотреть дальше без ограничений"
          : surprise.remaining > 0
            ? `Открыто ${surprise.used} из ${surprise.limit} на этот час`
            : `Пока хватит секретов: ${surprise.limit} из ${surprise.limit} на этот час. Следующий — через час`;
        const openRow = surprise.remaining > 0 || surprise.limit == null
          ? [[{ text: "Ещё один ✨", callback_data: "family:surprise" }]]
          : [];
        await editMessage({
          text: card({ sectionKey: "surprise", meta: "вкладыш открыт", body: hand(remainLine) }),
          buttons: [...openRow, ...backRow]
        });
        return { handled: true };
      }
      if (payload === "wizard:cancel") {
        pendingWizards.delete(wizardKey(member, ctx?.sessionKey));
        const menu = await dashboardView(db, member, calendar, calendarId, now, calendarTimeZone);
        await editMessage({ text: menu.text, buttons: menu.channelData.telegram.buttons });
        return { handled: true };
      }
      if (payload.startsWith("create:")) {
        const section = payload.slice(7);
        const view = beginWizard(member, section, "create", ctx?.sessionKey);
        if (view) {
          await editMessage(view);
          return { handled: true };
        }
      }
      if (payload === "search:notes") {
        const view = beginWizard(member, "notes", "search", ctx?.sessionKey);
        await editMessage(view);
        return { handled: true };
      }
      if (payload.startsWith("shopping:toggle:")) {
        const id = payload.slice("shopping:toggle:".length);
        executeFamilyAction({
          db, member, params: { action: "toggle_shopping_item", shoppingItemId: id },
          actionKey: `family-ui-shopping:${runtimeId}:${agentId}:${member.id}:${ctx?.callback?.id ?? randomUUID()}`
        });
        await editMessage(sectionView(db, "shopping", member));
        return { handled: true };
      }
      if (payload === "shopping:clear") {
        executeFamilyAction({
          db, member, params: { action: "clear_bought_shopping" },
          actionKey: `family-ui-shopping-clear:${runtimeId}:${agentId}:${member.id}:${ctx?.callback?.id ?? randomUUID()}`
        });
        await editMessage(sectionView(db, "shopping", member));
        return { handled: true };
      }
      if (payload.startsWith("item:")) {
        const [, section, id] = payload.split(":");
        const view = itemView(db, section, id, member);
        if (view) {
          await editMessage(view);
          return { handled: true };
        }
      }
      if (payload.startsWith("do:")) {
        const [, op, section, id] = payload.split(":");
        if (op === "edit") {
          const view = beginEditWizard(member, section, id, ctx?.sessionKey);
          if (view) {
            await editMessage(view);
            return { handled: true };
          }
        }
        const view = confirmationView(op, section, id);
        if (view) {
          await editMessage(view);
          return { handled: true };
        }
      }
      if (payload.startsWith("apply:")) {
        const [, op, section, id] = payload.split(":");
        applyItemOperation(member, op, section, id);
        const view = section === "calendar"
          ? await calendarView(db, calendar, calendarId, now, calendarTimeZone)
          : (sectionView(db, section, member) ?? buildMainMenu(member));
        await editMessage(view.channelData ? { text: view.text, buttons: view.channelData.telegram.buttons } : view);
        return { handled: true };
      }
      if (payload.startsWith("reserve:wishes:")) {
        const id = payload.slice("reserve:wishes:".length);
        applyItemOperation(member, "reserve", "wishes", id);
        const view = itemView(db, "wishes", id, member) ?? sectionView(db, "wishes", member);
        await editMessage(view);
        return { handled: true };
      }
      if (payload.startsWith("vote:")) {
        const [, pollId, optionIndex] = payload.split(":");
        applyItemOperation(member, "vote", "polls", pollId, { optionIndex });
        const view = itemView(db, "polls", pollId, member) ?? sectionView(db, "polls", member);
        await editMessage(view);
        return { handled: true };
      }
      if (payload.startsWith("section:")) {
        const section = payload.slice(8);
        if (section === "calendar" && calendarId && isCalendarGateOpen(db, calendarId) && calendar && typeof calendar.getEvent === "function") {
          // Reconciliation against Google Calendar is the only slow step in the
          // family UI: show a paper "loading" card on the same message first so
          // the person sees an intentional state instead of a frozen menu.
          await editMessage({ text: loadingCard("calendar"), buttons: navigationButtons() });
          const stamp = Number(now());
          try {
            await reconcileFamilyCalendarEvents({
              db, calendar, calendarId: calendarId ?? "family",
              from: new Date(stamp - 24 * 60 * 60 * 1000).toISOString(),
              to: new Date(stamp + 366 * 24 * 60 * 60 * 1000).toISOString()
            });
          } catch {}
        }
        const view = section === "calendar"
          ? await calendarView(db, calendar, calendarId, now, calendarTimeZone)
          : sectionView(db, section, member);
        if (view) {
          await editMessage(view);
          return { handled: true };
        }
      }
      await ctx.respond.reply({ text: "Меню устарело. Нажми 🫶 Семья ещё раз." });
      return { handled: true };
    }
  };
  interactive.handle = interactive.handler;

  return { command, inboundClaim, beforeDispatch, replyPayloadSending, interactive };
}
export function registerFamilyHub(api, options) {
  const runtime = createFamilyRuntime(options);
  api.registerCommand(runtime.command);
  api.registerInteractiveHandler(runtime.interactive);
  api.registerTool((toolContext) => createFamilyTool({
    ...options, agentId: toolContext?.agentId ?? options.agentId, toolContext
  }), { names: ["family"], optional: true });
  api.on("inbound_claim", runtime.inboundClaim, { timeoutMs: 3000 });
  api.on("before_dispatch", runtime.beforeDispatch, { timeoutMs: 3000 });
  api.on("reply_payload_sending", runtime.replyPayloadSending, { timeoutMs: 3000 });
  return runtime;
}

export function registerConfiguredFamilyHub(api, { installPersistentKeyboard = null, resolveTelegramAccount = null } = {}) {
  const cfg = api.pluginConfig ?? {};
  const dataDir = cfg.dataDir ?? (cfg.dbPath ? path.dirname(cfg.dbPath) : path.join(homedir(), ".openclaw", "family-hub"));
  const dbPath = cfg.dbPath ?? path.join(dataDir, "family.sqlite");
  const runtimeId = cfg.runtimeId ?? "family";
  const agentId = cfg.agentId ?? "main";
  const db = openFamilyDb(dbPath);
  const calendarId = String(cfg.calendarId ?? "").trim() || null;
  const reminderTime = String(cfg.reminderTime ?? "09:00").trim() || "09:00";
  const reminderTimezone = String(cfg.reminderTimezone ?? "Europe/Moscow").trim() || "Europe/Moscow";
  const surpriseAssetDir = String(cfg.surpriseAssetDir ?? path.join(dataDir, "surprises")).trim() || path.join(dataDir, "surprises");
  const surpriseMediaDir = String(cfg.surpriseMediaDir ?? path.join(dataDir, "media")).trim() || path.join(dataDir, "media");
  const capsuleMediaDir = `${surpriseMediaDir.replace(/\/$/u, "")}/capsules`;
  const surpriseManualLimitRaw = Number(cfg.surpriseManualLimit);
  const surpriseManualLimit = Number.isInteger(surpriseManualLimitRaw) && surpriseManualLimitRaw >= 1 && surpriseManualLimitRaw <= 1000 ? surpriseManualLimitRaw : 10;
  const surpriseUnlimitedMemberIds = Array.isArray(cfg.surpriseUnlimitedMemberIds)
    ? cfg.surpriseUnlimitedMemberIds.filter(v => typeof v === "string")
    : [];
  const miniAppUrl = String(cfg.miniAppUrl ?? cfg.appUrl ?? "").trim();
  const placePhotoDir = String(cfg.placePhotoDir ?? path.join(dataDir, "place-photos")).trim() || path.join(dataDir, "place-photos");
  const driveFolderId = String(cfg.driveFolderId ?? "").trim() || null;
  const calendar = calendarId ? createGwsCalendarAdapter({
    run: createGwsCliRunner(), calendarId
  }) : null;
  let gatewayConfig = null;
  const accountToken = (accountId) => {
    if (!gatewayConfig || typeof resolveTelegramAccount !== "function") return null;
    try { return resolveTelegramAccount({ cfg: gatewayConfig, accountId })?.token ?? null; } catch { return null; }
  };
  const sendSurpriseMedia = async ({ member, agentId: memberAgentId = agentId, filePath, caption }) => {
    if (!gatewayConfig) throw new Error("family gateway config not ready");
    const route = getMemberRoute(db, member.id, { runtimeId, agentId: memberAgentId });
    if (!route) throw new Error("family member route not available");
    const adapter = await api.runtime.channel.outbound.loadAdapter(route.channel);
    if (!adapter?.sendMedia) throw new Error(`outbound media adapter unavailable: ${route.channel}`);
    const mediaUrl = stageSurpriseAsset(filePath, surpriseMediaDir);
    return adapter.sendMedia({
      cfg: gatewayConfig, to: route.to, text: caption ?? "", mediaUrl,
      mediaLocalRoots: [surpriseMediaDir], accountId: route.accountId ?? null
    });
  };
  const handlers = {
    ...createCalendarOutboxHandlers({ db, calendar, calendarId }),
    ...createCapsuleOutboxHandlers({
      db,
      sendMedia: async (row) => {
        const member = db.prepare("SELECT id,name,role,household_id AS householdId FROM members WHERE id=?").get(row.recipientMemberId);
        if (!member) throw new Error("capsule recipient missing");
        const binding = db.prepare("SELECT agent_id AS agentId FROM agent_bindings WHERE runtime_id=? AND member_id=? ORDER BY agent_id LIMIT 1")
          .get(runtimeId, member.id);
        if (!binding?.agentId) throw new Error("capsule recipient binding missing");
        return sendSurpriseMedia({
          member,
          agentId: binding.agentId,
          filePath: String(row.payload?.filePath ?? ""),
          caption: String(row.payload?.caption ?? "")
        });
      }
    }),
    async surprise_media(row) {
      const member = db.prepare("SELECT id,name,role,household_id AS householdId FROM members WHERE id=?")
        .get(row.recipientMemberId);
      if (!member) throw new Error("surprise recipient missing");
      return sendSurpriseMedia({
        member,
        agentId: String(row.payload?.agentId ?? agentId),
        filePath: String(row.payload?.filePath ?? ""),
        caption: String(row.payload?.caption ?? "")
      });
    }
  };
  registerFamilyHub(api, {
    db, runtimeId, agentId, buttonText: cfg.buttonText ?? DEFAULT_BUTTON,
    calendar, calendarId, calendarTimeZone: reminderTimezone,
    surpriseAssetDir, capsuleMediaDir, sendSurpriseMedia,
    surpriseManualLimit, surpriseUnlimitedMemberIds,
    ensurePersistentKeyboard: async ({ route, member, buttonText }) => {
      if (!gatewayConfig || typeof installPersistentKeyboard !== "function") return false;
      return installPersistentKeyboard({ cfg: gatewayConfig, route, member, buttonText });
    }
  });
  const miniApp = familyMiniapp({
    db,
    appUrl: miniAppUrl,
    accountToken,
    calendarId,
    surpriseAssetDir,
    surpriseMediaDir,
    surpriseManualLimit,
    surpriseUnlimitedMemberIds,
    placePhotoDir,
    driveFolderId,
    logger: api.logger,
    sendMedia: async ({ route, filePath, caption }) => {
      if (!gatewayConfig) throw new Error("family gateway config not ready");
      const adapter = await api.runtime.channel.outbound.loadAdapter("telegram");
      if (!adapter?.sendMedia) throw new Error("outbound media adapter unavailable: telegram");
      const mediaUrl = stageSurpriseAsset(filePath, surpriseMediaDir);
      return adapter.sendMedia({
        cfg: gatewayConfig, to: route.to, text: caption ?? "", mediaUrl,
        mediaLocalRoots: [surpriseMediaDir], accountId: route.accountId ?? null
      });
    }
  });
  const notifications = createFamilyNotifications({
    db,
    tokenForAccount: accountToken,
    appUrl: miniAppUrl,
    logger: api.logger
  });
  api.registerHttpRoute({ path: "/family-app", match: "prefix", auth: "plugin", handler: miniApp.handle });
  const installMiniAppMenuButtons = async () => {
    if (!miniAppUrl || !gatewayConfig || stopped) return;
    let routes;
    try {
      routes = db.prepare("SELECT account_id AS accountId,target FROM member_routes WHERE channel='telegram'").all();
    } catch { return; }
    for (const route of routes) {
      if (stopped || !gatewayConfig) return;
      const chatId = /^telegram:(\d+)$/.exec(String(route?.target ?? ""))?.[1];
      if (!chatId) continue;
      let token;
      try {
        token = typeof resolveTelegramAccount === "function"
          ? (resolveTelegramAccount({ cfg: gatewayConfig, accountId: route?.accountId ?? "default" })?.token ?? null)
          : null;
      } catch { token = null; }
      if (!token) continue;
      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ chat_id: Number(chatId), menu_button: { type: "web_app", text: "🫶 Семья", web_app: { url: miniAppUrl } } })
        });
        const result = await response.json();
        if (!response.ok || !result?.ok) api.logger?.warn?.("family-hub: Telegram menu button was rejected");
      } catch { api.logger?.warn?.("family-hub: Telegram menu button could not be configured"); }
    }
  };
  let timer = null;
  let inFlight = null;
  let stopped = true;
  let lastReminderMinute = null;
  let lastPushTick = 0;
  let lastCalendarScan = 0;
  const send = async (ctx, route, text) => {
    const adapter = await api.runtime.channel.outbound.loadAdapter(route.channel);
    if (!adapter?.sendText) throw new Error(`outbound text adapter unavailable: ${route.channel}`);
    return adapter.sendText({ cfg: ctx.config, to: route.to, text, accountId: route.accountId ?? null });
  };
  const runOutbox = async (ctx) => {
    try {
      const now = new Date();
      const nowMs = now.getTime();
      const minuteKey = Math.floor(nowMs / 60000);
      const generateReminders = minuteKey !== lastReminderMinute;
      if (generateReminders) lastReminderMinute = minuteKey;
      const boundAgents = db.prepare("SELECT agent_id AS agentId FROM agent_bindings WHERE runtime_id=? ORDER BY agent_id")
        .all(runtimeId).map(row => row.agentId);
      const agentIds = boundAgents.length ? boundAgents : [agentId];
      for (let i = 0; i < agentIds.length; i += 1) {
        if (stopped) break;
        const boundAgentId = agentIds[i];
        await runFamilyMaintenance({
          db,
          workerId: `${runtimeId}:${boundAgentId}:${process.pid}`,
          runtimeId,
          agentId: boundAgentId,
          now,
          reminderTime,
          reminderTimezone,
          generateReminders: generateReminders && i === 0,
          handlers,
          send: (route, text) => send(ctx, route, text)
        });
      }
      if (!stopped && nowMs - lastPushTick >= 15000) {
        lastPushTick = nowMs;
        try { await notifications.tick(); } catch (error) { ctx.logger?.warn?.(`family-miniapp push: ${error?.message ?? String(error)}`); }
      }
      if (!stopped && nowMs - lastCalendarScan >= 180000) {
        lastCalendarScan = nowMs;
        try { await miniApp.scanCalendar(); } catch (error) { ctx.logger?.warn?.(`family-miniapp calendar: ${error?.message ?? String(error)}`); }
      }
    } catch (error) {
      ctx.logger?.warn?.(`family-hub maintenance: ${error?.message ?? String(error)}`);
    }
    if (!stopped) {
      timer = setTimeout(() => { void runOutboxOnce(ctx); }, 5000);
      timer.unref?.();
    }
  };
  const closeMiniAppWorkers = () => {
    try { notifications.close(); } catch {}
    try { miniApp.close(); } catch {}
  };
  const runOutboxOnce = (ctx) => {
    if (inFlight) return inFlight;
    inFlight = runOutbox(ctx).finally(() => { inFlight = null; });
    return inFlight;
  };
  api.registerService({
    id: "family-hub-outbox",
    async start(ctx) {
      gatewayConfig = ctx.config;
      stopped = false;
      if (timer) clearTimeout(timer);
      timer = null;
      lastPushTick = 0;
      lastCalendarScan = 0;
      void installMiniAppMenuButtons().catch((error) => ctx.logger?.warn?.(`family-miniapp menu: ${error?.message ?? String(error)}`));
      await runOutboxOnce(ctx);
    },
    async stop() {
      gatewayConfig = null;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await inFlight;
      closeMiniAppWorkers();
    }
  });
  api.on("gateway_stop", async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    await inFlight;
    closeMiniAppWorkers();
    try { db.close(); } catch {}
  }, { timeoutMs: 3000 });
}

export { createGwsCalendarAdapter, createGwsCliRunner, syncActionCalendar } from "./calendar.js";
