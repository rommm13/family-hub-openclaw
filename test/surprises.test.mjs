import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily, upsertMemberRoute } from "../dist/db.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-surprises-"));
  const assets = path.join(dir, "assets");
  fs.mkdirSync(assets);
  for (const name of Array.from({ length: 12 }, (_, i) => `img-${String(i + 1).padStart(2, "0")}.jpg`)) fs.writeFileSync(path.join(assets, name), name);
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [
      { id: "participant_alpha", name: "Иван", role: "parent" },
      { id: "participant_beta", name: "Мария", role: "parent" }
    ],
    bindings: [
      { runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" },
      { runtimeId: "agent_core", agentId: "agent_second", memberId: "participant_beta" }
    ]
  });
  return { dir, assets, db };
}
function cleanup(fx) {
  fx.db.close();
  fs.rmSync(fx.dir, { recursive: true, force: true });
}
function seq(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

test("manual surprise limit is synthetic/configurable: default 10 for both members; manualLimit null unlimited; unlimitedMemberIds exempts member-a only", async () => {
  const fx = fixture();
  try {
    const { selectManualSurprise } = await import("../dist/surprises.js");
    fx.db.prepare("INSERT INTO members(id,household_id,name,role) VALUES (?,?,?,?)").run("member-a", "home", "Member A", "member");
    fx.db.prepare("INSERT INTO members(id,household_id,name,role) VALUES (?,?,?,?)").run("member-b", "home", "Member B", "member");
    const t0 = Date.parse("2026-09-18T06:00:00Z");

    // default 10 limit applies consistently to both synthetic members
    for (const memberId of ["member-a", "member-b"]) {
      const fxm = fixture();
      try {
        const { selectManualSurprise: pick } = await import("../dist/surprises.js");
        fxm.db.prepare("INSERT INTO members(id,household_id,name,role) VALUES (?,?,?,?)").run(memberId, "home", memberId, "member");
        for (let i = 0; i < 10; i += 1) {
          const r = pick({ db: fxm.db, memberId, assetDir: fxm.assets, now: t0 + i, random: () => 0.2 });
          assert.equal(r.status, "asset", `${memberId} item ${i + 1}`);
          assert.equal(r.limit, 10);
        }
        const blocked = pick({ db: fxm.db, memberId, assetDir: fxm.assets, now: t0 + 20, random: () => 0.2 });
        assert.equal(blocked.status, "cooldown", `${memberId} 11th`);
        assert.equal(blocked.limit, 10);
      } finally {
        cleanup(fxm);
      }
    }

    // configured manualLimit:null gives unlimited for any ID
    for (const memberId of ["member-a", "member-b"]) {
      for (let i = 0; i < 12; i += 1) {
        const r = selectManualSurprise({
          db: fx.db, memberId, assetDir: fx.assets, now: t0 + i, random: () => 0.2, manualLimit: null
        });
        assert.equal(r.status, "asset", `${memberId} unlimited item ${i + 1}`);
        assert.equal(r.limit, null);
        assert.equal(r.cooldownUntil, null);
      }
    }

    // configured unlimitedMemberIds:['member-a'] exempts only that synthetic member
    const fx2 = fixture();
    try {
      const { selectManualSurprise: pick2 } = await import("../dist/surprises.js");
      fx2.db.prepare("INSERT INTO members(id,household_id,name,role) VALUES (?,?,?,?)").run("member-a", "home", "Member A", "member");
      fx2.db.prepare("INSERT INTO members(id,household_id,name,role) VALUES (?,?,?,?)").run("member-b", "home", "Member B", "member");
      for (let i = 0; i < 12; i += 1) {
        const a = pick2({
          db: fx2.db, memberId: "member-a", assetDir: fx2.assets, now: t0 + i, random: () => 0.2,
          unlimitedMemberIds: ["member-a"]
        });
        assert.equal(a.status, "asset", `member-a exempt item ${i + 1}`);
        assert.equal(a.limit, null);
      }
      for (let i = 0; i < 10; i += 1) {
        const b = pick2({
          db: fx2.db, memberId: "member-b", assetDir: fx2.assets, now: t0 + i, random: () => 0.2,
          unlimitedMemberIds: ["member-a"]
        });
        assert.equal(b.status, "asset", `member-b limited item ${i + 1}`);
        assert.equal(b.limit, 10);
      }
      const blockedB = pick2({
        db: fx2.db, memberId: "member-b", assetDir: fx2.assets, now: t0 + 20, random: () => 0.2,
        unlimitedMemberIds: ["member-a"]
      });
      assert.equal(blockedB.status, "cooldown");
      assert.equal(blockedB.limit, 10);
    } finally {
      cleanup(fx2);
    }
  } finally {
    cleanup(fx);
  }
});

test("assets do not repeat for a member until the current library cycle is exhausted", async () => {
  const fx = fixture();
  try {
    const { selectManualSurprise } = await import("../dist/surprises.js");
    let now = Date.parse("2026-09-18T00:00:00Z");
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      const result = selectManualSurprise({ db: fx.db, memberId: "participant_alpha", assetDir: fx.assets, now, random: () => 0 });
      seen.push(result.assetKey);
      now += 61 * 60 * 1000;
    }
    assert.equal(new Set(seen).size, 3);
    const next = selectManualSurprise({ db: fx.db, memberId: "participant_alpha", assetDir: fx.assets, now, random: () => 0 });
    assert.equal(next.status, "asset");
    assert.notEqual(next.assetKey, seen.at(-1));
  } finally {
    cleanup(fx);
  }
});

