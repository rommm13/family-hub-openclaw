# Family Hub — плагин OpenClaw

`family-hub` — Telegram-first плагин для OpenClaw: общее семейное состояние, действия, заметки, желания, места, планы, опросы, капсулы, цели, напоминания, сюрпризы и (опционально) синхронизация с Google Calendar / Google Drive. В составе плагина есть собственный Telegram Mini App UI в `miniapp/` (маршрут `/family-app/`), работающий поверх общей SQLite-базы и runtime-плагина.

> Статус: public beta `0.2.22-beta.1`. Локальные проверки пройдены: установка из архива, loopback-Gateway, статическая отдача Mini App, синтетические backup/restore/rollback, ClawHub Inspector. **Known beta limitation: реальный mobile WebView Telegram на iOS/Android с живым ботом не проверен** — перед боевой эксплуатацией прогоните на чистом стенде.

## Проверенный локальный baseline (только то, что реально проверено)

Локально на машине автора проверены только версии:

```bash
openclaw --version  # OpenClaw 2026.9.7 (c074824)
node --version      # v24.19.0
```

Команды OpenClaw в этом документе сверены по справке CLI OpenClaw 2026.9.7 (`openclaw --help`, `openclaw plugins * --help`, `openclaw backup * --help`, `openclaw config --help`).

**Несовпадение требований в текущем `package.json` (не замалчивать):** манифест плагина сейчас заявляет `peerDependencies.openclaw = 2026.9.7`, `engines.node = ">=24.22.1 <25"` и `openclaw.compat.pluginApi/minGatewayVersion = 2026.9.7`. Это строже локально проверенной версии Node (v24.19.0).

Точная формулировка для релизных заметок/доков: «CLI-команды и базовые версии проверены локально на OpenClaw 2026.9.7 + Node v24.19.0; полный функциональный прогон на Node v24.19.0 **не заявляется**. Текущий `package.json` требует Node `>=24.22.1 <25` и OpenClaw `2026.9.7` — перед релизом/чистой установкой используйте версию Node, удовлетворяющую `engines`, и прогоните тесты на целевом стенде».

## Важные ограничения и предупреждения

- **Moscow timezone limitation:** текущая реализация жёстко/по умолчанию ориентирована на Москву. В Mini App `moscowToday()` использует `Europe/Moscow`; парсинг/синхронизация календаря в `miniapp/calendar-sync.mjs` использует московские допущения (`T12:00:00Z` для day-сдвига, `+03:00` для list timeMin/timeMax). Конфиг `reminderTimezone` существует, но поведение вне Moscow-сценария **не валидировалось**.
- **Gemini / внешний API:** функции «Ввод с ИИ» и «умный список покупок» в Mini App вызывают Google Generative Language API (`gemini-2.5-flash-lite`) и **передают введённый пользователем текст/контекст запроса во внешний Google API**. Используйте только по явному действию пользователя и не отправляйте секреты/чувствительные данные без отдельного решения по безопасности.
- **Google Calendar / Drive — опционально:** нужны только при включённых интеграциях. `calendarId` включает календарную синхронизацию; `driveFolderId` + `calendarId` позволяют прикреплять фото как нативные вложения Google Calendar через Google Drive (только для записей, уже привязанных к синхронизированному событию календаря). Личные заметки с неподходящей видимостью и секретное содержимое запечатанных капсул не должны попадать в общий календарь (сверяйте поведение кода/конфига на целевой версии).
- **Фото (лимиты по текущему исходному коду `miniapp/extras.mjs`):** до 6 фото на запись (для поддерживаемых секций), **максимум 1.7 MB на загрузку** (`MAX_PHOTO_BYTES = 1_700_000`), **общая квота хранилища фото 250 MiB** на Mini App storage (`DEFAULT_MAX_PHOTO_STORAGE_BYTES = 250*1024*1024`), максимум **12 000 px** по стороне и **40 000 000 пикселей** на изображение. Поддерживаемые форматы: JPEG/PNG/WebP. Перед сохранением/Drive сервер удаляет метаданные (EXIF/XMP/IPTC/COM/PNG text chunks/WebP EXIF/XMP) — клиентской очистке не доверять. Файлы хранятся в закрытом `placePhotoDir` и отдаются только через авторизованный API с проверкой initData; публичных URL файлов нет.
- **Секреты:** Telegram/Google/API-ключи и конфиги с секретами не хранить в репозитории и не публиковать.

