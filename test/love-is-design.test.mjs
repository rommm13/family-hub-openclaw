/**
 * Family Cards design system + redesigned Family Hub screens.
 *
 * These tests pin the visual contract: card composition, empty / loading /
 * error states, the two-level navigation and the Family Cards surprise card.
 * They also pin that untrusted family text can never inject Telegram HTML.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createNote, createAction, addShoppingItems } from "../dist/domain.js";
import { createFamilyRuntime } from "../dist/index.js";
import { card, safe, hand, bullet, plural, countLabel, emptyNote, RULE, PALETTE, SECTION_META } from "../dist/theme.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-loveis-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [
      { id: "participant_alpha", name: "Иван", role: "parent" },
      { id: "participant_beta", name: "Мария", role: "parent" }
    ],
    bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }]
  });
  const assets = path.join(dir, "family-cards");
  fs.mkdirSync(assets, { recursive: true });
  for (let i = 1; i <= 4; i += 1) fs.writeFileSync(path.join(assets, `loveis-000${i}.jpg`), `image-${i}`);
  return { dir, db, assets };
}

function cleanup(fx) {
  fx.db.close();
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

async function openSection(runtime, section, sessionKey = "agent:main:telegram:direct:1") {
  const edits = [];
  await runtime.interactive.handler({
    sessionKey,
    auth: { isAuthorizedSender: true },
    callback: { payload: `section:${section}` },
    respond: { async editMessage(v) { edits.push(v); }, async reply() {} }
  });
  return edits;
}

test("design system keeps a warm palette and one accent per section", () => {
  assert.equal(PALETTE.paper, "#FBF3E4");
  assert.equal(PALETTE.ink, "#4A3B32");
  for (const [key, meta] of Object.entries(SECTION_META)) {
    assert(meta.icon, `section ${key} needs an icon`);
    assert(meta.label, `section ${key} needs a label`);
    assert(meta.accent in PALETTE || `${meta.accent}Ink` in PALETTE, `section ${key} accent must exist in the palette`);
    assert(meta.label.length <= 18, `section ${key} label must stay compact`);
  }
});

test("cards never leave a dangling rule or duplicated blank lines", () => {
  assert.equal(card({ sectionKey: "notes", meta: "1 заметка", body: bullet(["Wi-Fi"]) }), "**📝 Записки**\n\n_1 заметка_\n\n" + RULE + "\n\n• Wi-Fi");
  assert.equal(card({ sectionKey: "notes", showRule: false }), "**📝 Записки**");
  const empty = card({ sectionKey: "wishes", body: hand(emptyNote("wishes")), showRule: false });
  assert.equal(empty.includes(RULE), false);
  assert.match(empty, /♡/);
});

test("untrusted family text cannot inject Telegram markup", () => {
  assert.equal(safe("<b>жирный</b>"), "<\u200bb>жирный<\u200b/b>");
  assert.equal(safe("2 * 3"), "2 \\* 3");
  assert.equal(safe("под_черк_"), "под\\_черк\\_");
  assert.equal(safe("a | b"), "a \\| b");
  const view = { text: card({ sectionKey: "notes", body: safe("<b>взлом</b>") }) };
  assert.equal(/<b>/u.test(view.text), false);
});

test("russian plural helper keeps counts readable", () => {
  assert.equal(plural(1, "дело", "дела", "дел"), "дело");
  assert.equal(plural(3, "дело", "дела", "дел"), "дела");
  assert.equal(plural(11, "дело", "дела", "дел"), "дел");
  assert.equal(countLabel("shopping", 2), "2 позиции");
  assert.equal(countLabel("notes", 0), "пока пусто");
});

test("today card shows the date, today's brief and the primary navigation", async () => {
  const fx = fixture();
  try {
    createAction(fx.db, { householdId: "home", createdBy: "participant_alpha", assigneeId: "participant_alpha", title: "Оплатить страховку", dueAt: "2026-09-18", allDay: true });
    addShoppingItems(fx.db, { householdId: "home", createdBy: "participant_alpha", items: ["Молоко", "Яйца"] });
    const calendar = { async listUpcomingEvents() { return [{ id: "g1", summary: "Ужин с родителями", start: "2026-09-18T16:30:00Z", allDay: false }]; } };
    const runtime = createFamilyRuntime({
      db: fx.db, runtimeId: "agent_core", agentId: "main", calendar,
      now: () => Date.parse("2026-09-18T06:00:00+03:00")
    });
    const claimed = await runtime.beforeDispatch(
      { content: "🫶 Семья", channel: "telegram" },
      { sessionKey: "agent:main:telegram:direct:123", conversationId: "123", accountId: "default" }
    );
    assert.match(claimed.text, /🫶 \*\*Семья\*\*|🫶 Семья/);
    assert.match(claimed.text, /пятница, 18 сентября/);
    assert.match(claimed.text, /\*\*Сегодня\*\*/);
    assert.match(claimed.text, /Купить · 2/);
    const labels = claimed.text.match(/♡ .*/u);
    assert(labels, "dashboard closes with a handwritten line");
  } finally { cleanup(fx); }
});

test("empty sections render a warm state and still offer the create action", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    for (const section of ["actions", "notes", "wishes", "places", "plans", "polls", "goals", "capsules"]) {
      const edits = await openSection(runtime, section);
      assert.equal(edits.length, 1);
      const view = edits[0];
      assert.match(view.text, /♡/, `empty ${section} card needs a handwritten hint`);
      assert.equal(view.text.includes(RULE), false, `empty ${section} card must not draw a rule without content`);
      assert(view.buttons.flat().some(b => b.callback_data === `family:create:${section}`));
    }
  } finally { cleanup(fx); }
});

