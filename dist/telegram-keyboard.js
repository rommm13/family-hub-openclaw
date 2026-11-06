function telegramTarget(route) {
  if (route?.channel !== "telegram") return null;
  const raw = String(route?.to ?? "").trim();
  if (!raw.startsWith("telegram:")) return null;
  const target = raw.slice("telegram:".length).trim();
  return target || null;
}

export function createTelegramPersistentKeyboardInstaller({
  resolveAccount,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2500
} = {}) {
  if (typeof resolveAccount !== "function") throw new Error("resolveAccount is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");

  return async function installPersistentKeyboard({ cfg, route, buttonText }) {
    const chatId = telegramTarget(route);
    const label = String(buttonText ?? "").trim();
    if (!chatId || !label) return false;
    const account = resolveAccount({ cfg, accountId: route.accountId ?? null });
    const token = String(account?.token ?? "").trim();
    if (!token) return false;
    const apiRoot = String(account?.config?.apiRoot ?? "https://api.telegram.org").replace(/\/+$/, "");
    const url = `${apiRoot}/bot${token}/sendMessage`;
    const body = {
      chat_id: chatId,
      text: "♡ Семейный хаб — под кнопкой ниже.",
      disable_notification: true,
      reply_markup: {
        keyboard: [[{ text: label }]],
        resize_keyboard: true,
        is_persistent: true
      }
    };
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new Error("Telegram keyboard install failed: network error");
    }
    if (!response?.ok) {
      throw new Error(`Telegram keyboard install failed: HTTP ${response?.status ?? "error"}`);
    }
    let payload;
    try { payload = await response.json(); } catch {
      throw new Error("Telegram keyboard install failed: invalid API response");
    }
    if (payload?.ok === false) throw new Error("Telegram keyboard install failed: API error");
    return true;
  };
}