## Требования

| Компонент | Требование / факт |
|---|---|
| OpenClaw | CLI-команды сверены на **OpenClaw 2026.9.7**. Текущий манифест плагина также заявляет compat/minGateway `2026.9.7`. |
| Node.js | Локально проверена версия **v24.19.0**; текущий `package.json` требует **`>=24.22.1 <25`** — используйте Node, удовлетворяющий `engines`, для целевой установки. |
| Telegram bot | Нужен бот Telegram, подключённый к OpenClaw каналом `telegram`. Mini App открывается по HTTPS URL; подробности — в [`miniapp/README.md`](./miniapp/README.md). |
| Google Calendar | Опционально: `calendarId` (+ доступ через gws/адаптер календаря в runtime). |
| Google Drive | Опционально: `driveFolderId` для нативных фото-вложений к событиям календаря. |
| Gemini | Опционально для AI-функций Mini App; требует доступный `GEMINI_API_KEY` в окружении runtime и передаёт текст пользователя в Google API. |

## Установка / обновление / удаление плагина (команды сверены по OpenClaw CLI 2026.9.7)

> Выполнять в окружении, где установлен OpenClaw 2026.9.7. Заменяйте `<path-or-spec-or-plugin>` / `<plugin-id>` на реальные значения. Локальная установка из архива проверена на стенде автора; мобильная проверка Mini App — известное ограничение беты (см. «Release validation status»).

### Установка

```bash
# Локальный путь (каталог или поддерживаемый артефакт) / npm spec / git / clawhub: / marketplace entry
openclaw plugins install <path-or-spec-or-plugin>

# Полезные флаги, подтверждённые help OpenClaw 2026.9.7:
#   --force       — подтвердить non-ClawHub источник / перезаписать существующий
#   -l, --link    — линковать локальный путь вместо копирования
#   --pin         — записать npm-установку как точный <name>@<version>
#   --dry-run у `plugins install` в 2026.9.7 отсутствует (dry-run есть у update/uninstall)
```

### Обновление

```bash
# Все отслеживаемые плагины/hook packs
openclaw plugins update --all

# Конкретный плагин/список id или npm spec
openclaw plugins update <plugin-id>

# Проверка без записи изменений
openclaw plugins update <plugin-id> --dry-run
```

### Удаление

```bash
# Удалить плагин
openclaw plugins uninstall <plugin-id>

# Проверка без изменений
openclaw plugins uninstall <plugin-id> --dry-run

# Оставить установленные файлы на диске
openclaw plugins uninstall <plugin-id> --keep-files
# (флаг --force в 2026.9.7 пропускает подтверждение; --keep-config — deprecated alias --keep-files)
```

После install/update/uninstall проверьте состояние штатными командами OpenClaw: `openclaw plugins list`, `openclaw status`, `openclaw doctor` (по вашей процедуре), затем перезапустите/проверьте Gateway.

## Конфигурация плагина (минимум)

Конфиг задаётся в OpenClaw. Поля по `openclaw.plugin.json`: `dataDir`, `dbPath`, `runtimeId`, `agentId`, `buttonText`, `calendarId`, `calendarAccount`, `miniAppUrl`, `driveFolderId`, `placePhotoDir`, `reminderTime`, `reminderTimezone`, `surpriseAssetDir`, `surpriseMediaDir`, `surpriseAutoMemberId`, `surpriseManualLimit`, `surpriseUnlimitedMemberIds`.

Команды OpenClaw CLI 2026.9.7 для безопасной работы с конфигом:

```bash
openclaw config file
openclaw config get <dot.path>
openclaw config set <dot.path> <value>
openclaw config patch --file ./openclaw.patch.json5 --dry-run
openclaw config patch --file ./openclaw.patch.json5
openclaw config validate
openclaw config schema
```

Точные dot-path зависят от структуры установки OpenClaw; перед записью используйте `--dry-run` (где есть) и `openclaw config validate`.

## Backup / restore (команды сверены по OpenClaw CLI 2026.9.7)