test("empty surprise library returns a neutral empty result", async () => {
  const fx = fixture();
  try {
    fs.rmSync(fx.assets, { recursive: true, force: true });
    fs.mkdirSync(fx.assets);
    const { selectManualSurprise } = await import("../dist/surprises.js");
    assert.deepEqual(
      selectManualSurprise({ db: fx.db, memberId: "participant_alpha", assetDir: fx.assets, now: 0, random: () => 0 }),
      { status: "empty" }
    );
  } finally {
    cleanup(fx);
  }
});

test("automatic delay distribution is irregular from one to seven days", async () => {
  const { nextAutomaticDelayDays } = await import("../dist/surprises.js");
  assert.equal(nextAutomaticDelayDays(() => 0.00), 1);
  assert.equal(nextAutomaticDelayDays(() => 0.19), 1);
  assert.equal(nextAutomaticDelayDays(() => 0.20), 2);
  assert.equal(nextAutomaticDelayDays(() => 0.64), 2);
  assert.equal(nextAutomaticDelayDays(() => 0.65), 3);
  assert.equal(nextAutomaticDelayDays(() => 0.89), 3);
  assert.equal(nextAutomaticDelayDays(seq([0.91, 0.1])), 4);
  assert.equal(nextAutomaticDelayDays(seq([0.91, 0.9])), 5);
  assert.equal(nextAutomaticDelayDays(seq([0.98, 0.1])), 6);
  assert.equal(nextAutomaticDelayDays(seq([0.98, 0.9])), 7);
});

test("automatic tick queues at most one image for a local day", async () => {
  const fx = fixture();
  try {
    const { runAutomaticSurpriseTick } = await import("../dist/surprises.js");
    upsertMemberRoute(fx.db, "participant_beta", {
      runtimeId: "agent_core", agentId: "agent_second", channel: "telegram", accountId: "agent_second", to: "telegram:100000002"
    });
    fx.db.prepare("INSERT OR REPLACE INTO surprise_member_state(member_id,cycle,manual_count,auto_next_at) VALUES (?,?,?,?)")
      .run("participant_beta", 1, 0, "2026-09-18T00:00:00.000Z");
    const now = Date.parse("2026-09-18T09:00:00Z"); // 12:00 Moscow
    const queued = runAutomaticSurpriseTick({
      db: fx.db, memberId: "participant_beta", runtimeId: "agent_core", agentId: "agent_second",
      assetDir: fx.assets, now, random: () => 0.5, timeZone: "Europe/Moscow"
    });
    assert.equal(queued.status, "queued");
    const row = fx.db.prepare("SELECT kind,payload_json AS payload,status FROM outbox WHERE id=?").get(queued.outboxId);
    assert.equal(row.kind, "surprise_media");
    assert.equal(row.status, "pending");
    assert.equal(JSON.parse(row.payload).agentId, "agent_second");

    fx.db.prepare("UPDATE surprise_member_state SET auto_next_at=? WHERE member_id=?")
      .run("2026-09-18T00:00:00.000Z", "participant_beta");
    const second = runAutomaticSurpriseTick({
      db: fx.db, memberId: "participant_beta", runtimeId: "agent_core", agentId: "agent_second",
      assetDir: fx.assets, now: now + 60 * 60 * 1000, random: () => 0.5, timeZone: "Europe/Moscow"
    });
    assert.equal(second.status, "daily_limited");
    assert.equal(
      fx.db.prepare("SELECT count(*) AS c FROM surprise_views WHERE member_id=? AND source='auto'").get("participant_beta").c,
      1
    );
  } finally {
    cleanup(fx);
  }
});

