import { resolveMemberForAgent, enqueueOutbox } from "./db.js";
import {
  completeAction, createAction, createMoneyGoal, createNote, createPlace,
  createPlan, createWish, createPoll, votePoll, getPollForViewer, reserveWish, listSection, searchNotes,
  updateNote, deleteNote, updateWish, removeWish, updatePlace, deletePlace, updatePlan, archivePlan,
  updateAction, cancelAction, closePoll, updateMoneyGoal, completeMoneyGoal,
  createCapsule, getCapsuleForViewer, cancelCapsule,
  createFamilyCalendarEvent, getFamilyCalendarEvent, updateFamilyCalendarEvent, cancelFamilyCalendarEvent,
  listShopping, addShoppingItems, toggleShoppingItem, clearBoughtShopping, upsertCashback
} from "./domain.js";

export const TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: [
      "list_members", "list", "search_notes", "get_poll", "list_shopping", "get_cashback", "set_cashback", "create_note", "update_note", "delete_note",
      "create_wish", "update_wish", "remove_wish", "reserve_wish",
      "create_place", "update_place", "delete_place", "create_plan", "update_plan", "archive_plan",
      "create_poll", "vote_poll", "close_poll", "create_goal", "update_goal", "complete_goal",
      "create_action", "update_action", "complete_action", "cancel_action",
      "get_capsule", "create_capsule", "cancel_capsule",
      "get_calendar_event", "create_calendar_event", "update_calendar_event", "delete_calendar_event",
      "add_shopping_items", "toggle_shopping_item", "clear_bought_shopping"
    ] },
    section: { type: "string" }, query: { type: "string" }, title: { type: "string" },
    body: { type: "string" }, visibility: { type: "string" }, targetPrice: { type: "number" },
    url: { type: "string" }, comment: { type: "string" }, mapsUrl: { type: "string" },
    placeId: { type: "string" }, participants: { type: "array", items: { type: "string" } },
    amount: { type: "number" }, currency: { type: "string" }, dueAt: { type: "string" },
    assigneeId: { type: "string" }, allowUndated: { type: "boolean" }, actionId: { type: "string" },
    noteId: { type: "string" }, expectedRevision: { type: "integer", minimum: 1 }, wishId: { type: "string" }, familyPlaceId: { type: "string" },
    planId: { type: "string" }, goalId: { type: "string" },
    recipientId: { type: "string" }, unlockAt: { type: "string" }, payload: { type: "string" }, capsuleId: { type: "string" },
    calendarEventId: { type: "string" }, startAt: { type: "string" }, endAt: { type: "string" }, description: { type: "string" },
    question: { type: "string" }, options: { type: "array", items: { type: "string" } },
    pollId: { type: "string" }, optionIndex: { type: "integer", minimum: 0 },
    items: { type: "array", items: { type: "string" } }, shoppingItemId: { type: "string" },
    cashbackYear: { type: "integer", minimum: 2000, maximum: 2100 }, cashbackMonth: { type: "integer", minimum: 1, maximum: 12 },
    cashbackTitle: { type: "string" }, cashbackBody: { type: "string" }
  },
  required: ["action"]
};
function result(details) {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

function validSessionAgent(sessionKey, expectedAgentId) {
  const raw = String(sessionKey ?? "").trim().toLowerCase();
  if (!raw.startsWith("agent:")) return false;
  const end = raw.indexOf(":", 6);
  return end > 6 && raw.slice(6, end) === String(expectedAgentId).trim().toLowerCase();
}

function text(value, name) {
  const out = String(value ?? "").trim();
  if (!out) throw new Error(`${name} is required`);
  return out;
}

function assignmentPrefix(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(raw);
  if (!m) return `до ${raw} `;
  const date = `${m[3]}.${m[2]}.${m[1]}`;
  return m[4] ? `до ${date} ${m[4]}:${m[5]} ` : `до ${date} `;
}

function otherBoundMembers(db, member) {
  return db.prepare(`
    SELECT DISTINCT m.id
    FROM members m
    JOIN agent_bindings b ON b.member_id=m.id
    WHERE m.household_id=? AND m.id<>?
    ORDER BY m.id
  `).all(member.householdId, member.id);
}

function notifyOtherBoundMembers(db, member, { key, text: message, recipients = null }) {
  const allowed = recipients ? new Set(recipients) : null;
  for (const row of otherBoundMembers(db, member)) {
    if (allowed && !allowed.has(row.id)) continue;
    enqueueOutbox(db, {
      dedupeKey: `${key}:${row.id}`,
      recipientMemberId: row.id,
      kind: "text",
      payload: { text: message }
    });
  }
}

function clearCalendarStartReminders(db, eventId) {
  db.prepare(`DELETE FROM outbox
    WHERE dedupe_key LIKE ? AND kind='text' AND status IN ('pending','failed')`)
    .run(`notify:due:calendar:${eventId}:%`);
}

function scheduleCalendarStartReminders(db, member, { eventId, revision, title, startAt, nowMs = Date.now() }) {
  clearCalendarStartReminders(db, eventId);
  const raw = String(startAt ?? "").trim();
  if (!raw.includes("T")) return;
  const due = new Date(raw);
  if (Number.isNaN(due.getTime()) || due.getTime() <= Number(nowMs)) return;
  for (const row of otherBoundMembers(db, member)) {
    enqueueOutbox(db, {
      dedupeKey: `notify:due:calendar:${eventId}:${row.id}:rev:${revision}`,
      recipientMemberId: row.id,
      kind: "text",
      payload: { text: `⏰ Напоминание: ${title}` },
      availableAt: due.toISOString()
    });
  }
}

function creationNotice(member, icon, kind, title) {
  return `${icon} ${member.name} · ${kind}: ${String(title ?? "").trim()}`;
}

function compactShoppingNames(items, max = 5) {
  const names = (items ?? []).map(item => String(item?.name ?? item ?? "").trim()).filter(Boolean);
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} + ещё ${names.length - max}`;
}

function mutateOnce(db, actionKey, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const claim = db.prepare("INSERT OR IGNORE INTO processed_actions(action_key) VALUES (?)").run(actionKey);
    if (Number(claim.changes) === 0) { db.exec("ROLLBACK"); return { duplicate: true }; }
    const value = fn();
    db.exec("COMMIT");
    return { duplicate: false, value };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function readAction(db, member, params) {
  if (params.action === "list_members") {
    const rows = db.prepare("SELECT id,name,role FROM members WHERE household_id=? ORDER BY role,name").all(member.householdId);
    return result({ ok: true, members: rows.map(row => ({ ...row })) });
  }
  if (params.action === "list") {
    const items = listSection(db, text(params.section, "section"), member.id);
    return result({ ok: true, items });
  }
  if (params.action === "search_notes") {
    return result({ ok: true, items: searchNotes(db, text(params.query, "query"), member.id) });
  }
  if (params.action === "get_poll") {
    return result({ ok: true, item: getPollForViewer(db, text(params.pollId, "pollId"), member.id) });
  }
  if (params.action === "get_capsule") {
    return result({ ok: true, item: getCapsuleForViewer(db, text(params.capsuleId, "capsuleId"), member.id) });
  }
  if (params.action === "get_calendar_event") {
    return result({ ok: true, item: getFamilyCalendarEvent(db, text(params.calendarEventId, "calendarEventId"), member.id) });
  }
  if (params.action === "list_shopping") {
    return result({ ok: true, items: listShopping(db, member.id) });
  }
  if (params.action === "get_cashback") {
    let items = listSection(db, "cashback", member.id, 60);
    if (params.cashbackYear !== undefined) items = items.filter(item => item.year === Number(params.cashbackYear));
    if (params.cashbackMonth !== undefined) items = items.filter(item => item.month === Number(params.cashbackMonth));
    return result({ ok: true, item: items[0] ?? null });
  }
  return null;
}

function mutationInput(db, member, params, now = Date.now) {
  const base = { householdId: member.householdId, createdBy: member.id };
  if (params.action === "set_cashback") return () => upsertCashback(db, {
    householdId: member.householdId,
    updatedBy: member.id,
    year: params.cashbackYear,
    month: params.cashbackMonth,
    title: params.cashbackTitle,
    body: params.cashbackBody
  });
  if (params.action === "create_note") return () => {
    const title = text(params.title, "title");
    const visibility = params.visibility ?? "household";
    const value = createNote(db, {
      ...base, title, body: text(params.body, "body"), visibility
    });
    if (["household", "parents"].includes(visibility)) notifyOtherBoundMembers(db, member, {
      key: `notify:create:note:${value.id}`,
      text: creationNotice(member, "📝", "новая заметка", title)
    });
    return value;
  };
  if (params.action === "update_note") return () => updateNote(db, text(params.noteId, "noteId"), member.id, {
    title: params.title, body: params.body, visibility: params.visibility, expectedRevision: params.expectedRevision
  });
  if (params.action === "delete_note") return () => deleteNote(db, text(params.noteId, "noteId"), member.id);
  if (params.action === "add_shopping_items") return () => {
    const value = addShoppingItems(db, {
      householdId: member.householdId, createdBy: member.id, items: params.items ?? []
    });
    const summary = compactShoppingNames(value.items);
    if (summary) notifyOtherBoundMembers(db, member, {
      key: `notify:create:shopping:${value.items.map(item => item.id).join(",")}`,
      text: creationNotice(member, "🛒", "в покупки", summary)
    });
    return value;
  };
  if (params.action === "toggle_shopping_item") return () => toggleShoppingItem(db, text(params.shoppingItemId, "shoppingItemId"), member.id);
  if (params.action === "clear_bought_shopping") return () => clearBoughtShopping(db, member.id);
  if (params.action === "create_wish") return () => {
    const title = text(params.title, "title");
    const value = createWish(db, {
      householdId: member.householdId, ownerId: member.id, title,
      targetPrice: params.targetPrice, url: params.url, comment: params.comment
    });
    notifyOtherBoundMembers(db, member, {
      key: `notify:create:wish:${value.id}`,
      text: creationNotice(member, "🎁", "новое желание", title)
    });
    return value;
  };
  if (params.action === "update_wish") return () => updateWish(db, text(params.wishId, "wishId"), member.id, {
    title: params.title, targetPrice: params.targetPrice, url: params.url, comment: params.comment
  });
  if (params.action === "remove_wish") return () => removeWish(db, text(params.wishId, "wishId"), member.id);
  if (params.action === "reserve_wish") return () => {
    const wishId = text(params.wishId, "wishId");
    reserveWish(db, wishId, member.id);
    return { id: wishId, reservedBy: member.id };
  };
  if (params.action === "create_place") return () => {
    const title = text(params.title, "title");
    const value = createPlace(db, {
      ...base, name: title, mapsUrl: params.mapsUrl,
      placeId: params.placeId, comment: params.comment
    });
    notifyOtherBoundMembers(db, member, {
      key: `notify:create:place:${value.id}`,
      text: creationNotice(member, "📍", "новое место", title)
    });
    return value;
  };
  if (params.action === "update_place") return () => updatePlace(db, text(params.familyPlaceId, "familyPlaceId"), member.id, {
    name: params.title, mapsUrl: params.mapsUrl, placeId: params.placeId, comment: params.comment
  });
  if (params.action === "delete_place") return () => deletePlace(db, text(params.familyPlaceId, "familyPlaceId"), member.id);
  if (params.action === "create_plan") return () => {
    const title = text(params.title, "title");
    const value = createPlan(db, {
      ...base, title, comment: params.comment,
      participants: params.participants ?? []
    });
    notifyOtherBoundMembers(db, member, {
      key: `notify:create:plan:${value.id}`,
      text: creationNotice(member, "🧳", "новый план", title)
    });
    return value;
  };
  if (params.action === "update_plan") return () => updatePlan(db, text(params.planId, "planId"), member.id, {
    title: params.title, comment: params.comment
  });
  if (params.action === "archive_plan") return () => archivePlan(db, text(params.planId, "planId"), member.id);
  if (params.action === "create_poll") return () => {
    const question = text(params.question, "question");
    const participants = params.participants ?? [];
    const value = createPoll(db, {
      ...base, question, options: params.options ?? [], participants
    });
    notifyOtherBoundMembers(db, member, {
      key: `notify:create:poll:${value.id}`,
      text: creationNotice(member, "💬", "новое голосование", question),
      recipients: participants
    });
    return value;
  };
  if (params.action === "vote_poll") return () => {
    const pollId = text(params.pollId, "pollId");
    const optionIndex = Number(params.optionIndex);
    votePoll(db, pollId, member.id, optionIndex);
    return { id: pollId, optionIndex };
  };
  if (params.action === "close_poll") return () => closePoll(db, text(params.pollId, "pollId"), member.id);
  if (params.action === "create_goal") return () => {
    const title = text(params.title, "title");
    const value = createMoneyGoal(db, {
      ...base, title, amount: Number(params.amount),
      currency: params.currency ?? "RUB", dueAt: text(params.dueAt, "dueAt"),
      assigneeId: params.assigneeId
    });
    notifyOtherBoundMembers(db, member, {
      key: `notify:create:goal:${value.id}`,
      text: creationNotice(member, "🌱", "новая цель", title)
    });
    return value;
  };
  if (params.action === "update_goal") return () => updateMoneyGoal(db, text(params.goalId, "goalId"), member.id, {
    title: params.title, amount: params.amount, currency: params.currency, dueAt: params.dueAt
  });
  if (params.action === "complete_goal") return () => completeMoneyGoal(db, text(params.goalId, "goalId"), member.id);
  if (params.action === "create_capsule") return () => {
    const unlockAt = text(params.unlockAt, "unlockAt");
    const recipientId = text(params.recipientId, "recipientId");
    const unlockDate = new Date(unlockAt);
    if (Number.isNaN(unlockDate.getTime())) throw new Error("invalid capsule unlockAt");
    const value = createCapsule(db, {
      householdId: member.householdId, authorId: member.id,
      recipientId, unlockAt,
      payload: text(params.payload, "payload")
    });
    enqueueOutbox(db, {
      dedupeKey: `capsule:${value.id}:unlock`, recipientMemberId: recipientId,
      kind: "capsule_unlock", payload: { entityId: value.id },
      availableAt: unlockDate.toISOString()
    });
    return value;
  };
  if (params.action === "cancel_capsule") return () => cancelCapsule(db, text(params.capsuleId, "capsuleId"), member.id);
  if (params.action === "create_calendar_event") return () => {
    const title = text(params.title, "title");
    const value = createFamilyCalendarEvent(db, {
      ...base, title, startAt: text(params.startAt, "startAt"),
      endAt: params.endAt, description: params.description
    });
    enqueueOutbox(db, {
      dedupeKey: `calendar:family_event:${value.id}:rev:${value.revision}`,
      recipientMemberId: member.id, kind: "calendar_event_upsert",
      payload: { entityType: "family_event", entityId: value.id, revision: value.revision }
    });
    notifyOtherBoundMembers(db, member, {
      key: `notify:create:calendar:${value.id}`,
      text: creationNotice(member, "📅", "новое событие", title)
    });
    scheduleCalendarStartReminders(db, member, {
      eventId: value.id, revision: value.revision, title,
      startAt: text(params.startAt, "startAt"), nowMs: typeof now === "function" ? now() : now
    });
    return value;
  };
  if (params.action === "update_calendar_event") return () => {
    const id = text(params.calendarEventId, "calendarEventId");
    const value = updateFamilyCalendarEvent(db, id, member.id, {
      title: params.title, startAt: params.startAt, endAt: params.endAt, description: params.description
    });
    enqueueOutbox(db, {
      dedupeKey: `calendar:family_event:${id}:rev:${value.revision}`,
      recipientMemberId: member.id, kind: "calendar_event_upsert",
      payload: { entityType: "family_event", entityId: id, revision: value.revision }
    });
    const current = getFamilyCalendarEvent(db, id, member.id);
    scheduleCalendarStartReminders(db, member, {
      eventId: id, revision: value.revision, title: current.title, startAt: current.startAt,
      nowMs: typeof now === "function" ? now() : now
    });
    return value;
  };
  if (params.action === "delete_calendar_event") return () => {
    const id = text(params.calendarEventId, "calendarEventId");
    const value = cancelFamilyCalendarEvent(db, id, member.id);
    enqueueOutbox(db, {
      dedupeKey: `calendar:family_event:${id}:rev:${value.revision}`,
      recipientMemberId: member.id, kind: "calendar_event_upsert",
      payload: { entityType: "family_event", entityId: id, revision: value.revision }
    });
    clearCalendarStartReminders(db, id);
    return value;
  };
  if (params.action === "create_action") return () => {
    const title = text(params.title, "title");
    const value = createAction(db, {
      ...base, title, assigneeId: params.assigneeId,
      dueAt: params.dueAt ?? null, allDay: params.dueAt ? !String(params.dueAt).includes("T") : true
    });
    if (params.dueAt) enqueueOutbox(db, {
      dedupeKey: `calendar:action:${value.id}:open`, recipientMemberId: member.id,
      kind: "calendar_action_upsert",
      payload: { entityType: "action", entityId: value.id, summary: title, dueAt: params.dueAt }
    });
    notifyOtherBoundMembers(db, member, {
      key: `notify:create:action:${value.id}`,
      text: creationNotice(member, "📌", "новое дело", title)
    });
    return value;
  };
  if (params.action === "update_action") return () => {
    const actionId = text(params.actionId, "actionId");
    const value = updateAction(db, actionId, member.id, {
      title: params.title, assigneeId: params.assigneeId, dueAt: params.dueAt
    });
    const action = db.prepare("SELECT title,due_at AS dueAt FROM actions WHERE id=?").get(actionId);
    if (action?.dueAt) enqueueOutbox(db, {
      dedupeKey: `calendar:action:${actionId}:updated:${action.dueAt}:${action.title}`,
      recipientMemberId: member.id, kind: "calendar_action_upsert",
      payload: { entityType: "action", entityId: actionId, summary: action.title, dueAt: action.dueAt }
    });
    if (value.assigneeId && value.assigneeId !== member.id && value.assigneeId !== value.previousAssigneeId) enqueueOutbox(db, {
      dedupeKey: `notify:action:${actionId}:reassigned:${value.assigneeId}`, recipientMemberId: value.assigneeId, kind: "text",
      payload: { text: `${member.name}: ${assignmentPrefix(action?.dueAt)}${action?.title ?? "Дело"}` }
    });
    return value;
  };
  if (params.action === "cancel_action") return () => {
    const actionId = text(params.actionId, "actionId");
    const value = cancelAction(db, actionId, member.id);
    const action = db.prepare("SELECT due_at AS dueAt,title FROM actions WHERE id=?").get(actionId);
    if (action?.dueAt) enqueueOutbox(db, {
      dedupeKey: `calendar:action:${actionId}:cancelled`, recipientMemberId: member.id,
      kind: "calendar_action_upsert", payload: { entityType: "action", entityId: actionId, summary: action.title, dueAt: action.dueAt }
    });
    return value;
  };
  if (params.action === "complete_action") return () => {
    const actionId = text(params.actionId, "actionId");
    completeAction(db, actionId, member.id);
    const action = db.prepare("SELECT due_at AS dueAt,title FROM actions WHERE id=?").get(actionId);
    if (action?.dueAt) enqueueOutbox(db, {
      dedupeKey: `calendar:action:${actionId}:completed`, recipientMemberId: member.id,
      kind: "calendar_action_upsert",
      payload: { entityType: "action", entityId: actionId, summary: action.title, dueAt: action.dueAt }
    });
    return { id: actionId, status: "completed" };
  };
  return null;
}
function validateCalendarTimestamp(value, field) {
  if (value === undefined || value === null || value === "") return;
  const raw = String(value).trim();
  if (!raw.includes("T")) return;
  if (/z$/iu.test(raw)) {
    throw new Error(`${field} must use a numeric timezone offset (for Moscow use +03:00), not Z`);
  }
  if (!/[+-]\d{2}:\d{2}$/u.test(raw)) {
    throw new Error(`${field} must include an explicit numeric timezone offset`);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid ${field}`);
}

