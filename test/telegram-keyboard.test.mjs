import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramPersistentKeyboardInstaller } from "../dist/telegram-keyboard.js";

const route = { channel: "telegram", accountId: "default", to: "telegram:123" };

test("installer sends one persistent reply keyboard through Telegram Bot API", async () => {
  const calls = [];
  const cfg = { marker: "cfg" };
  const install = createTelegramPersistentKeyboardInstaller({
    resolveAccount: input => {
      assert.equal(input.cfg, cfg);
      assert.equal(input.accountId, "default");
      return { token: "secret-token", config: { apiRoot: "https://api.telegram.org" } };
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    }
  });
  assert.equal(await install({ cfg, route, buttonText: "🫶 Семья" }), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/botsecret-token\/sendMessage$/);
  assert.equal(calls[0].options.method, "POST");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_id, "123");
  assert.equal(body.disable_notification, true);
  assert.equal(body.reply_markup.is_persistent, true);
  assert.equal(body.reply_markup.resize_keyboard, true);
  assert.equal(body.reply_markup.keyboard[0][0].text, "🫶 Семья");
});

test("installer ignores non-Telegram and malformed routes", async () => {
  let fetches = 0;
  const install = createTelegramPersistentKeyboardInstaller({
    resolveAccount: () => ({ token: "secret-token", config: {} }),
    fetchImpl: async () => { fetches += 1; return { ok: true, json: async () => ({ ok: true }) }; }
  });
  assert.equal(await install({ cfg: {}, route: { channel: "discord", to: "123" }, buttonText: "🫶 Семья" }), false);
  assert.equal(await install({ cfg: {}, route: { channel: "telegram", to: "bad" }, buttonText: "🫶 Семья" }), false);
  assert.equal(fetches, 0);
});
test("installer failure never leaks bot token in its error", async () => {
  const install = createTelegramPersistentKeyboardInstaller({
    resolveAccount: () => ({ token: "super-secret-token", config: {} }),
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ ok: false, description: "fail" }) })
  });
  await assert.rejects(
    () => install({ cfg: {}, route, buttonText: "🫶 Семья" }),
    error => !String(error?.message ?? error).includes("super-secret-token") && /HTTP 500/.test(String(error?.message ?? error))
  );
});