test("automatic tick never exceeds three sends in rolling seven days", async () => {
  const fx = fixture();
  try {
    const { runAutomaticSurpriseTick } = await import("../dist/surprises.js");
    upsertMemberRoute(fx.db, "participant_beta", {
      runtimeId: "agent_core", agentId: "agent_second", channel: "telegram", accountId: "agent_second", to: "telegram:100000002"
    });
    const now = Date.parse("2026-09-18T09:00:00Z");
    fx.db.prepare("INSERT OR REPLACE INTO surprise_member_state(member_id,cycle,manual_count,auto_next_at) VALUES (?,?,?,?)")
      .run("participant_beta", 1, 0, "2026-09-18T00:00:00.000Z");
    const insert = fx.db.prepare("INSERT INTO surprise_views(member_id,asset_key,cycle,source,shown_at) VALUES (?,?,?,?,?)");
    insert.run("participant_beta", "old1.jpg", 1, "auto", new Date(now - 6 * 86400000).toISOString());
    insert.run("participant_beta", "old2.jpg", 1, "auto", new Date(now - 4 * 86400000).toISOString());
    insert.run("participant_beta", "old3.jpg", 1, "auto", new Date(now - 2 * 86400000).toISOString());
    const result = runAutomaticSurpriseTick({
      db: fx.db, memberId: "participant_beta", runtimeId: "agent_core", agentId: "agent_second",
      assetDir: fx.assets, now, random: () => 0.5, timeZone: "Europe/Moscow"
    });
    assert.equal(result.status, "weekly_limited");
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM outbox").get().c, 0);
  } finally {
    cleanup(fx);
  }
});

test("automatic tick respects the 09:30–20:30 Moscow window", async () => {
  const fx = fixture();
  try {
    const { runAutomaticSurpriseTick } = await import("../dist/surprises.js");
    upsertMemberRoute(fx.db, "participant_beta", {
      runtimeId: "agent_core", agentId: "agent_second", channel: "telegram", accountId: "agent_second", to: "telegram:100000002"
    });
    fx.db.prepare("INSERT OR REPLACE INTO surprise_member_state(member_id,cycle,manual_count,auto_next_at) VALUES (?,?,?,?)")
      .run("participant_beta", 1, 0, "2026-09-18T00:00:00.000Z");
    const early = runAutomaticSurpriseTick({
      db: fx.db, memberId: "participant_beta", runtimeId: "agent_core", agentId: "agent_second",
      assetDir: fx.assets, now: Date.parse("2026-09-18T05:00:00Z"), random: () => 0.5, timeZone: "Europe/Moscow"
    });
    assert.equal(early.status, "quiet_hours");
    assert.equal(new Date(early.nextEligibleAt).toISOString(), "2026-09-18T06:30:00.000Z");
  } finally {
    cleanup(fx);
  }
});