```bash
# Создать резервную копию (config, credentials, sessions, workspaces — по умолчанию)
openclaw backup create

# Записать в каталог/путь и сразу проверить архив
openclaw backup create --output ~/Backups --verify

# Только JSON-конфиг
openclaw backup create --only-config --output ~/Backups

# План без записи
openclaw backup create --dry-run --json

# Проверить архив
openclaw backup verify ~/Backups/<archive>.tar.gz

# Восстановить в НОВЫЙ staging-каталог (непустой каталог будет отклонён)
openclaw backup restore ~/Backups/<archive>.tar.gz --target ./restored-openclaw
```

`backup restore` извлекает архив в свежий staging-каталог; **автоматическую замену живого state/Gateway** он сам по себе не выполняет. Перенос восстановленных данных в рабочее окружение, рестарт Gateway и проверку на mobile/чистом Gateway выполняйте по вашей эксплуатации — здесь это **не проверялось**.

## HTTPS / Mini App

Mini App живёт в `miniapp/`, обслуживается маршрутом `/family-app/` и использует Telegram `initData` (HMAC-проверка) + ACL по маршрутам участников. Для Telegram WebApp нужен опубликованный HTTPS URL (`miniAppUrl`). Подготовленный checklist и ограничения — в [`miniapp/README.md`](./miniapp/README.md).

## Чистая установка Gateway/mobile

Локальная установка из собранного архива и loopback-Gateway проверены на стенде автора (см. «Release validation status» ниже). **Не проверены и остаются известным ограничением беты:** реальный mobile WebView Telegram на iOS/Android с живым ботом, staging-деплой с реальным backup/rollback, публичная GitHub-провенанс-история до публикации. Любые шаги, связанные с мобильной проверкой Mini App на чистой установке, требуют отдельного прогона на чистом стенде перед продакшеном.

## Что не входит в этот документ

- Реальные токены, пароли, приватные URL, VPS/SSH/деплой-скрипты.
- Изменения кода плагина, staging, GitHub-настроек.
- Гарантии лимитов фото/поведения вне текущего исходного кода и вне целевого стенда.

## Быстрая проверка (baseline-проверки + пункты для стенда)

1. `node --version` — локально проверено **v24.19.0**; для целевой установки сверяйте с `package.json engines` (`>=24.22.1 <25`).
2. `openclaw --version` — ожидаемо **2026.9.7**.
3. `openclaw plugins list` — плагин виден и включён.
4. `openclaw config validate` — конфиг валиден.
5. Telegram-бот отвечает в DM; family-сценарии/меню работают (проверяется на стенде).
6. Если включён календарь — `calendarId`/Google-доступ настроены; проверить на тестовом событии (стенд).
7. `openclaw backup create --verify` завершается успешно.

Пункты 5–7 и mobile/Mini App на чистой установке Gateway/mobile здесь **не проверялись**.

## Development and reproducible checks

To test a fresh source checkout (not the published runtime archive), run:

```bash
npm ci --ignore-scripts
npm test
npm run test:miniapp:audit
```

Use the OpenClaw CLI to validate the plugin:
`openclaw plugins validate --root . --entry dist/plugin.js --json`

The published npm tarball intentionally excludes developer tests. The private code base also contains an operational Python schedule generator that is not distributed. Therefore public tests and the private baseline have different counts.

## Release validation status (0.2.22-beta.1, 2026-11-07)

- MIT license approved. No public release has been initiated yet.
- Local archive install and runtime inspection passed with OpenClaw 2026.9.7 on portable Node 24.22.1 in an isolated profile. The CLI's OpenClaw peer was linked from an existing test install; this is not an independent installation of the OpenClaw application itself.
- Loopback-only Gateway and Mini App static HTTP routes passed. Telegram channels remained disabled.
- Synthetic SQLite online backup, restore and rollback rehearsal passed.
- ClawHub Inspector static validation completed; dry-run requires matching source repository and source commit metadata.
- **P0 auto-surprise fix:** the configured recipient (`surpriseAutoMemberId`) is now served by the built-in `family-hub-outbox` worker (`maybeRunConfiguredAutoSurprise` → `runAutomaticSurpriseTick` → `surprise_media` outbox), no external cron/Python. Manual «Сюрприз» button, all Telegram buttons/callback_data and Mini App styling unchanged. Covered by `test/auto-surprise.test.mjs` (bootstrap, due, repeat/restart, retry, empty assets, no route, 2 households) plus existing `test/surprises.test.mjs`.
- Real Telegram WebView tests, staging deployment with real backup and rollback, and public GitHub provenance remain unverified (known beta limitation).

Do not publish before the final required gates are complete.
