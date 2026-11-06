/**
 * Family Hub · Family Hub design system.
 *
 * This module is the single source of truth for the visual language of the
 * Family Hub Telegram surface. It contains:
 *
 *   1. PALETTE      — the warm cream / pastel palette used by the Control UI
 *                     preview renderer and by the design documentation.
 *   2. SECTION_META — icon, accent and microcopy for every family section.
 *   3. text builders — the typographic vocabulary Telegram can actually render
 *                     (bold, italic, monospace, blockquote, dashed rule).
 *   4. state cards  — empty, loading, error and confirmation compositions.
 *
 * Why the palette is not applied to Telegram itself: Telegram messages have no
 * CSS. The host renders plugin text as markdown into Telegram HTML, so the
 * hierarchy is carried by bold / italic / `code` / > quote / ┄ rules and by a
 * consistent icon per section. The palette defines what "cream + pastel" means
 * for every surface that *can* show colour (preview, docs, future clients).
 *
 * No runtime dependencies. Safe to import from tests and tools.
 */

/** Warm collectible-card palette. Mirrors paper family card inserts. */
export const PALETTE = Object.freeze({
  paper: "#FBF3E4",
  paperSoft: "#FFFBF2",
  ink: "#4A3B32",
  inkSoft: "#8A7566",
  line: "#E7D9C3",
  sky: "#A8C8E8",
  skyInk: "#4E7CA8",
  blush: "#F2B8C6",
  blushInk: "#C4657F",
  butter: "#F7DFA1",
  butterInk: "#B98B2E",
  mint: "#B8DCC8",
  mintInk: "#4F8A6B",
  lilac: "#CFC0E8",
  lilacInk: "#7A66A8"
});

/** Dashed paper rule. Renders in Telegram as a soft separator. */
export const RULE = "┄┄┄┄┄┄┄┄┄┄┄┄┄┄";

/**
 * Section vocabulary. `accent` names a palette token, `hint` is the small
 * handwritten line that closes a card and tells the person what to do next.
 */
export const SECTION_META = Object.freeze({
  calendar: { icon: "🗓", label: "Вместе", accent: "sky", hint: "Общие события семьи" },
  shopping: { icon: "🛒", label: "Купить", accent: "butter", hint: "Отмечай купленное касанием" },
  actions: { icon: "📌", label: "Дела", accent: "mint", hint: "Кто что делает и к какому сроку" },
  notes: { icon: "📝", label: "Записки", accent: "lilac", hint: "Общие заметки семьи" },
  planning: { icon: "🧭", label: "Планы", accent: "sky", hint: "Планы, места и цели рядом" },
  plans: { icon: "🧳", label: "Планы", accent: "sky", hint: "Куда и зачем собираемся" },
  places: { icon: "📍", label: "Куда", accent: "mint", hint: "Места, куда хочется попасть" },
  goals: { icon: "🌱", label: "Цели", accent: "butter", hint: "Копим вместе" },
  wishes: { icon: "🎁", label: "Хочу", accent: "blush", hint: "Желания — можно зарезервировать подарок" },
  polls: { icon: "💬", label: "Выбрать", accent: "lilac", hint: "Результаты видны после голоса" },
  capsules: { icon: "📦", label: "Капсулы", accent: "sky", hint: "Содержимое откроется в свой час" },
  cashback: { icon: "💳", label: "Кэшбэк", accent: "mint", hint: "Выгодные категории месяца" },
  surprise: { icon: "💝", label: "Сюрприз", accent: "blush", hint: "Семейный сюрприз" },
  more: { icon: "✨", label: "Ещё", accent: "lilac", hint: "Дополнительные разделы" },
  help: { icon: "ℹ️", label: "Как это работает", accent: "butter", hint: "Короткая шпаргалка" }
});

export const CARD_TITLE = "🫶 Семья";

/**
 * Telegram renders plugin text as markdown, so a bare `<b>` typed by a family
 * member would become a real HTML tag. Break the tag with a zero-width space so
 * the text stays literal, and escape characters that would re-format a line.
 */
