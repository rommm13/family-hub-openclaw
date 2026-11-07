# Family Hub — семейный плагин для OpenClaw

`family-hub` — Telegram-first плагин для OpenClaw: общее семейное состояние, Telegram-бот и собственный Telegram Mini App.

Что внутри: задачи и напоминания, заметки, желания, места, планы, опросы, капсулы времени, цели, кэшбэк, сюрпризы **Love Is** — плюс опциональная синхронизация с Google Calendar / Google Drive. Mini App в `miniapp/` (маршрут `/family-app/`) работает поверх той же SQLite-базы, отдельной копии логики нет.

> Статус: public beta `0.2.22-beta.2`.

## Что умеет

- **Telegram-бот для семьи:** главное меню, 12 разделов (Календарь, Купить, Дела, Записки, Планы, Куда, Цели, Хочу, Выбрать, Капсулы, Кэшбэк, Сюрприз), мастера создания, отметки просмотра по участникам, архив просроченного.
- **Mini App:** мобильный WebApp-интерфейс поверх той же базы — счётчики, карточки, фото к записям, календарная сетка, умные списки.
- **Напоминания:** ежедневный дайджест в настроенное время, часовой пояс настраивается (`reminderTime`, `reminderTimezone`).
- **Сюрпризы Love Is:** ручная кнопка «Сюрприз» и автоматические сюрпризы по расписанию через штатный воркер `family-hub-outbox` (`maybeRunConfiguredAutoSurprise` → `runAutomaticSurpriseTick` → `surprise_media`). Получатель — только явная настройка `surpriseAutoMemberId`. Картинки подставляются **из вашей собственной локальной библиотеки** (`surpriseAssetDir`); в пакет никакие изображения не входят.
- **Фото:** до 6 фото на запись в поддерживаемых разделах, серверная очистка метаданных (EXIF/XMP/IPTC и др.), закрытое хранилище `placePhotoDir`, отдача только через авторизованный API.
- **Календарь/Drive (опционально):** `calendarId` включает синхронизацию датированных записей с семейным Google Calendar; `driveFolderId` + `calendarId` — нативные фото-вложения к событиям календаря. Без этих настроек плагин полностью работает локально.
- **ИИ-функции (опционально):** «Ввод с ИИ» и умные списки покупок через Google Generative Language API (`gemini-2.5-flash-lite`). Требуют `GEMINI_API_KEY`, текст запроса уходит во внешний Google API — только по явному действию пользователя.

## Требования

| Компонент | Версия |
|---|---|
| OpenClaw | `2026.9.7` (peer + `compat.pluginApi` / `minGatewayVersion`) |
| Node.js | `>=24.22.1 <25` (см. `engines` в `package.json`) |
| Telegram | бот, подключённый к OpenClaw каналом `telegram`; для Mini App — публичный HTTPS URL (`miniAppUrl`) |
| Google Calendar / Drive / Gemini | опционально, только для соответствующих функций |

## Установка

Из ClawHub:

```bash
openclaw plugins install clawhub:@rommm13/openclaw-family-hub@0.2.22-beta.2
```

Из локальной папки или GitHub:

```bash
openclaw plugins install <path-or-spec-or-plugin>
openclaw plugins list
openclaw status
```

Обновление / удаление — стандартными командами OpenClaw (`plugins update`, `plugins uninstall --dry-run` для проверки).

## Конфигурация

Поля задаются в конфиге OpenClaw, схема — в `openclaw.plugin.json`:

`dataDir`, `dbPath`, `runtimeId`, `agentId`, `buttonText`, `calendarId`, `calendarAccount`, `miniAppUrl`, `driveFolderId`, `placePhotoDir`, `reminderTime`, `reminderTimezone`, `surpriseAssetDir`, `surpriseMediaDir`, `surpriseAutoMemberId`, `surpriseManualLimit`, `surpriseUnlimitedMemberIds`.

Минимум для запуска: `dataDir`/`dbPath` (куда хранить базу), `miniAppUrl` (если нужен Mini App), `surpriseAssetDir` + `surpriseAutoMemberId` (если нужны авто-сюрпризы). Остальное — по мере включения интеграций.

Безопасное редактирование:

```bash
openclaw config validate
openclaw config get <dot.path>
openclaw config patch --file ./openclaw.patch.json5 --dry-run
```

## Безопасность

- Токены Telegram/Google, API-ключи, боевые базы, приватные URL и семейные данные — только в защищённой конфигурации, никогда в репозиторий.
- Mini App проверяет Telegram `initData` (HMAC) и ACL маршрутов участников; публичных URL файлов нет.
- Перед сохранением/Drive сервер удаляет метаданные фото — клиентской очистке не доверяйте.
- Личные заметки с ограниченной видимостью и содержимое запечатанных капсул не направляйте в общий календарь — сверяйте видимость записей перед включением синхронизации.

## Реальное использование и честные границы беты

Оригинальный Family Hub реально работал в Telegram на телефонах владельца и супруги: основной сценарий бота и Mini App проверен живым использованием. Файлы `miniapp/web/*` (HTML/CSS/JS), `miniapp/auth.mjs`, `miniapp/api.mjs`, `dist/theme.js` и `dist/telegram-keyboard.js` в этом пакете соответствуют рабочему проекту. Отдельный end-to-end smoke заново собранного tarball именно этой версии на двух телефонах не выполнялся — это и есть известное ограничение беты, а не отсутствие тестирования как такового.

Стендовая проверка этой ветки: `npm test` 201/201, Mini App audits, статическая отдача Mini App, loopback-Gateway, синтетические backup/restore/rollback, ClawHub Inspector — PASS. Telegram-каналы на стенде оставались выключенными.

## Проверка после установки

1. `node --version` — должен удовлетворять `engines` (`>=24.22.1 <25`).
2. `openclaw --version` — `2026.9.7`.
3. `openclaw plugins list` — плагин виден и включён; `openclaw config validate` — конфиг валиден.
4. Бот отвечает в DM, разделы меню открываются; при включённом календаре — тестовое событие синхронизируется.
5. `openclaw backup create --verify` завершается успешно.

## Разработка

```bash
npm ci --ignore-scripts
npm test
npm run test:miniapp:audit
openclaw plugins validate --root . --entry dist/plugin.js --json
```

Опубликованный tarball намеренно исключает тесты (`test/` в `.npmignore`).

## Статус релиза (0.2.22-beta.2, 2026-11-07)

- Исправление beta.1: получатель авто-сюрпризов (`surpriseAutoMemberId`) обслуживается встроенным воркером `family-hub-outbox`, без внешнего cron. Кнопки, `callback_data` и стили Mini App не менялись.
- Beta.1 в ClawHub содержала артефакт, собранный из старого дерева (без этого фикса), и остаётся историей; актуальная версия — beta.2.
- Лицензия MIT. Боевые боты, базы, VPS и сторонние сервисы релизом не затрагиваются.
