import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import {
  createNote, searchNotes,
  createWish, reserveWish, getWishForViewer,
  createAction, completeAction, getAction,
  createPoll, votePoll, getPollForViewer,
  createPlan, createMoneyGoal, linkEntityToPlan,
} from "../dist/domain.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-domain-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [
      { id: "participant_alpha", name: "Иван", role: "parent" },
      { id: "participant_beta", name: "Мария", role: "parent" },
      { id: "child", name: "Ребёнок", role: "child" },
    ], bindings: [],
  });
  return { db, dir };
}

test("notes enforce ACL and are searchable with FTS", () => {
  const { db, dir } = fixture();
  try {
    createNote(db, { householdId: "home", createdBy: "participant_alpha", title: "Кондиционер", body: "Фильтр 300x600", visibility: "parents" });
    assert.equal(searchNotes(db, "фильтр", "participant_beta").length, 1);
    assert.equal(searchNotes(db, "фильтр", "child").length, 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("wish reservation is secret from the wish owner", () => {
  const { db, dir } = fixture();
  try {
    const wish = createWish(db, { householdId: "home", ownerId: "participant_alpha", title: "AirPods Pro" });
    reserveWish(db, wish.id, "participant_beta");
    assert.equal(getWishForViewer(db, wish.id, "participant_alpha").reservedBy, null);
    assert.equal(getWishForViewer(db, wish.id, "participant_beta").reservedBy, "participant_beta");
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("dated action stays open until explicit completion", () => {
  const { db, dir } = fixture();
  try {
    const action = createAction(db, { householdId: "home", createdBy: "participant_beta", assigneeId: "participant_alpha", title: "Купить корм", dueAt: "2026-09-18" });
    assert.equal(getAction(db, action.id).status, "open");
    completeAction(db, action.id, "participant_alpha");
    assert.equal(getAction(db, action.id).status, "completed");
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("poll responses stay hidden until the viewer votes", () => {
  const { db, dir } = fixture();
  try {
    const poll = createPoll(db, { householdId: "home", createdBy: "participant_alpha", question: "Куда едем?", options: ["Казань", "Питер"], participants: ["participant_alpha", "participant_beta"] });
    votePoll(db, poll.id, "participant_alpha", 0);
    assert.equal(getPollForViewer(db, poll.id, "participant_beta").votes, null);
    assert.equal(getPollForViewer(db, poll.id, "participant_alpha").votes.length, 1);
    votePoll(db, poll.id, "participant_beta", 1);
    assert.equal(getPollForViewer(db, poll.id, "participant_beta").votes.length, 2);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("money goal can be linked to a lightweight plan", () => {
  const { db, dir } = fixture();
  try {
    const plan = createPlan(db, { householdId: "home", createdBy: "participant_alpha", title: "Турция", participants: ["participant_alpha", "participant_beta"] });
    const goal = createMoneyGoal(db, { householdId: "home", createdBy: "participant_alpha", title: "Турция", amount: 300000, currency: "RUB", dueAt: "2027-05-01" });
    linkEntityToPlan(db, plan.id, "money_goal", goal.id);
    const link = db.prepare("SELECT entity_type,entity_id FROM plan_links WHERE plan_id=?").get(plan.id);
    assert.equal(link.entity_type, "money_goal");
    assert.equal(link.entity_id, goal.id);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