const ZERO_WIDTH = "\u200b";
const HTML_TAG = /<\s*\/?\s*(?:b|i|u|s|code|pre|a|tg-spoiler|blockquote)\b/giu;
const MARKDOWN_CHARS = /([\\*_`~|[\]])/gu;

/** Escape untrusted text that is embedded into a formatted card. */
export function safe(value) {
  const raw = String(value ?? "");
  if (!raw) return "";
  return raw
    .replace(HTML_TAG, match => match.replace("<", `<${ZERO_WIDTH}`))
    .replace(MARKDOWN_CHARS, "\\$1")
    .replace(/^(\s*)>/u, "$1\\>");
}

/** Escape a URL for embedding without touching characters linkify depends on. */
export function safeUrl(value) {
  return String(value ?? "").replace(HTML_TAG, match => match.replace("<", `<${ZERO_WIDTH}`));
}

export function bold(value) {
  return `**${safe(value)}**`;
}

export function italic(value) {
  return `_${safe(value)}_`;
}

export function code(value) {
  return `\`${String(value ?? "").replace(/`/gu, "'")}\``;
}

/** Handwritten accent: a soft quote line, used to close a card warmly. */
export function hand(value) {
  return `> ♡ ${safe(value)}`;
}

export function rule() {
  return RULE;
}

export function title(sectionKey) {
  const meta = SECTION_META[sectionKey];
  return meta ? `**${meta.icon} ${meta.label}**` : `**${safe(sectionKey)}**`;
}

export function metaLine(value) {
  const raw = String(value ?? "").trim();
  return raw ? italic(raw) : "";
}

export function bullet(lines, marker = "•") {
  return lines.filter(Boolean).map(line => `${marker} ${line}`).join("\n");
}

/**
 * Compose a paper card: title, optional italic meta line, rule, body, note.
 * Empty parts collapse so no card ever shows a dangling separator.
 */
export function card({ sectionKey = null, heading = null, meta = "", body = "", note = "", showRule = true } = {}) {
  const head = heading ?? (sectionKey ? title(sectionKey) : "");
  const bodyText = Array.isArray(body) ? body.filter(Boolean).join("\n\n") : String(body ?? "");
  const parts = [];
  if (head) parts.push(head);
  const metaText = Array.isArray(meta) ? meta.filter(Boolean).join(" · ") : String(meta ?? "");
  if (metaText) parts.push(metaLine(metaText));
  if (showRule && bodyText) parts.push(rule());
  if (bodyText) parts.push(bodyText);
  if (note) parts.push(hand(note));
  return parts.join("\n\n");
}