test("configured unlimited surprise button keeps offering the next queued image", async () => {
  const fx = fixture();
  try {
    const { createFamilyRuntime } = await import("../dist/index.js");
    const sent = [];
    const edits = [];
    const runtime = createFamilyRuntime({
      db: fx.db, runtimeId: "agent_core", agentId: "main",
      now: () => Date.parse("2026-09-18T06:00:00Z"),
      surpriseAssetDir: fx.assets, surpriseManualLimit: null, random: () => 0,
      sendSurpriseMedia: async input => { sent.push(input); return { ok: true }; }
    });
    const click = async () => {
      edits.length = 0;
      await runtime.interactive.handler({
        sessionKey: "agent:main:telegram:direct:123",
        auth: { isAuthorizedSender: true },
        callback: { payload: "surprise" },
        respond: { async editMessage(v) { edits.push(v); }, async reply() {} }
      });
      return edits.at(-1);
    };
    for (let i = 0; i < 12; i += 1) {
      const view = await click();
      assert.equal(sent.length, i + 1);
      assert.match(view.text, /без ограничений/i);
      assert(view.buttons.flat().some(button => button.callback_data === "family:surprise"));
    }
    assert.equal(new Set(sent.map(item => path.basename(item.filePath))).size, 12);
  } finally {
    cleanup(fx);
  }
});

test("normal Agent Beta replies no longer drive automatic surprises", async () => {
  const fx = fixture();
  try {
    const { createFamilyRuntime } = await import("../dist/index.js");
    const runtime = createFamilyRuntime({
      db: fx.db, runtimeId: "agent_core", agentId: "main",
      now: () => Date.parse("2026-09-18T09:00:00Z"), surpriseAssetDir: fx.assets
    });
    const result = await runtime.replyPayloadSending({
      channel: "telegram",
      sessionKey: "agent:agent_second:telegram:direct:456",
      payload: { text: "Обычный ответ" }
    });
    assert.equal(result, undefined);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM surprise_views WHERE source='auto'").get().c, 0);
  } finally {
    cleanup(fx);
  }
});

test("failed manual surprise delivery does not consume the hourly quota", async () => {
  const fx = fixture();
  try {
    const { createFamilyRuntime } = await import("../dist/index.js");
    const edits = [];
    const runtime = createFamilyRuntime({
      db: fx.db, runtimeId: "agent_core", agentId: "main", surpriseAssetDir: fx.assets, random: () => 0,
      now: () => Date.parse("2026-09-18T06:00:00Z"),
      sendSurpriseMedia: async () => { throw new Error("send failed"); }
    });
    await runtime.interactive.handler({
      sessionKey: "agent:main:telegram:direct:123",
      auth: { isAuthorizedSender: true },
      callback: { payload: "surprise" },
      respond: { async editMessage(v) { edits.push(v); }, async reply() {} }
    });
    assert.match(edits.at(-1).text, /просмотр не засчитан/i);
    const state = fx.db.prepare("SELECT manual_count AS count FROM surprise_member_state WHERE member_id=?").get("participant_alpha");
    assert.equal(state.count, 0);
    assert.equal(
      fx.db.prepare("SELECT count(*) AS c FROM surprise_views WHERE member_id=? AND source='manual'").get("participant_alpha").c,
      0
    );
  } finally {
    cleanup(fx);
  }
});

test("interactive callback hydrates Telegram route from direct session key", async () => {
  const fx = fixture();
  try {
    const { createFamilyRuntime } = await import("../dist/index.js");
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    await runtime.interactive.handler({
      sessionKey: "agent:main:telegram:direct:777",
      auth: { isAuthorizedSender: true },
      callback: { payload: "more" },
      respond: { async editMessage() {}, async reply() {} }
    });
    const route = fx.db.prepare(
      "SELECT runtime_id AS runtimeId,agent_id AS agentId,account_id AS accountId,target FROM member_routes WHERE member_id=?"
    ).get("participant_alpha");
    assert.deepEqual({ ...route }, {
      runtimeId: "agent_core", agentId: "main", accountId: "default", target: "telegram:777"
    });
  } finally {
    cleanup(fx);
  }
});



