import { randomUUID } from "node:crypto";

const uid = () => randomUUID();
const plain = row => row ? { ...row } : null;

function member(db, memberId) {
  const row = db.prepare("SELECT id,household_id AS householdId,name,role FROM members WHERE id=?").get(memberId);
  if (!row) throw new Error(`Unknown family member: ${memberId}`);
  return plain(row);
}

function sameHousehold(db, householdId, ...memberIds) {
  for (const memberId of memberIds.filter(Boolean)) {
    if (member(db, memberId).householdId !== householdId) throw new Error("Cross-household access denied");
  }
}

function requireManager(db, householdId, actorId, owners = []) {
  sameHousehold(db, householdId, actorId, ...owners.filter(Boolean));
  const actor = member(db, actorId);
  if (actor.role !== "parent" && !owners.includes(actorId)) throw new Error("Family record update denied");
  return actor;
}

function event(db, entityType, entityId, actorId, eventType, payload = null) {
  db.prepare("INSERT INTO entity_events(entity_type,entity_id,actor_id,event_type,payload_json) VALUES (?,?,?,?,?)")
    .run(entityType, entityId, actorId ?? null, eventType, payload ? JSON.stringify(payload) : null);
}

export function createNote(db, input) {
  sameHousehold(db, input.householdId, input.createdBy, ...(input.selectedMembers ?? []));
  const id = uid();
  db.prepare("INSERT INTO notes(id,household_id,created_by,title,body,visibility) VALUES (?,?,?,?,?,?)")
    .run(id, input.householdId, input.createdBy, input.title, input.body, input.visibility ?? "household");
  const acl = db.prepare("INSERT OR IGNORE INTO note_acl(note_id,member_id) VALUES (?,?)");
  for (const memberId of input.selectedMembers ?? []) acl.run(id, memberId);
  db.prepare("INSERT INTO notes_fts(note_id,title,body) VALUES (?,?,?)").run(id, input.title, input.body);
  event(db, "note", id, input.createdBy, "created");
  return { id, revision: 1 };
}

function canReadNote(db, note, viewerId) {
  const viewer = member(db, viewerId);
  if (viewer.householdId !== note.householdId || note.deletedAt) return false;
  if (note.createdBy === viewerId || note.visibility === "household") return true;
  if (note.visibility === "parents") return viewer.role === "parent";
  if (note.visibility === "owner") return false;
  return Boolean(db.prepare("SELECT 1 AS ok FROM note_acl WHERE note_id=? AND member_id=?").get(note.id, viewerId));
}