function validateMutation(params) {
  if (params.action === "create_capsule") {
    const d = new Date(String(params.unlockAt ?? ""));
    if (!params.recipientId || !params.payload || Number.isNaN(d.getTime())) throw new Error("capsule requires recipientId, unlockAt and payload");
  }
  if (params.action === "create_calendar_event") {
    text(params.title, "title"); text(params.startAt, "startAt");
    validateCalendarTimestamp(params.startAt, "startAt");
    validateCalendarTimestamp(params.endAt, "endAt");
  }
  if (params.action === "update_calendar_event") {
    validateCalendarTimestamp(params.startAt, "startAt");
    validateCalendarTimestamp(params.endAt, "endAt");
  }
  if (params.action === "create_action" && !params.dueAt && params.allowUndated !== true) {
    return result({ ok: false, needsDate: true, message: "Нужна дата или явное указание без срока." });
  }
  if (params.action === "create_poll") {
    if (!Array.isArray(params.options) || params.options.length < 2) throw new Error("poll needs at least two options");
    if (!Array.isArray(params.participants) || params.participants.length < 1) throw new Error("poll needs at least one participant");
  }
  if (params.action === "vote_poll" && (!Number.isInteger(Number(params.optionIndex)) || Number(params.optionIndex) < 0)) {
    throw new Error("optionIndex must be a non-negative integer");
  }
  if (params.action === "update_goal" && params.amount !== undefined && (!Number.isFinite(Number(params.amount)) || Number(params.amount) < 0)) {
    throw new Error("amount must be a non-negative number");
  }
  if (params.action === "create_goal") {
    if (!Number.isFinite(Number(params.amount)) || Number(params.amount) < 0) {
      throw new Error("amount must be a non-negative number");
    }
    text(params.dueAt, "dueAt");
  }
  if (params.action === "set_cashback") {
    const year = Number(params.cashbackYear);
    const month = Number(params.cashbackMonth);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error("cashbackYear must be 2000..2100");
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("cashbackMonth must be 1..12");
    text(params.cashbackBody, "cashbackBody");
  }
  return null;
}