test("manual and scheduled automatic delivery share one Maria queue with no repeats", async () => {
  const fx = fixture();
  try {
    const { selectManualSurprise, runScheduledAutomaticSurprise } = await import("../dist/surprises.js");
    upsertMemberRoute(fx.db, "participant_beta", {
      runtimeId: "agent_core", agentId: "agent_second", channel: "telegram", accountId: "agent_second", to: "telegram:100000002"
    });
    const t0 = Date.parse("2026-09-18T09:00:00Z");
    const manual = [];
    for (let i = 0; i < 5; i += 1) {
      manual.push(selectManualSurprise({
        db: fx.db, memberId: "participant_beta", assetDir: fx.assets, now: t0 + i * 1000, random: () => 0.42
      }).assetKey);
    }
    const automatic = runScheduledAutomaticSurprise({
      db: fx.db,
      eventId: "shared-queue-auto",
      scheduledAt: "2026-09-19T15:00:00+03:00",
      memberId: "participant_beta",
      runtimeId: "agent_core",
      agentId: "agent_second",
      assetDir: fx.assets,
      now: Date.parse("2026-09-19T12:00:00Z"),
      random: () => 0.42,
      timeZone: "Europe/Moscow"
    });
    assert.equal(automatic.status, "queued");
    assert.equal(manual.includes(automatic.assetKey), false);
    const history = fx.db.prepare(
      "SELECT asset_key AS assetKey,source FROM surprise_views WHERE member_id=? ORDER BY id"
    ).all("participant_beta");
    assert.equal(history.length, 6);
    assert.deepEqual(history.map(row => row.source), ["manual","manual","manual","manual","manual","auto"]);
    assert.equal(new Set(history.map(row => row.assetKey)).size, 6);
  } finally {
    cleanup(fx);
  }
});

test("newly added images enter the unseen queue before any old image can repeat", async () => {
  const fx = fixture();
  try {
    const { selectManualSurprise, syncSurpriseLibrary } = await import("../dist/surprises.js");
    for (const name of fs.readdirSync(fx.assets)) {
      if (!["img-01.jpg", "img-02.jpg"].includes(name)) fs.rmSync(path.join(fx.assets, name));
    }
    const t0 = Date.parse("2026-09-18T09:00:00Z");
    const first = selectManualSurprise({
      db: fx.db, memberId: "participant_beta", assetDir: fx.assets, now: t0, random: () => 0.5
    });
    const second = selectManualSurprise({
      db: fx.db, memberId: "participant_beta", assetDir: fx.assets, now: t0 + 1000, random: () => 0.5
    });
    assert.notEqual(first.assetKey, second.assetKey);

    fs.writeFileSync(path.join(fx.assets, "img-new.jpg"), "brand-new-content");
    const sync = syncSurpriseLibrary(fx.db, fx.assets, { memberIds: ["participant_beta"], random: () => 0.5 });
    assert.equal(sync.activeAssets, 3);
    assert.equal(sync.addedAssets, 1);

    const third = selectManualSurprise({
      db: fx.db, memberId: "participant_beta", assetDir: fx.assets, now: t0 + 2000, random: () => 0.5
    });
    assert.equal(third.assetKey, "img-new.jpg");
  } finally {
    cleanup(fx);
  }
});

test("queue history explicitly records seen count, last source and tail movement", async () => {
  const fx = fixture();
  try {
    const { selectManualSurprise, surpriseQueueStatus } = await import("../dist/surprises.js");
    const t0 = Date.parse("2026-09-18T09:00:00Z");
    const item = selectManualSurprise({
      db: fx.db, memberId: "participant_beta", assetDir: fx.assets, now: t0, random: () => 0.25
    });
    const row = fx.db.prepare(
      "SELECT seen_count AS seenCount,last_seen_at AS lastSeenAt,last_source AS lastSource,queue_pos AS queuePos FROM surprise_member_queue WHERE member_id=? AND asset_key=?"
    ).get("participant_beta", item.assetKey);
    const maxPos = fx.db.prepare(
      "SELECT max(queue_pos) AS maxPos FROM surprise_member_queue WHERE member_id=?"
    ).get("participant_beta").maxPos;
    assert.equal(row.seenCount, 1);
    assert.equal(row.lastSource, "manual");
    assert(row.lastSeenAt);
    assert.equal(row.queuePos, maxPos);
    const status = surpriseQueueStatus(fx.db, "participant_beta");
    assert.equal(status.unseen, 11);
  } finally {
    cleanup(fx);
  }
});