function ftsQuery(text) {
  return String(text).trim().split(/\s+/u).filter(Boolean)
    .map(token => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

export function searchNotes(db, query, viewerId) {
  const match = ftsQuery(query);
  if (!match) return [];
  const rows = db.prepare(`
    SELECT n.id,n.household_id AS householdId,n.created_by AS createdBy,n.title,n.body,n.visibility,n.revision,n.deleted_at AS deletedAt
    FROM notes_fts f JOIN notes n ON n.id=f.note_id
    WHERE notes_fts MATCH ? ORDER BY rank LIMIT 50
  `).all(match);
  return rows.map(plain).filter(row => canReadNote(db, row, viewerId));
}

export function createWish(db, input) {
  sameHousehold(db, input.householdId, input.ownerId);
  const id = uid();
  db.prepare("INSERT INTO wishes(id,household_id,owner_id,title,target_price,url,comment) VALUES (?,?,?,?,?,?,?)")
    .run(id, input.householdId, input.ownerId, input.title, input.targetPrice ?? null, input.url ?? null, input.comment ?? null);
  event(db, "wish", id, input.ownerId, "created");
  return { id };
}

export function reserveWish(db, wishId, reserverId) {
  const wish = db.prepare("SELECT household_id AS householdId,owner_id AS ownerId FROM wishes WHERE id=?").get(wishId);
  if (!wish) throw new Error("Wish not found");
  sameHousehold(db, wish.householdId, reserverId);
  if (wish.ownerId === reserverId) throw new Error("Wish owner cannot reserve own wish");
  db.prepare("INSERT INTO wish_reservations(wish_id,reserved_by) VALUES (?,?) ON CONFLICT(wish_id) DO UPDATE SET reserved_by=excluded.reserved_by,created_at=CURRENT_TIMESTAMP")
    .run(wishId, reserverId);
  event(db, "wish", wishId, reserverId, "reserved");
}

export function getWishForViewer(db, wishId, viewerId) {
  const row = db.prepare(`SELECT w.id,w.household_id AS householdId,w.owner_id AS ownerId,w.title,w.target_price AS targetPrice,w.url,w.comment,w.status,r.reserved_by AS reservation FROM wishes w LEFT JOIN wish_reservations r ON r.wish_id=w.id WHERE w.id=?`).get(wishId);
  if (!row) return null;
  sameHousehold(db, row.householdId, viewerId);
  const result = plain(row);
  result.reservedBy = result.ownerId === viewerId ? null : (result.reservation ?? null);
  delete result.reservation;
  return result;
}

export function createAction(db, input) {
  sameHousehold(db, input.householdId, input.createdBy, input.assigneeId);
  const id = uid();
  db.prepare("INSERT INTO actions(id,household_id,created_by,assignee_id,title,due_at,all_day,reminder_policy) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, input.householdId, input.createdBy, input.assigneeId ?? null, input.title, input.dueAt ?? null, input.allDay === false ? 0 : 1, input.reminderPolicy ?? "daily_until_done");
  event(db, "action", id, input.createdBy, "created");
  return { id };
}

export function getAction(db, actionId) {
  return plain(db.prepare("SELECT id,title,due_at AS dueAt,status,assignee_id AS assigneeId,google_event_id AS googleEventId FROM actions WHERE id=?").get(actionId));
}

export function completeAction(db, actionId, actorId) {
  const row = db.prepare("SELECT household_id AS householdId,created_by AS createdBy,assignee_id AS assigneeId,status FROM actions WHERE id=?").get(actionId);
  if (!row) throw new Error("Action not found");
  sameHousehold(db, row.householdId, actorId);
  const actor = member(db, actorId);
  if (![row.createdBy, row.assigneeId].includes(actorId) && actor.role !== "parent") throw new Error("Action completion denied");
  if (row.status === "open") db.prepare("UPDATE actions SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?").run(actionId);
  event(db, "action", actionId, actorId, "completed");
}

export function createPoll(db, input) {
  sameHousehold(db, input.householdId, input.createdBy, ...input.participants);
  if (!Array.isArray(input.options) || input.options.length < 2) throw new Error("Poll needs at least two options");
  const id = uid();
  db.exec("SAVEPOINT family_create_poll");
  try {
    db.prepare("INSERT INTO polls(id,household_id,created_by,question) VALUES (?,?,?,?)").run(id, input.householdId, input.createdBy, input.question);
    const optionStmt = db.prepare("INSERT INTO poll_options(id,poll_id,option_index,label) VALUES (?,?,?,?)");
    input.options.forEach((label, index) => optionStmt.run(uid(), id, index, label));
    const participantStmt = db.prepare("INSERT INTO poll_participants(poll_id,member_id) VALUES (?,?)");
    for (const participant of input.participants) participantStmt.run(id, participant);
    db.exec("RELEASE SAVEPOINT family_create_poll");
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT family_create_poll");
    db.exec("RELEASE SAVEPOINT family_create_poll");
    throw error;
  }
  event(db, "poll", id, input.createdBy, "created");
  return { id };
}

export function votePoll(db, pollId, memberId, optionIndex) {
  const poll = db.prepare("SELECT status FROM polls WHERE id=?").get(pollId);
  if (!poll) throw new Error("Poll not found");
  if (poll.status !== "active") throw new Error("Poll is closed");
  const participant = db.prepare("SELECT 1 AS ok FROM poll_participants WHERE poll_id=? AND member_id=?").get(pollId, memberId);
  if (!participant) throw new Error("Not a poll participant");
  const option = db.prepare("SELECT id FROM poll_options WHERE poll_id=? AND option_index=?").get(pollId, optionIndex);
  if (!option) throw new Error("Poll option not found");
  db.prepare("INSERT INTO poll_votes(poll_id,member_id,option_id) VALUES (?,?,?) ON CONFLICT(poll_id,member_id) DO UPDATE SET option_id=excluded.option_id,voted_at=CURRENT_TIMESTAMP")
    .run(pollId, memberId, option.id);
  db.prepare("UPDATE poll_participants SET voted_at=CURRENT_TIMESTAMP WHERE poll_id=? AND member_id=?").run(pollId, memberId);
  event(db, "poll", pollId, memberId, "voted");
}

export function getPollForViewer(db, pollId, viewerId) {
  const poll = db.prepare("SELECT id,household_id AS householdId,question,status FROM polls WHERE id=?").get(pollId);
  if (!poll) return null;
  sameHousehold(db, poll.householdId, viewerId);
  const participant = db.prepare("SELECT voted_at AS votedAt FROM poll_participants WHERE poll_id=? AND member_id=?").get(pollId, viewerId);
  if (!participant) throw new Error("Not a poll participant");
  const options = db.prepare("SELECT option_index AS optionIndex,label FROM poll_options WHERE poll_id=? ORDER BY option_index").all(pollId).map(plain);
  const votes = participant.votedAt ? db.prepare(`SELECT v.member_id AS memberId,o.option_index AS optionIndex,o.label FROM poll_votes v JOIN poll_options o ON o.id=v.option_id WHERE v.poll_id=? ORDER BY v.voted_at`).all(pollId).map(plain) : null;
  return { ...plain(poll), options, votes };
}

export function createPlan(db, input) {
  sameHousehold(db, input.householdId, input.createdBy, ...(input.participants ?? []));
  const id = uid();
  db.prepare("INSERT INTO plans(id,household_id,created_by,title,comment) VALUES (?,?,?,?,?)").run(id, input.householdId, input.createdBy, input.title, input.comment ?? null);
  const stmt = db.prepare("INSERT OR IGNORE INTO plan_participants(plan_id,member_id) VALUES (?,?)");
  for (const participant of input.participants ?? []) stmt.run(id, participant);
  event(db, "plan", id, input.createdBy, "created");
  return { id };
}

export function createMoneyGoal(db, input) {
  sameHousehold(db, input.householdId, input.createdBy, input.assigneeId);
  const id = uid();
  db.prepare("INSERT INTO money_goals(id,household_id,created_by,assignee_id,title,amount,currency,due_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, input.householdId, input.createdBy, input.assigneeId ?? null, input.title, input.amount, input.currency ?? "RUB", input.dueAt);
  event(db, "money_goal", id, input.createdBy, "created");
  return { id };
}

export function linkEntityToPlan(db, planId, entityType, entityId) {
  db.prepare("INSERT OR IGNORE INTO plan_links(plan_id,entity_type,entity_id) VALUES (?,?,?)").run(planId, entityType, entityId);
}

export function createPlace(db, input) {
  sameHousehold(db, input.householdId, input.createdBy);
  const id = uid();
  db.prepare("INSERT INTO places(id,household_id,created_by,name,maps_url,place_id,comment) VALUES (?,?,?,?,?,?,?)")
    .run(id, input.householdId, input.createdBy, input.name, input.mapsUrl ?? null, input.placeId ?? null, input.comment ?? null);
  event(db, "place", id, input.createdBy, "created");
  return { id };
}

export function createCapsule(db, input) {
  sameHousehold(db, input.householdId, input.authorId, input.recipientId);
  const id = uid();
  db.prepare("INSERT INTO capsules(id,household_id,author_id,recipient_id,unlock_at,payload) VALUES (?,?,?,?,?,?)")
    .run(id, input.householdId, input.authorId, input.recipientId, input.unlockAt, input.payload);
  event(db, "capsule", id, input.authorId, "created");
  return { id };
}

export function getCapsuleForViewer(db, capsuleId, viewerId, now = new Date()) {
  const row = db.prepare("SELECT id,household_id AS householdId,author_id AS authorId,recipient_id AS recipientId,unlock_at AS unlockAt,payload,status,automation_job_id AS automationJobId FROM capsules WHERE id=?").get(capsuleId);
  if (!row) return null;
  sameHousehold(db, row.householdId, viewerId);
  if (![row.authorId, row.recipientId].includes(viewerId)) return null;
  const result = plain(row);
  if (result.status === "cancelled") return null;
  if (result.status === "sealed" && new Date(result.unlockAt) > now) result.payload = null;
  return result;
}

export function unlockCapsule(db, capsuleId) {
  const row = db.prepare("SELECT id,status FROM capsules WHERE id=?").get(capsuleId);
  if (!row) throw new Error("Capsule not found");
  if (row.status === "cancelled") return { id: capsuleId, status: "cancelled" };
  if (row.status === "delivered") return { id: capsuleId, status: "delivered" };
  db.prepare("UPDATE capsules SET status='delivered' WHERE id=?").run(capsuleId);
  event(db, "capsule", capsuleId, null, "unlocked");
  return { id: capsuleId, status: "delivered" };
}

export function cancelCapsule(db, capsuleId, actorId) {
  const row = db.prepare("SELECT household_id AS householdId,author_id AS authorId,status FROM capsules WHERE id=?").get(capsuleId);
  if (!row) throw new Error("Capsule not found");
  sameHousehold(db, row.householdId, actorId);
  if (row.authorId !== actorId) throw new Error("Only capsule author can cancel capsule");
  if (row.status !== "sealed") throw new Error("Only sealed capsule can be cancelled");
  db.prepare("UPDATE capsules SET status='cancelled' WHERE id=?").run(capsuleId);
  event(db, "capsule", capsuleId, actorId, "cancelled");
  return { id: capsuleId, status: "cancelled" };
}

function familyEventWindow(startAt, endAt = null) {
  const raw = String(startAt ?? "").trim();
  if (!raw) throw new Error("Family event start is required");
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  if (allDay) {
    if (endAt) return { startAt: raw, endAt: String(endAt), allDay: true };
    const next = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(next.getTime())) throw new Error("Invalid family event date");
    next.setUTCDate(next.getUTCDate() + 1);
    return { startAt: raw, endAt: next.toISOString().slice(0, 10), allDay: true };
  }
  const start = new Date(raw);
  if (Number.isNaN(start.getTime())) throw new Error("Invalid family event date/time");
  const end = endAt ? new Date(String(endAt)) : new Date(start.getTime() + 60 * 60 * 1000);
  if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) throw new Error("Invalid family event end");
  return { startAt: raw, endAt: endAt ? String(endAt) : end.toISOString(), allDay: false };
}

export function createFamilyCalendarEvent(db, input) {
  sameHousehold(db, input.householdId, input.createdBy);
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("Family event title is required");
  const window = familyEventWindow(input.startAt, input.endAt);
  const id = uid();
  db.prepare(`INSERT INTO family_events(id,household_id,created_by,title,start_at,end_at,all_day,description)
    VALUES (?,?,?,?,?,?,?,?)`).run(
      id, input.householdId, input.createdBy, title, window.startAt, window.endAt,
      window.allDay ? 1 : 0, input.description ?? null
    );
  event(db, "family_event", id, input.createdBy, "created", { title, startAt: window.startAt });
  return { id, revision: 1 };
}

export function getFamilyCalendarEvent(db, eventId, viewerId) {
  const row = db.prepare(`SELECT id,household_id AS householdId,created_by AS createdBy,title,start_at AS startAt,end_at AS endAt,
    all_day AS allDay,description,google_event_id AS googleEventId,status,revision FROM family_events WHERE id=?`).get(eventId);
  if (!row) return null;
  sameHousehold(db, row.householdId, viewerId);
  return plain(row);
}

export function updateFamilyCalendarEvent(db, eventId, actorId, patch = {}) {
  const row = getFamilyCalendarEvent(db, eventId, actorId);
  if (!row || row.status !== "active") throw new Error("Family event not found");
  requireManager(db, row.householdId, actorId, [row.createdBy]);
  const title = patch.title === undefined ? row.title : String(patch.title).trim();
  if (!title) throw new Error("Family event title is required");
  const startAt = patch.startAt === undefined ? row.startAt : String(patch.startAt);
  const window = patch.startAt === undefined && patch.endAt === undefined
    ? { startAt: row.startAt, endAt: row.endAt, allDay: Number(row.allDay) === 1 }
    : familyEventWindow(startAt, patch.endAt === undefined ? null : patch.endAt);
  const description = patch.description === undefined ? row.description : patch.description;
  const revision = Number(row.revision) + 1;
  db.prepare(`UPDATE family_events SET title=?,start_at=?,end_at=?,all_day=?,description=?,revision=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(title, window.startAt, window.endAt, window.allDay ? 1 : 0, description ?? null, revision, eventId);
  event(db, "family_event", eventId, actorId, "updated", { title, startAt: window.startAt, revision });
  return { id: eventId, revision };
}

export function cancelFamilyCalendarEvent(db, eventId, actorId) {
  const row = getFamilyCalendarEvent(db, eventId, actorId);
  if (!row || row.status !== "active") throw new Error("Family event not found");
  requireManager(db, row.householdId, actorId, [row.createdBy]);
  const revision = Number(row.revision) + 1;
  db.prepare("UPDATE family_events SET status='cancelled',revision=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(revision, eventId);
  event(db, "family_event", eventId, actorId, "cancelled", { revision });
  return { id: eventId, status: "cancelled", revision };
}

export function updateNote(db, noteId, actorId, patch = {}) {
  const row = db.prepare("SELECT id,household_id AS householdId,created_by AS createdBy,title,body,visibility,revision,deleted_at AS deletedAt FROM notes WHERE id=?").get(noteId);
  if (!row || row.deletedAt) throw new Error("Note not found");
  requireManager(db, row.householdId, actorId, [row.createdBy]);
  const title = patch.title === undefined ? row.title : String(patch.title).trim();
  const body = patch.body === undefined ? row.body : String(patch.body).trim();
  const visibility = patch.visibility === undefined ? row.visibility : String(patch.visibility);
  if (!title || !body) throw new Error("Note title and body are required");
  const expectedRevision = patch.expectedRevision === undefined ? Number(row.revision) : Number(patch.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("Invalid note revision");
  const revision = expectedRevision + 1;
  const updated = db.prepare("UPDATE notes SET title=?,body=?,visibility=?,revision=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND revision=? AND deleted_at IS NULL")
    .run(title, body, visibility, revision, noteId, expectedRevision);
  if (Number(updated.changes) !== 1) throw new Error("Note changed by another member");
  db.prepare("DELETE FROM notes_fts WHERE note_id=?").run(noteId);
  db.prepare("INSERT INTO notes_fts(note_id,title,body) VALUES (?,?,?)").run(noteId, title, body);
  event(db, "note", noteId, actorId, "updated", { title, visibility, revision });
  return { id: noteId, revision };
}

export function deleteNote(db, noteId, actorId) {
  const row = db.prepare("SELECT household_id AS householdId,created_by AS createdBy,deleted_at AS deletedAt FROM notes WHERE id=?").get(noteId);
  if (!row || row.deletedAt) throw new Error("Note not found");
  requireManager(db, row.householdId, actorId, [row.createdBy]);
  db.prepare("UPDATE notes SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(noteId);
  db.prepare("DELETE FROM notes_fts WHERE note_id=?").run(noteId);
  event(db, "note", noteId, actorId, "deleted");
  return { id: noteId, deleted: true };
}

export function updateWish(db, wishId, actorId, patch = {}) {
  const row = db.prepare("SELECT household_id AS householdId,owner_id AS ownerId,title,target_price AS targetPrice,url,comment,status FROM wishes WHERE id=?").get(wishId);
  if (!row || row.status !== "active") throw new Error("Wish not found");
  sameHousehold(db, row.householdId, actorId);
  if (row.ownerId !== actorId) throw new Error("Only wish owner can edit wish");
  const title = patch.title === undefined ? row.title : String(patch.title).trim();
  if (!title) throw new Error("Wish title is required");
  const targetPrice = patch.targetPrice === undefined ? row.targetPrice : patch.targetPrice;
  const url = patch.url === undefined ? row.url : patch.url;
  const comment = patch.comment === undefined ? row.comment : patch.comment;
  db.prepare("UPDATE wishes SET title=?,target_price=?,url=?,comment=? WHERE id=?").run(title, targetPrice ?? null, url ?? null, comment ?? null, wishId);
  event(db, "wish", wishId, actorId, "updated", { title });
  return { id: wishId };
}

export function removeWish(db, wishId, actorId) {
  const row = db.prepare("SELECT household_id AS householdId,owner_id AS ownerId,status FROM wishes WHERE id=?").get(wishId);
  if (!row || row.status !== "active") throw new Error("Wish not found");
  sameHousehold(db, row.householdId, actorId);
  if (row.ownerId !== actorId) throw new Error("Only wish owner can remove wish");
  db.prepare("UPDATE wishes SET status='removed' WHERE id=?").run(wishId);
  db.prepare("DELETE FROM wish_reservations WHERE wish_id=?").run(wishId);
  event(db, "wish", wishId, actorId, "removed");
  return { id: wishId, status: "removed" };
}

export function updatePlace(db, placeId, actorId, patch = {}) {
  const row = db.prepare("SELECT household_id AS householdId,created_by AS createdBy,name,maps_url AS mapsUrl,place_id AS placeRef,comment FROM places WHERE id=?").get(placeId);
  if (!row) throw new Error("Place not found");
  requireManager(db, row.householdId, actorId, [row.createdBy]);
  const name = patch.name === undefined ? row.name : String(patch.name).trim();
  if (!name) throw new Error("Place name is required");
  db.prepare("UPDATE places SET name=?,maps_url=?,place_id=?,comment=? WHERE id=?").run(
    name, patch.mapsUrl === undefined ? row.mapsUrl : (patch.mapsUrl ?? null),
    patch.placeId === undefined ? row.placeRef : (patch.placeId ?? null),
    patch.comment === undefined ? row.comment : (patch.comment ?? null), placeId
  );
  event(db, "place", placeId, actorId, "updated", { name });
  return { id: placeId };
}

export function deletePlace(db, placeId, actorId) {
  const row = db.prepare("SELECT household_id AS householdId,created_by AS createdBy FROM places WHERE id=?").get(placeId);
  if (!row) throw new Error("Place not found");
  requireManager(db, row.householdId, actorId, [row.createdBy]);
  event(db, "place", placeId, actorId, "deleted");
  db.prepare("DELETE FROM places WHERE id=?").run(placeId);
  return { id: placeId, deleted: true };
}

export function updatePlan(db, planId, actorId, patch = {}) {
  const row = db.prepare("SELECT household_id AS householdId,created_by AS createdBy,title,comment,status FROM plans WHERE id=?").get(planId);
  if (!row) throw new Error("Plan not found");
  requireManager(db, row.householdId, actorId, [row.createdBy]);
  const title = patch.title === undefined ? row.title : String(patch.title).trim();
  if (!title) throw new Error("Plan title is required");
  const comment = patch.comment === undefined ? row.comment : patch.comment;
  db.prepare("UPDATE plans SET title=?,comment=? WHERE id=?").run(title, comment ?? null, planId);
  event(db, "plan", planId, actorId, "updated", { title });
  return { id: planId };
}

export function archivePlan(db, planId, actorId) {
  const row = db.prepare("SELECT household_id AS householdId,created_by AS createdBy FROM plans WHERE id=?").get(planId);
  if (!row) throw new Error("Plan not found");
  requireManager(db, row.householdId, actorId, [row.createdBy]);
  db.prepare("UPDATE plans SET status='archived' WHERE id=?").run(planId);
  event(db, "plan", planId, actorId, "archived");
  return { id: planId, status: "archived" };
}

export function updateAction(db, actionId, actorId, patch = {}) {
  const row = db.prepare("SELECT household_id AS householdId,created_by AS createdBy,assignee_id AS assigneeId,title,due_at AS dueAt,all_day AS allDay,status FROM actions WHERE id=?").get(actionId);
  if (!row || row.status !== "open") throw new Error("Action not found");
  requireManager(db, row.householdId, actorId, [row.createdBy, row.assigneeId]);
  if (patch.assigneeId !== undefined) sameHousehold(db, row.householdId, patch.assigneeId);
  const title = patch.title === undefined ? row.title : String(patch.title).trim();
  if (!title) throw new Error("Action title is required");
  const assigneeId = patch.assigneeId === undefined ? row.assigneeId : (patch.assigneeId ?? null);
  const dueAt = patch.dueAt === undefined ? row.dueAt : (patch.dueAt ?? null);
  const allDay = patch.dueAt === undefined ? Number(row.allDay) : (dueAt ? (String(dueAt).includes("T") ? 0 : 1) : 1);
  db.prepare("UPDATE actions SET title=?,assignee_id=?,due_at=?,all_day=? WHERE id=?").run(title, assigneeId, dueAt, allDay, actionId);
  event(db, "action", actionId, actorId, "updated", { title, assigneeId, dueAt });
  return { id: actionId, previousAssigneeId: row.assigneeId, assigneeId, dueAt };
}

export function cancelAction(db, actionId, actorId) {
  const row = db.prepare("SELECT household_id AS householdId,created_by AS createdBy,assignee_id AS assigneeId,status FROM actions WHERE id=?").get(actionId);
  if (!row || row.status !== "open") throw new Error("Action not found");
  requireManager(db, row.householdId, actorId, [row.createdBy, row.assigneeId]);
  db.prepare("UPDATE actions SET status='cancelled',completed_at=CURRENT_TIMESTAMP WHERE id=?").run(actionId);
  event(db, "action", actionId, actorId, "cancelled");
  return { id: actionId, status: "cancelled" };
}

export function closePoll(db, pollId, actorId) {
  const row = db.prepare("SELECT household_id AS householdId,created_by AS createdBy,status FROM polls WHERE id=?").get(pollId);
  if (!row) throw new Error("Poll not found");
  requireManager(db, row.householdId, actorId, [row.createdBy]);
  if (row.status === "active") db.prepare("UPDATE polls SET status='closed',closed_at=CURRENT_TIMESTAMP WHERE id=?").run(pollId);
  event(db, "poll", pollId, actorId, "closed");
  return { id: pollId, status: "closed" };
}

export function updateMoneyGoal(db, goalId, actorId, patch = {}) {
  const row = db.prepare("SELECT household_id AS householdId,created_by AS createdBy,assignee_id AS assigneeId,title,amount,currency,due_at AS dueAt,status FROM money_goals WHERE id=?").get(goalId);
  if (!row || row.status !== "open") throw new Error("Goal not found");
  requireManager(db, row.householdId, actorId, [row.createdBy, row.assigneeId]);
  const title = patch.title === undefined ? row.title : String(patch.title).trim();
  const amount = patch.amount === undefined ? row.amount : Number(patch.amount);
  const currency = patch.currency === undefined ? row.currency : String(patch.currency);
  const dueAt = patch.dueAt === undefined ? row.dueAt : String(patch.dueAt);
  if (!title || !Number.isFinite(amount) || amount < 0 || !dueAt) throw new Error("Invalid goal update");
  db.prepare("UPDATE money_goals SET title=?,amount=?,currency=?,due_at=? WHERE id=?").run(title, amount, currency, dueAt, goalId);
  event(db, "money_goal", goalId, actorId, "updated", { title, amount, currency, dueAt });
  return { id: goalId };
}

export function completeMoneyGoal(db, goalId, actorId) {
  const row = db.prepare("SELECT household_id AS householdId,created_by AS createdBy,assignee_id AS assigneeId,status FROM money_goals WHERE id=?").get(goalId);
  if (!row || row.status !== "open") throw new Error("Goal not found");
  requireManager(db, row.householdId, actorId, [row.createdBy, row.assigneeId]);
  db.prepare("UPDATE money_goals SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?").run(goalId);
  event(db, "money_goal", goalId, actorId, "completed");
  return { id: goalId, status: "completed" };
}

export function listShopping(db, viewerId) {
  const viewer = member(db, viewerId);
  return db.prepare(`SELECT id,name,checked,created_by AS createdBy,checked_by AS checkedBy,created_at AS createdAt,updated_at AS updatedAt
    FROM shopping_items WHERE household_id=? ORDER BY checked ASC,created_at ASC,rowid ASC`).all(viewer.householdId).map(row => ({ ...row, checked: Number(row.checked) === 1 }));
}

export function addShoppingItems(db, { householdId, createdBy, items }) {
  sameHousehold(db, householdId, createdBy);
  const names = [...new Set((items ?? []).map(value => String(value ?? "").trim()).filter(Boolean))];
  if (!names.length) throw new Error("Shopping items are required");
  const insert = db.prepare("INSERT INTO shopping_items(id,household_id,created_by,name) VALUES (?,?,?,?)");
  const created = [];
  for (const name of names) {
    const id = uid();
    insert.run(id, householdId, createdBy, name);
    created.push({ id, name, checked: false });
    event(db, "shopping_item", id, createdBy, "created", { name });
  }
  return { items: created };
}

export function toggleShoppingItem(db, itemId, actorId) {
  const row = db.prepare("SELECT id,household_id AS householdId,name,checked FROM shopping_items WHERE id=?").get(itemId);
  if (!row) throw new Error("Shopping item not found");
  sameHousehold(db, row.householdId, actorId);
  const checked = Number(row.checked) === 1 ? 0 : 1;
  db.prepare("UPDATE shopping_items SET checked=?,checked_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(checked, checked ? actorId : null, itemId);
  event(db, "shopping_item", itemId, actorId, checked ? "checked" : "unchecked");
  return { id: itemId, checked: checked === 1 };
}

export function clearBoughtShopping(db, actorId) {
  const actor = member(db, actorId);
  const rows = db.prepare("SELECT id FROM shopping_items WHERE household_id=? AND checked=1").all(actor.householdId);
  db.prepare("DELETE FROM shopping_items WHERE household_id=? AND checked=1").run(actor.householdId);
  for (const row of rows) event(db, "shopping_item", row.id, actorId, "cleared");
  return { cleared: rows.length };
}


export function upsertCashback(db, input) {
  sameHousehold(db, input.householdId, input.updatedBy);
  const year = Number(input.year);
  const month = Number(input.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error("Invalid cashback year");
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("Invalid cashback month");
  const title = String(input.title ?? "").trim() || `Кэшбэк — ${year}-${String(month).padStart(2, "0")}`;
  const body = String(input.body ?? "").trim();
  if (!body) throw new Error("Cashback body is required");
  const id = `cashback:${input.householdId}:${year}-${String(month).padStart(2, "0")}`;
  db.prepare(`
    INSERT INTO cashback_periods(id,household_id,year,month,title,body,created_by,updated_by)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(household_id,year,month) DO UPDATE SET
      title=excluded.title,
      body=excluded.body,
      updated_by=excluded.updated_by,
      updated_at=CURRENT_TIMESTAMP
  `).run(id, input.householdId, year, month, title, body, input.updatedBy, input.updatedBy);
  event(db, "cashback", id, input.updatedBy, "upserted", { year, month });
  return plain(db.prepare(`
    SELECT id,year,month,title,body,updated_at AS updatedAt
    FROM cashback_periods WHERE id=?
  `).get(id));
}

export function listSection(db, section, viewerId, limit = 20) {
  const viewer = member(db, viewerId);
  const h = viewer.householdId;
  if (section === "actions") return db.prepare("SELECT id,title,due_at AS dueAt,status,assignee_id AS assigneeId FROM actions WHERE household_id=? AND status='open' ORDER BY due_at IS NULL,due_at LIMIT ?").all(h, limit).map(plain);
  if (section === "shopping") return listShopping(db, viewerId).slice(0, limit);
  if (section === "cashback") return db.prepare("SELECT id,year,month,title,body,updated_at AS updatedAt FROM cashback_periods WHERE household_id=? ORDER BY year DESC,month DESC LIMIT ?").all(h, limit).map(plain);
  if (section === "places") return db.prepare("SELECT id,name,maps_url AS mapsUrl,comment FROM places WHERE household_id=? ORDER BY created_at DESC LIMIT ?").all(h, limit).map(plain);
  if (section === "plans") return db.prepare("SELECT id,title,status,comment FROM plans WHERE household_id=? AND status='active' ORDER BY created_at DESC LIMIT ?").all(h, limit).map(plain);
  if (section === "polls") return db.prepare("SELECT id,question,status FROM polls WHERE household_id=? ORDER BY created_at DESC LIMIT ?").all(h, limit).map(plain);
  if (section === "goals") return db.prepare("SELECT id,title,amount,currency,due_at AS dueAt,status FROM money_goals WHERE household_id=? AND status='open' ORDER BY due_at LIMIT ?").all(h, limit).map(plain);
  if (section === "wishes") return db.prepare("SELECT id FROM wishes WHERE household_id=? AND status='active' ORDER BY created_at DESC LIMIT ?").all(h, limit).map(row => getWishForViewer(db, row.id, viewerId));
  if (section === "notes") return db.prepare("SELECT id,title,body,visibility,revision,created_by AS createdBy,household_id AS householdId,deleted_at AS deletedAt FROM notes WHERE household_id=? ORDER BY updated_at DESC LIMIT ?").all(h, limit).map(plain).filter(row => canReadNote(db, row, viewerId));
  if (section === "capsules") return db.prepare("SELECT id FROM capsules WHERE household_id=? AND status<>'cancelled' AND (author_id=? OR recipient_id=?) ORDER BY unlock_at LIMIT ?").all(h, viewerId, viewerId, limit).map(row => getCapsuleForViewer(db, row.id, viewerId)).filter(Boolean);
  throw new Error(`Unknown family section: ${section}`);
}