test("calendar shows a loading card before the reconciled list", async () => {
  const fx = fixture();
  try {
    const calendar = {
      async getEvent() { return null; },
      async listUpcomingEvents() { return [{ id: "g1", summary: "Годовщина", start: "2026-09-18", allDay: true }]; }
    };
    const runtime = createFamilyRuntime({
      db: fx.db, runtimeId: "agent_core", agentId: "main", calendar, calendarId: "family",
      now: () => Date.parse("2026-09-16T20:00:00Z"), calendarTimeZone: "Europe/Moscow"
    });
    const edits = await openSection(runtime, "calendar");
    assert.equal(edits.length, 2);
    assert.match(edits[0].text, /Заглядываю в календарь/);
    assert.match(edits[0].text, /секунду/);
    assert.match(edits[1].text, /18\.09 · Годовщина/);
  } finally { cleanup(fx); }
});

test("calendar failure keeps the warm error state and navigation", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({
      db: fx.db, runtimeId: "agent_core", agentId: "main",
      calendar: { async listUpcomingEvents() { throw new Error("offline"); } }
    });
    const edits = await openSection(runtime, "calendar");
    assert.match(edits.at(-1).text, /Календарь временно недоступен/);
    const callbacks = edits.at(-1).buttons.flat().map(b => b.callback_data);
    assert(callbacks.includes("family:create:calendar"));
    assert(callbacks.includes("family:menu"));
    assert(callbacks.includes("family:close"));
  } finally { cleanup(fx); }
});

test("Ещё screen carries secondary sections and the family cheat sheet", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const more = [];
    await runtime.interactive.handler({
      sessionKey: "agent:main:telegram:direct:1",
      auth: { isAuthorizedSender: true },
      callback: { payload: "more" },
      respond: { async editMessage(v) { more.push(v); }, async reply() {} }
    });
    const callbacks = more.at(-1).buttons.flat().map(b => b.callback_data);
    for (const expected of ["family:section:planning", "family:section:goals", "family:section:polls", "family:section:capsules", "family:section:cashback", "family:search:notes", "family:help"])
      assert(callbacks.includes(expected), `Ещё is missing ${expected}`);
    assert(callbacks.includes("family:menu"));

    const help = [];
    await runtime.interactive.handler({
      sessionKey: "agent:main:telegram:direct:1",
      auth: { isAuthorizedSender: true },
      callback: { payload: "help" },
      respond: { async editMessage(v) { help.push(v); }, async reply() {} }
    });
    assert.match(help.at(-1).text, /Как это работает/);
    assert.match(help.at(-1).text, /\*\*Дела\*\*/);
    assert.match(help.at(-1).text, /♡/);
    assert(help.at(-1).buttons.flat().some(b => b.callback_data === "family:menu"));
  } finally { cleanup(fx); }
});

test("Куда and Вместе use the same canonical routes as before", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const menu = runtime.command.handler({ isAuthorizedSender: true, agentId: "main" });
    const byLabel = new Map(menu.channelData.telegram.buttons.flat().map(b => [b.text, b.callback_data]));
    assert.equal(byLabel.get("📍 Куда"), "family:section:places");
    assert.equal(byLabel.get("🗓 Вместе"), "family:section:calendar");
    assert.equal(byLabel.get("💝 Сюрприз"), "family:surprise");
    const edits = await openSection(runtime, "places");
    assert.match(edits[0].text, /Куда/);
    assert(edits[0].buttons.flat().some(b => b.callback_data === "family:create:places"));
  } finally { cleanup(fx); }
});

test("Family Hub surprise sends an archive image with a neutral caption", async () => {
  const fx = fixture();
  try {
    const sent = [];
    const runtime = createFamilyRuntime({
      db: fx.db, runtimeId: "agent_core", agentId: "main",
      surpriseAssetDir: fx.assets, random: () => 0,
      now: () => Date.parse("2026-09-18T06:00:00Z"),
      sendSurpriseMedia: async input => { sent.push(input); return { ok: true }; }
    });
    const edits = [];
    await runtime.interactive.handler({
      sessionKey: "agent:main:telegram:direct:1",
      auth: { isAuthorizedSender: true },
      callback: { payload: "surprise" },
      respond: { async editMessage(v) { edits.push(v); }, async reply() {} }
    });
    assert.equal(sent.length, 1);
    assert.equal(path.dirname(sent[0].filePath), fx.assets);
    assert.equal(fs.existsSync(sent[0].filePath), true);
    assert.equal(sent[0].caption, "💝 Семейный сюрприз ♡");
    assert.match(edits.at(-1).text, /💝 \*\*Сюрприз\*\*|💝 Сюрприз/);
    assert.match(edits.at(-1).text, /вкладыш/i);
  } finally { cleanup(fx); }
});

test("note detail card escapes markup and keeps the navigation row", async () => {
  const fx = fixture();
  try {
    const note = createNote(fx.db, {
      householdId: "home", createdBy: "participant_alpha", title: "<b>Смелый</b> заголовок",
      body: "Тело заметки", visibility: "household"
    });
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const edits = [];
    await runtime.interactive.handler({
      sessionKey: "agent:main:telegram:direct:1",
      auth: { isAuthorizedSender: true },
      callback: { payload: `item:notes:${note.id}` },
      respond: { async editMessage(v) { edits.push(v); }, async reply() {} }
    });
    const text = edits.at(-1).text;
    assert.equal(/<b>(?!\u200b)/u.test(text), false, "family text must not become a live HTML tag");
    assert.match(text, /Смелый/);
    assert.match(text, /Тело заметки/);
    assert(edits.at(-1).buttons.flat().some(b => b.callback_data === "family:menu"));
  } finally { cleanup(fx); }
});
