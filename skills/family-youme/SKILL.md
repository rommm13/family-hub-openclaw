---
name: family-youme
description: Use Family Hub for shared family actions, shopping, cashback, notes, wishes, places, plans, polls, capsules, money goals, direct family calendar events, searches and Telegram family-menu management. Use when the owner asks to remember or manage something for the family, assign something to a family member, add or change a family record, create or vote in a family poll, create a time capsule, or manage the shared family calendar. Backend-resolved human identity and ACL are authoritative.
---

# Family You&Me

Use the OpenClaw tool `family` as the only operational API for Family Hub state.
Family Hub is the shared family source of truth; the model is only an interface to it.

## Hard rules

1. Never write Family Hub records directly to SQLite, shell scripts, Google Calendar,
   Google Tasks, chat memory or ad-hoc files. Use tool `family`.
2. Never change, impersonate, infer or override the current human identity. Identity
   comes from trusted OpenClaw host context. Resolve named family members with
   `list_members`.
3. Do not duplicate side effects. Calendar sync, counterpart creation notifications,
   assignment/reassignment notifications, capsule unlock lifecycle, daily reminders
   and idempotency are plugin responsibilities. Shared record creation automatically
   notifies the other bound family member; do not send a second manual notification.
   Sealed capsules and private/owner-only notes do not get creation notifications.
4. Do not silently convert a personal/private reminder into a family record. Family
   Hub is used only for family-shared state, an explicit family member assignment, or
   an explicit request involving `Семья`.
5. Never claim a mutation succeeded unless the `family` tool returns `ok: true`.
6. If `family` is unavailable, do not bypass ACL by touching storage or Google APIs.

## Entry UX

`🫶 Семья` is the primary Telegram entry point. `/family` is the technical fallback.
Buttons provide discoverability and management; natural language is an equal fast
path. Both paths use the same domain API.

Visible sections:
- `actions` — Дела
- `shopping` — Купить
- `cashback` — Кэшбэк
- `notes` — Заметки
- `wishes` — Желания
- `places` — Места
- `plans` — Планы
- `polls` — Голосования
- `capsules` — Капсулы
- `calendar` — Календарь
- `goals` — Цели

## Exact tool contract

Use only these `action` values.

### Reads
- `list_members` — canonical member IDs/names.
- `list` — list `actions`, `notes`, `wishes`, `places`, `plans`, `polls`, `capsules`, or `goals`.
- `search_notes` — `query`.
- `get_poll` — `pollId`.
- `get_capsule` — `capsuleId`.
- `get_calendar_event` — `calendarEventId` for Family Hub-created direct events.
- `list_shopping` — current shared shopping checklist.
- `get_cashback` — latest saved cashback period by default; optional `cashbackYear` and `cashbackMonth` select a specific month.

### Shopping
- `add_shopping_items` — `items` array; use one call for a phrase like «молоко, сыр и яйца».
- `toggle_shopping_item` — `shoppingItemId`; toggles bought/not bought.
- `clear_bought_shopping` — removes checked items only.
Shopping is a lightweight checklist: no deadlines, assignees, reminders or Calendar events.

### Cashback
- `set_cashback` — save or replace one monthly cashback snapshot with required `cashbackYear`, `cashbackMonth`, `cashbackBody`; optional `cashbackTitle`.
- When the owner sends a monthly bank cashback list, store it in Family Hub instead of a note or chat memory.
- Re-sending the same year/month replaces that month's snapshot; do not create duplicates.
- Preserve bank names, percentages, limits and whether a benefit is cashback or a discount. Do not silently normalize one into the other.
- `get_cashback` without a period returns the latest saved month. For a named month, pass both year and month.
- Cashback is shared household reference data. Saving it does not require a separate manual notification to the other family member.

### Notes
- `create_note` — `title`, `body`, optional `visibility`.
- `update_note` — `noteId`, optional changed `title`, `body`, `visibility`, and `expectedRevision` when editing a previously-read note.
- `delete_note` — `noteId`.

### Wishes
- `create_wish` — `title`, optional `targetPrice`, `url`, `comment`.
- `update_wish` — `wishId` plus changed fields.
- `remove_wish` — `wishId`.
- `reserve_wish` — `wishId` for another member's wish.

### Places
- `create_place` — `title` as place name; optional `mapsUrl`, `placeId`, `comment`.
- `update_place` — `familyPlaceId` plus changed fields.
- `delete_place` — `familyPlaceId`.

### Plans
- `create_plan` — `title`, optional `comment`, canonical IDs in `participants`.
- `update_plan` — `planId` plus changed `title`/`comment`.
- `archive_plan` — `planId`.

### Polls
- `create_poll` — `question`, at least two `options`, canonical IDs in `participants`.
- `vote_poll` — `pollId`, zero-based `optionIndex`.
- `close_poll` — `pollId`.

### Goals
- `create_goal` — `title`, non-negative `amount`, optional `currency` (default RUB), required `dueAt`, optional `assigneeId`.
- `update_goal` — `goalId` plus changed `title`, `amount`, `currency`, `dueAt`.
- `complete_goal` — `goalId`.

### Actions
- `create_action` — `title`, optional `assigneeId`, `dueAt`; use `allowUndated: true` only when the owner explicitly says no deadline.
- `update_action` — `actionId` plus changed `title`, `assigneeId`, `dueAt`.
- `complete_action` — `actionId`.
- `cancel_action` — `actionId`.

### Capsules
- `create_capsule` — canonical `recipientId`, ISO `unlockAt`, sealed `payload`.
- `get_capsule` — `capsuleId`; respect the payload returned by backend exactly.
- `cancel_capsule` — `capsuleId`; only the author may cancel a sealed capsule.