export function executeFamilyAction({ db, member, params, actionKey = null, now = Date.now }) {
  const read = readAction(db, member, params);
  if (read) return read;
  const guard = validateMutation(params);
  if (guard) return guard;
  const mutate = mutationInput(db, member, params, now);
  if (!mutate) throw new Error(`Unsupported family action: ${params.action}`);
  if (!actionKey) throw new Error("Family mutation requires actionKey");
  const outcome = mutateOnce(db, actionKey, mutate);
  if (outcome.duplicate) return result({ ok: true, duplicate: true });
  return result({ ok: true, duplicate: false, value: outcome.value });
}

export function createFamilyTool({ db, runtimeId, agentId = "main", toolContext, now = Date.now }) {
  if (toolContext?.senderIsOwner !== true) return null;
  if (String(toolContext?.messageChannel ?? "").toLowerCase() !== "telegram") return null;
  if (String(toolContext?.agentId ?? "").toLowerCase() !== String(agentId).toLowerCase()) return null;
  if (!validSessionAgent(toolContext?.sessionKey, agentId)) return null;
  const member = resolveMemberForAgent(db, runtimeId, agentId);
  if (!member) return null;
  return {
    name: "family",
    label: "Family Hub",
    description: "Read and update trusted Family Hub records for the current human member. Identity comes only from host context.",
    parameters: TOOL_PARAMETERS,
    async execute(toolCallId, params) {
      return executeFamilyAction({
        db, member, params, now,
        actionKey: `family:${runtimeId}:${toolContext.sessionKey}:${toolCallId}`
      });
    }
  };
}