/** Russian plural picker: plural(2, "дело", "дела", "дел"). */
export function plural(count, one, few, many) {
  const n = Math.abs(Number(count) || 0);
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function truncate(value, max = 46) {
  const text = String(value ?? "Без названия").replace(/\s+/gu, " ").trim() || "Без названия";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** True when a section has a create wizard behind `family:create:<section>`. */
export function countLabel(sectionKey, count) {
  const n = Number(count) || 0;
  if (!n) return "пока пусто";
  if (sectionKey === "shopping") return `${n} ${plural(n, "позиция", "позиции", "позиций")}`;
  if (sectionKey === "actions") return `${n} ${plural(n, "дело", "дела", "дел")}`;
  if (sectionKey === "notes") return `${n} ${plural(n, "заметка", "заметки", "заметок")}`;
  if (sectionKey === "wishes") return `${n} ${plural(n, "желание", "желания", "желаний")}`;
  if (sectionKey === "places") return `${n} ${plural(n, "место", "места", "мест")}`;
  if (sectionKey === "plans") return `${n} ${plural(n, "план", "плана", "планов")}`;
  if (sectionKey === "goals") return `${n} ${plural(n, "цель", "цели", "целей")}`;
  if (sectionKey === "polls") return `${n} ${plural(n, "голосование", "голосования", "голосований")}`;
  if (sectionKey === "capsules") return `${n} ${plural(n, "капсула", "капсулы", "капсул")}`;
  if (sectionKey === "calendar") return `${n} ${plural(n, "событие", "события", "событий")}`;
  return `${n}`;
}

const EMPTY_NOTES = {
  actions: "Пока никто ничего не делает. Добавь первое дело.",
  shopping: "Список пуст. Добавь, что нужно купить.",
  notes: "Записок нет. Первая заметка будет видна всей семье.",
  wishes: "Желаний пока нет. Самое время помечтать.",
  places: "Мест нет. Запиши, куда хочется поехать.",
  plans: "Планов нет. Начни с одного — хоть с отпуска.",
  polls: "Голосований нет. Спроси семью о чём угодно.",
  capsules: "Капсул нет. Запечатай открытку на будущее.",
  cashback: "Категории кэшбэка пока не загружены.",
  goals: "Целей нет. Поставь первую — и копите вместе.",
  calendar: "Ближайших событий нет.",
  surprise: "Здесь пока тихо.",
  planning: "Пока пусто."
};

export function emptyNote(sectionKey) {
  return EMPTY_NOTES[sectionKey] ?? "Пока пусто.";
}

/** Empty state: warm paper card with a hint and no invented data. */
export function emptyCard(sectionKey) {
  const meta = SECTION_META[sectionKey];
  return card({
    sectionKey,
    meta: meta ? meta.hint : "",
    body: hand(emptyNote(sectionKey)),
    showRule: false
  });
}

/** Loading state — used while a slow section (Google Calendar) is fetched. */
export function loadingCard(sectionKey) {
  const meta = SECTION_META[sectionKey];
  return card({
    heading: meta ? `**${meta.icon} ${meta.label}**` : "",
    meta: "секунду…",
    body: hand(sectionKey === "calendar" ? "Заглядываю в календарь" : "Собираю данные"),
    showRule: false
  });
}

const ERROR_NOTES = {
  calendar: "Календарь временно недоступен.",
  default: "Не получилось загрузить данные."
};

/** Error state: says what failed and what still works. */
export function errorCard(sectionKey, detail = null) {
  const meta = SECTION_META[sectionKey];
  const reason = detail || ERROR_NOTES[sectionKey] || ERROR_NOTES.default;
  return card({
    heading: meta ? `**${meta.icon} ${meta.label}**` : "",
    meta: "не удалось",
    body: [safe(reason), hand("Попробуй ещё раз через минуту")],
    showRule: false
  });
}

/**
 * Main navigation: the eight family shortcuts plus close, two per row so every
 * button stays finger-sized on iPhone. Ключи совпадают с разделом-роутом.
 */
export const MAIN_NAV = Object.freeze([
  ["actions", "shopping"],
  ["calendar", "notes"],
  ["places", "wishes"],
  ["surprise", "more"]
]);

/** Secondary sections live behind ✨ Ещё. */
export const MORE_NAV = Object.freeze([
  ["planning", "goals"],
  ["polls", "capsules"],
  ["cashback", "search"],
  ["help"]
]);

export function navButton(sectionKey) {
  const meta = SECTION_META[sectionKey];
  return { text: `${meta.icon} ${meta.label}`, callback_data: `family:section:${sectionKey}` };
}

export function mainNavigationButtons() {
  const rows = MAIN_NAV.map(row => row.map(sectionKey => (sectionKey === "surprise"
    ? { text: `${SECTION_META.surprise.icon} ${SECTION_META.surprise.label}`, callback_data: "family:surprise" }
    : sectionKey === "more"
      ? { text: `${SECTION_META.more.icon} ${SECTION_META.more.label}`, callback_data: "family:more" }
      : navButton(sectionKey))));
  rows.push([{ text: "👋 Закрыть", callback_data: "family:close" }]);
  return rows;
}

export function moreNavigationButtons() {
  const rows = MORE_NAV.map(row => row.map(entry => {
    if (entry === "search") return { text: "🔎 Поиск", callback_data: "family:search:notes" };
    if (entry === "help") return { text: `${SECTION_META.help.icon} ${SECTION_META.help.label}`, callback_data: "family:help" };
    return navButton(entry);
  }));
  rows.push([
    { text: "‹ К семье", callback_data: "family:menu" },
    { text: "👋 Закрыть", callback_data: "family:close" }
  ]);
  return rows;
}

export const HELP_TEXT = [
  "**ℹ️ Как это работает**",
  "_короткая шпаргалка_",
  RULE,
  bullet([
    "**Дела** — кто что делает и к какому сроку",
    "**Купить** — общий список покупок",
    "**Вместе** — семейный календарь Google",
    "**Записки** — общие заметки с поиском",
    "**Куда** — места, куда хочется попасть",
    "**Хочу** — желания, подарок можно зарезервировать",
    "**Сюрприз** — семейный сюрприз",
    "**Ещё** — планы, цели, голосования, капсулы, кэшбэк"
  ]),
  hand("Можно писать словами: «Купи корм завтра»")
].join("\n\n");
