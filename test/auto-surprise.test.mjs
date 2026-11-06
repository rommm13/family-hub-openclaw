import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily, upsertMemberRoute } from "../dist/db.js";
import { maybeRunConfiguredAutoSurprise, resolveAutoSurpriseAgentId } from "../dist/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-auto-"));
  const assets = path.join(dir, "assets");
  fs.mkdirSync(assets);
  for (const name of Array.from({ length: 8 }, (_, i) => `card-${String(i + 1).padStart(2, "0")}.jpg`)) {
    fs.writeFileSync(path.join(assets, name), name);
  }
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Test Household" },
    members: [
      { id: "member_sender", name: "Sender", role: "parent" },
      { id: "member_recipient", name: "Recipient", role: "parent" }
    ],
    bindings: [
      { runtimeId: "agent_core", agentId: "main", memberId: "member_sender" },
      { runtimeId: "agent_core", agentId: "agent_second", memberId: "member_recipient" }
    ]
  });
  upsertMemberRoute(db, "member_recipient", {
    runtimeId: "agent_core", agentId: "agent_second", channel: "telegram",
    accountId: "agent_second", to: "telegram:200000002"
  });
  return { dir, assets, db };
}

function cleanup(fx) {
  fx.db.close();
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

test("disabled without configured recipient; unknown member is reported", async () => {
  const fx = fixture();
  try {
    assert.equal(maybeRunConfiguredAutoSurprise({
      db: fx.db, runtimeId: "agent_core", memberId: null, assetDir: fx.assets, now: 0
    }).status, "disabled");
    assert.equal(maybeRunConfiguredAutoSurprise({
      db: fx.db, runtimeId: "agent_core", memberId: "member_ghost", assetDir: fx.assets, now: 0
    }).status, "unknown_member");
  } finally {
    cleanup(fx);
  }
});

test("bootstrap first run only schedules; due tick queues once; repeat is daily-limited (restart-safe, no double send)", async () => {
  const fx = fixture();
  try {
    const first = maybeRunConfiguredAutoSurprise({
      db: fx.db, runtimeId: "agent_core", memberId: "member_recipient",
      assetDir: fx.assets, now: Date.parse("2026-09-18T09:00:00Z"),
      random: () => 0.5, timeZone: "Europe/Moscow"
    });
    assert.equal(first.status, "scheduled");
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM outbox").get().c, 0);

    const dueAt = Number(first.nextEligibleAt);
    const queued = maybeRunConfiguredAutoSurprise({
      db: fx.db, runtimeId: "agent_core", memberId: "member_recipient",
      assetDir: fx.assets, now: dueAt, random: () => 0.5, timeZone: "Europe/Moscow"
    });
    assert.equal(queued.status, "queued");
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM outbox").get().c, 1);

    // повторный tick в тот же локальный день + "рестарт" (снова due) — без второй отправки
    for (const extra of [dueAt + 60_000, dueAt + 3_600_000]) {
      fx.db.prepare("UPDATE surprise_member_state SET auto_next_at=? WHERE member_id=?")
        .run(new Date(dueAt).toISOString(), "member_recipient");
      const again = maybeRunConfiguredAutoSurprise({
        db: fx.db, runtimeId: "agent_core", memberId: "member_recipient",
        assetDir: fx.assets, now: extra, random: () => 0.5, timeZone: "Europe/Moscow"
      });
      assert.equal(again.status, "daily_limited");
    }
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM outbox").get().c, 1);
    assert.equal(
      fx.db.prepare("SELECT count(*) AS c FROM surprise_views WHERE member_id=? AND source='auto'").get("member_recipient").c,
      1
    );
  } finally {
    cleanup(fx);
  }
});

test("missing telegram route and empty library skip with diagnostic, nothing queued", async () => {
  const fx = fixture();
  try {
    fx.db.prepare("DELETE FROM member_routes WHERE member_id=?").run("member_recipient");
    fx.db.prepare("INSERT OR REPLACE INTO surprise_member_state(member_id,cycle,manual_count,auto_next_at) VALUES (?,?,?,?)")
      .run("member_recipient", 1, 0, "2026-09-18T00:00:00.000Z");
    const noRoute = maybeRunConfiguredAutoSurprise({
      db: fx.db, runtimeId: "agent_core", memberId: "member_recipient",
      assetDir: fx.assets, now: Date.parse("2026-09-18T09:00:00Z"),
      random: () => 0.5, timeZone: "Europe/Moscow"
    });
    assert.equal(noRoute.status, "no_route");
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM outbox").get().c, 0);

    upsertMemberRoute(fx.db, "member_recipient", {
      runtimeId: "agent_core", agentId: "agent_second", channel: "telegram",
      accountId: "agent_second", to: "telegram:200000002"
    });
    const emptyDir = path.join(fx.dir, "empty-assets");
    fs.mkdirSync(emptyDir);
    const empty = maybeRunConfiguredAutoSurprise({
      db: fx.db, runtimeId: "agent_core", memberId: "member_recipient",
      assetDir: emptyDir, now: Date.parse("2026-09-18T09:00:00Z"),
      random: () => 0.5, timeZone: "Europe/Moscow"
    });
    assert.equal(empty.status, "empty");
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM outbox").get().c, 0);
  } finally {
    cleanup(fx);
  }
});

test("two households are isolated: auto tick touches only the configured recipient", async () => {
  const fx = fixture();
  try {
    fx.db.prepare("INSERT INTO households(id,name) VALUES (?,?)").run("away", "Other Household");
    fx.db.prepare("INSERT INTO members(id,household_id,name,role) VALUES (?,?,?,?)")
      .run("member_other", "away", "Other", "parent");
    fx.db.prepare("INSERT INTO agent_bindings(runtime_id,agent_id,member_id) VALUES (?,?,?)")
      .run("agent_core", "agent_other", "member_other");
    upsertMemberRoute(fx.db, "member_other", {
      runtimeId: "agent_core", agentId: "agent_other", channel: "telegram",
      accountId: "agent_other", to: "telegram:300000003"
    });
    fx.db.prepare("INSERT OR REPLACE INTO surprise_member_state(member_id,cycle,manual_count,auto_next_at) VALUES (?,?,?,?)")
      .run("member_recipient", 1, 0, "2026-09-18T00:00:00.000Z");
    const result = maybeRunConfiguredAutoSurprise({
      db: fx.db, runtimeId: "agent_core", memberId: "member_recipient",
      assetDir: fx.assets, now: Date.parse("2026-09-18T09:00:00Z"),
      random: () => 0.5, timeZone: "Europe/Moscow"
    });
    assert.equal(result.status, "queued");
    assert.equal(
      fx.db.prepare("SELECT recipient_member_id AS m FROM outbox").all().map(r => r.m).join(","),
      "member_recipient"
    );
    assert.equal(
      fx.db.prepare("SELECT count(*) AS c FROM surprise_views WHERE member_id=?").get("member_other").c,
      0
    );
  } finally {
    cleanup(fx);
  }
});

test("recipient agent is resolved from bindings, not from caller default", async () => {
  const fx = fixture();
  try {
    assert.equal(
      resolveAutoSurpriseAgentId(fx.db, "member_recipient", "agent_core", ["main"]),
      "agent_second"
    );
    assert.equal(resolveAutoSurpriseAgentId(fx.db, "member_ghost", "agent_core", ["main"]), "main");
    assert.equal(resolveAutoSurpriseAgentId(fx.db, "member_ghost", "agent_core", []), null);
  } finally {
    cleanup(fx);
  }
});