### Shared family calendar
- `create_calendar_event` — `title`, `startAt`, optional `endAt`, `description`.
- `get_calendar_event` — `calendarEventId`.
- `update_calendar_event` — `calendarEventId` plus changed fields.
- `delete_calendar_event` — `calendarEventId`.

Never invent another `action` value.

## Member resolution

When a request names another family member, call `list_members` before mutation
unless the canonical ID was returned earlier in the same turn. Match exactly one
human-readable member. If ambiguous, ask one short clarification. Never hardcode
Telegram usernames or derive identities from text.

For a normal poll without a narrower participant set, include all current family
members returned by `list_members`.

## Actions and dates

For a family action with a date or time, resolve the user's date in `Europe/Moscow`
unless another timezone is explicit, then call `create_action`/`update_action` with
`dueAt`. Preserve the user's wall-clock time correctly. The plugin synchronizes the
shared family calendar and reminders; do not create a second event yourself.

If a new action has no deadline and the owner did not explicitly say it is undated,
ask exactly: `Когда?` Do not create it yet. For `без срока`, `когда-нибудь`, or an
equivalent explicit request, use `allowUndated: true` and omit `dueAt`.

When another member is assigned, pass canonical `assigneeId`. The plugin handles the
notification. Do not send a duplicate manual assignment message.
For all Family Hub mutations that notify another member, delivery belongs to the
plugin outbox and its stored member route. Never use the generic message tool with a
human-readable family name or Telegram username as a second delivery path. This is
especially important for shared calendar events: create_calendar_event already
notifies the other bound family member after a successful create.


For completion/cancellation/edit, list `actions` first if the ID is unknown and act
only on an unambiguous match.

## Notes, wishes, places, plans and goals

Information the owner wants the family to remember normally becomes `create_note`.
Use a concise title and preserve meaningful body text. Do not convert information to
an action unless there is an actual action to perform.

A wish belongs to its creator. Secret reservation visibility is backend-controlled;
never infer or reveal a hidden reservation to its owner.

Places remain deliberately minimal: name, Maps link/Place ID and comment. Do not
invent categories, favorites, ratings or status clutter.

Plans are lightweight containers. Do not create a parallel task, reminder or budget
system inside them. Related actions/events/notes/places remain their normal Family
Hub entities.

Money goals are purpose + amount + due date + status. Never invent bank balances,
savings transactions or automatic account syncing.

## Polls

For `create_poll`, preserve question and option order. Resolve every participant.
Before voting by label, use `get_poll` when needed and map the chosen label to the
zero-based `optionIndex`. Never guess an index.

Poll results are hidden until the current participant has voted. Do not reconstruct
hidden votes from chat history or other sources.

Automatic family surprise images are surprises, not capsules.
Do not describe an automatic surprise as a capsule unless a real capsule record
exists in Family Hub.

## Capsules

Resolve the recipient with `list_members`, then call `create_capsule`. Before unlock,
never reveal payload if `get_capsule` returns it hidden/null for the current viewer.
The plugin owns unlock scheduling; do not create a separate reminder or automation.
A sealed capsule may be cancelled by its author with `cancel_capsule`.

An attached postcard/capsule image with clear capsule context such as `в ответ`,
`семейная открытка`, `капсула` plus a family recipient is a scheduled
family capsule, not an immediate generic Telegram send. Generic image/document
forwarding such as `перешли участнику семьи документ` or `скинь участнику семьи фото` must remain a
normal messaging request and must not be hijacked by the capsule flow. If capsule
delivery time is missing, ask exactly one short question: `Когда отправить?` Accept
natural replies such as `в 20:00`, but require a future exact time. A short caption
such as `Отправь` may inherit recipient/capsule intent from the Telegram message it
replies to; do not discard reply context. Never claim that the image was sent before
Family Hub has persisted the capsule/outbox record. The deterministic Family Hub
media flow owns the attachment and delivery route. Once a postcard flow is claimed,
Family Hub stores a durable media draft before asking for the time, so a gateway
restart must not lose the image or silently fall back to LLM-only handling.

## Family calendar events

Это отдельный семейный календарь `Семья`. Событие здесь не является задачей, если пользователь не просит выполнить действие.
The Calendar section is the separate shared family calendar, not either user's
personal primary calendar. A direct family event is distinct from an action:
- `21 сентября день рождения мамы` → `create_calendar_event`;
- `к 21 сентября заказать торт` → `create_action`.

Use `create_calendar_event`, `update_calendar_event`, and `delete_calendar_event` for
direct shared events. Resolve an unspecified timezone as `Europe/Moscow`. Timed
`startAt`/`endAt` values must use an explicit numeric UTC offset. For example,
“сегодня в 14:55” in Moscow is `2026-09-18T14:55:00+03:00`, never
`2026-09-18T14:55:00Z`. Do not convert the user's stated wall-clock time to UTC while
keeping the same clock digits. If another timezone is explicit, resolve it correctly
and still serialize with a numeric offset such as `+02:00` or `+00:00`; do not use
the `Z` shorthand. Calendar synchronization is a plugin responsibility; do not write
Google Calendar yourself and do not create a second event yourself.

For timed direct family events, Family Hub also queues a Telegram reminder to the
other bound family member for the exact event start time. This delivery is stored in
the Family Hub outbox, not in the Google Calendar description, so the absence of a
recipient name in the event description does not mean the reminder is missing.

## Response style

After a successful mutation, confirm the concrete result in one short sentence.
Do not dump internal IDs unless needed to resolve ambiguity or explicitly requested.
For reads, present returned data compactly and obey backend visibility exactly.
