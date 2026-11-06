import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { enqueueOutbox, getMemberRoute } from "./db.js";

const EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function asMs(value) {
  const n = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(n)) throw new Error("Invalid surprise time");
  return n;
}

function asIso(ms) {
  return new Date(ms).toISOString();
}

function unit(random) {
  const raw = Number(random());
  return Number.isFinite(raw) ? Math.max(0, Math.min(0.999999999, raw)) : 0;
}

function shuffle(values, random) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(unit(random) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

export function listSurpriseAssets(assetDir) {
  try {
    return fs.readdirSync(assetDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function requireMember(db, memberId) {
  const row = db.prepare("SELECT id FROM members WHERE id=?").get(memberId);
  if (!row) throw new Error("Family member not found");
  return row;
}

function ensureState(db, memberId) {
  db.prepare("INSERT OR IGNORE INTO surprise_member_state(member_id) VALUES (?)").run(memberId);
  return db.prepare(`SELECT member_id AS memberId,cycle,manual_window_started_at AS manualWindowStartedAt,
    manual_count AS manualCount,auto_next_at AS autoNextAt
    FROM surprise_member_state WHERE member_id=?`).get(memberId);
}

function historyForAsset(db, memberId, assetKey) {
  const summary = db.prepare(`SELECT count(*) AS seenCount,max(shown_at) AS lastSeenAt
    FROM surprise_views WHERE member_id=? AND asset_key=?`).get(memberId, assetKey);
  const last = db.prepare(`SELECT source FROM surprise_views
    WHERE member_id=? AND asset_key=? ORDER BY id DESC LIMIT 1`).get(memberId, assetKey);
  return {
    seenCount: Number(summary?.seenCount ?? 0),
    lastSeenAt: summary?.lastSeenAt ?? null,
    lastSource: last?.source ?? null
  };
}

export function syncSurpriseLibrary(db, assetDir, { memberIds = null, random = Math.random } = {}) {
  const names = listSurpriseAssets(assetDir);
  const present = new Set(names);
  const existing = new Map(
    db.prepare(`SELECT asset_key AS assetKey,checksum,file_size AS fileSize,mtime_ms AS mtimeMs,active
      FROM surprise_assets`).all().map(row => [row.assetKey, row])
  );

  const scanned = [];
  for (const assetKey of names) {
    const filePath = path.join(assetDir, assetKey);
    const stat = fs.statSync(filePath);
    const fileSize = Number(stat.size);
    const mtimeMs = Math.round(Number(stat.mtimeMs));
    const old = existing.get(assetKey);
    const unchanged = old && Number(old.fileSize) === fileSize && Number(old.mtimeMs) === mtimeMs;
    scanned.push({
      assetKey,
      fileSize,
      mtimeMs,
      checksum: unchanged ? old.checksum : hashFile(filePath),
      changed: Boolean(old && !unchanged)
    });
  }

  const members = memberIds?.length
    ? [...new Set(memberIds.map(String))]
    : db.prepare("SELECT id FROM members ORDER BY id").all().map(row => row.id);

  let addedAssets = 0;
  let duplicateFiles = 0;
  let queueAdded = 0;
  const changedKeys = new Set();

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [assetKey] of existing) {
      if (!present.has(assetKey)) {
        db.prepare("UPDATE surprise_assets SET active=0,updated_at=CURRENT_TIMESTAMP WHERE asset_key=?").run(assetKey);
      }
    }

    for (const item of scanned) {
      const owner = db.prepare("SELECT asset_key AS assetKey FROM surprise_assets WHERE checksum=? AND asset_key<>?")
        .get(item.checksum, item.assetKey);
      if (owner) {
        duplicateFiles += 1;
        if (existing.has(item.assetKey)) {
          db.prepare(`UPDATE surprise_assets SET active=0,file_size=?,mtime_ms=?,updated_at=CURRENT_TIMESTAMP
            WHERE asset_key=?`).run(item.fileSize, item.mtimeMs, item.assetKey);
        }
        continue;
      }

      if (existing.has(item.assetKey)) {
        db.prepare(`UPDATE surprise_assets SET checksum=?,file_size=?,mtime_ms=?,active=1,updated_at=CURRENT_TIMESTAMP
          WHERE asset_key=?`).run(item.checksum, item.fileSize, item.mtimeMs, item.assetKey);
        if (item.changed) changedKeys.add(item.assetKey);
      } else {
        db.prepare(`INSERT INTO surprise_assets(asset_key,checksum,file_size,mtime_ms,active)
          VALUES (?,?,?,?,1)`).run(item.assetKey, item.checksum, item.fileSize, item.mtimeMs);
        addedAssets += 1;
      }
    }

    for (const memberId of members) {
      requireMember(db, memberId);
      const queued = new Set(
        db.prepare("SELECT asset_key AS assetKey FROM surprise_member_queue WHERE member_id=?")
          .all(memberId).map(row => row.assetKey)
      );
      let maxPos = Number(
        db.prepare("SELECT COALESCE(MAX(queue_pos),0) AS value FROM surprise_member_queue WHERE member_id=?")
          .get(memberId)?.value ?? 0
      );

      const activeKeys = db.prepare("SELECT asset_key AS assetKey FROM surprise_assets WHERE active=1 ORDER BY asset_key")
        .all().map(row => row.assetKey);
      const freshKeys = shuffle(activeKeys.filter(assetKey => !queued.has(assetKey)), random);

      for (const assetKey of freshKeys) {
        const history = historyForAsset(db, memberId, assetKey);
        maxPos += 1;
        db.prepare(`INSERT INTO surprise_member_queue(
          member_id,asset_key,queue_pos,seen_count,last_seen_at,last_source
        ) VALUES (?,?,?,?,?,?)`).run(
          memberId, assetKey, maxPos, history.seenCount, history.lastSeenAt, history.lastSource
        );
        queueAdded += 1;
      }

      for (const assetKey of changedKeys) {
        if (!queued.has(assetKey)) continue;
        maxPos += 1;
        db.prepare(`UPDATE surprise_member_queue
          SET seen_count=0,queue_pos=?,last_seen_at=NULL,last_source=NULL
          WHERE member_id=? AND asset_key=?`).run(maxPos, memberId, assetKey);
      }
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const activeAssets = Number(db.prepare("SELECT count(*) AS c FROM surprise_assets WHERE active=1").get()?.c ?? 0);
  return {
    files: names.length,
    activeAssets,
    addedAssets,
    duplicateFiles,
    queueAdded,
    members: members.length
  };
}

function nextQueueRow(db, memberId) {
  return db.prepare(`SELECT q.asset_key AS assetKey,q.seen_count AS seenCount,q.queue_pos AS queuePos
    FROM surprise_member_queue q
    JOIN surprise_assets a ON a.asset_key=q.asset_key
    WHERE q.member_id=? AND a.active=1
    ORDER BY q.seen_count ASC,q.queue_pos ASC
    LIMIT 1`).get(memberId);
}

function recordView(db, { memberId, assetKey, cycle, source, shownAt }) {
  const result = db.prepare(`INSERT INTO surprise_views(member_id,asset_key,cycle,source,shown_at)
    VALUES (?,?,?,?,?)`).run(memberId, assetKey, cycle, source, asIso(shownAt));
  return Number(result.lastInsertRowid);
}

function consumeQueueRow(db, { memberId, source, shownAt }) {
  const row = nextQueueRow(db, memberId);
  if (!row) return null;
  const maxPos = Number(
    db.prepare("SELECT COALESCE(MAX(queue_pos),0) AS value FROM surprise_member_queue WHERE member_id=?")
      .get(memberId)?.value ?? 0
  );
  const cycle = Number(row.seenCount) + 1;
  db.prepare(`UPDATE surprise_member_queue
    SET seen_count=?,queue_pos=?,last_seen_at=?,last_source=?
    WHERE member_id=? AND asset_key=?`).run(
    cycle, maxPos + 1, asIso(shownAt), source, memberId, row.assetKey
  );
  const viewId = recordView(db, {
    memberId,
    assetKey: row.assetKey,
    cycle,
    source,
    shownAt
  });
  return { assetKey: row.assetKey, cycle, viewId };
}

function normalizeManualLimit(value) {
  if (value === null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 10;
}

function normalizeUnlimitedMemberIds(value) {
  return Array.isArray(value) ? value.filter(v => typeof v === "string") : [];
}

export function manualSurpriseLimit(memberId, { manualLimit = 10, unlimitedMemberIds = [] } = {}) {
  const unlimited = normalizeUnlimitedMemberIds(unlimitedMemberIds);
  if (unlimited.includes(String(memberId))) return null;
  return normalizeManualLimit(manualLimit);
}

export function selectManualSurprise({
  db, memberId, assetDir, now = Date.now(), random = Math.random,
  manualLimit = 10, unlimitedMemberIds = []
}) {
  const sync = syncSurpriseLibrary(db, assetDir, { memberIds: [memberId], random });
  if (!sync.activeAssets) return { status: "empty" };

  const stamp = asMs(now);
  requireMember(db, memberId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const state = ensureState(db, memberId);
    const limit = manualSurpriseLimit(memberId, { manualLimit, unlimitedMemberIds });
    const limited = Number.isFinite(limit);
    let windowStart = state.manualWindowStartedAt ? Date.parse(state.manualWindowStartedAt) : stamp;
    let count = Number(state.manualCount) || 0;

    if (limited) {
      if (!Number.isFinite(windowStart) || stamp - windowStart >= HOUR_MS || stamp < windowStart) {
        windowStart = stamp;
        count = 0;
      }
      if (count >= limit) {
        db.exec("COMMIT");
        return { status: "cooldown", cooldownUntil: windowStart + HOUR_MS, limit, used: count };
      }
    } else {
      windowStart = null;
      count = 0;
    }

    const chosen = consumeQueueRow(db, { memberId, source: "manual", shownAt: stamp });
    if (!chosen) {
      db.exec("COMMIT");
      return { status: "empty" };
    }

    if (limited) count += 1;
    db.prepare(`UPDATE surprise_member_state
      SET cycle=?,manual_window_started_at=?,manual_count=?,updated_at=CURRENT_TIMESTAMP
      WHERE member_id=?`).run(
      chosen.cycle,
      limited ? asIso(windowStart) : null,
      limited ? count : 0,
      memberId
    );
    db.exec("COMMIT");

    return {
      status: "asset",
      viewId: chosen.viewId,
      assetKey: chosen.assetKey,
      filePath: path.join(assetDir, chosen.assetKey),
      used: limited ? count : null,
      limit,
      remaining: limited ? Math.max(0, limit - count) : null,
      cooldownUntil: limited && count >= limit ? windowStart + HOUR_MS : null,
      shownAt: stamp
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function localParts(ms, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
}

function localMinuteOfDay(ms, timeZone) {
  const parts = localParts(ms, timeZone);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function localDateKey(ms, timeZone) {
  const parts = localParts(ms, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayThreshold(stamp, days, timeZone) {
  const candidate = stamp + days * DAY_MS;
  const minute = localMinuteOfDay(candidate, timeZone);
  return candidate + ((9 * 60 + 30) - minute) * 60_000;
}

export function nextAutomaticDelayDays(random = Math.random) {
  const bucket = unit(random);
  if (bucket < 0.20) return 1;
  if (bucket < 0.65) return 2;
  if (bucket < 0.90) return 3;
  if (bucket < 0.97) return unit(random) < 0.5 ? 4 : 5;
  return unit(random) < 0.5 ? 6 : 7;
}

function nextAutomaticAt(stamp, random, timeZone) {
  return dayThreshold(stamp, nextAutomaticDelayDays(random), timeZone);
}

export function selectAutomaticSurprise({
  db, memberId, assetDir, now = Date.now(), random = Math.random, timeZone = "Europe/Moscow"
}) {
  const sync = syncSurpriseLibrary(db, assetDir, { memberIds: [memberId], random });
  if (!sync.activeAssets) return { status: "empty" };

  const stamp = asMs(now);
  requireMember(db, memberId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const state = ensureState(db, memberId);
    const due = state.autoNextAt ? Date.parse(state.autoNextAt) : null;
    if (!Number.isFinite(due)) {
      const nextEligibleAt = nextAutomaticAt(stamp, random, timeZone);
      db.prepare("UPDATE surprise_member_state SET auto_next_at=?,updated_at=CURRENT_TIMESTAMP WHERE member_id=?")
        .run(asIso(nextEligibleAt), memberId);
      db.exec("COMMIT");
      return { status: "not_due", nextEligibleAt };
    }
    if (stamp < due) {
      db.exec("COMMIT");
      return { status: "not_due", nextEligibleAt: due };
    }
    const minute = localMinuteOfDay(stamp, timeZone);
    if (minute < 9 * 60 + 30 || minute > 20 * 60 + 30) {
      const nextEligibleAt = dayThreshold(stamp, minute < 9 * 60 + 30 ? 0 : 1, timeZone);
      db.prepare("UPDATE surprise_member_state SET auto_next_at=?,updated_at=CURRENT_TIMESTAMP WHERE member_id=?")
        .run(asIso(nextEligibleAt), memberId);
      db.exec("COMMIT");
      return { status: "not_due", nextEligibleAt };
    }

    const chosen = consumeQueueRow(db, { memberId, source: "auto", shownAt: stamp });
    const nextEligibleAt = nextAutomaticAt(stamp, random, timeZone);
    db.prepare("UPDATE surprise_member_state SET cycle=?,auto_next_at=?,updated_at=CURRENT_TIMESTAMP WHERE member_id=?")
      .run(chosen.cycle, asIso(nextEligibleAt), memberId);
    db.exec("COMMIT");
    return {
      status: "asset",
      ...chosen,
      filePath: path.join(assetDir, chosen.assetKey),
      shownAt: stamp,
      nextEligibleAt
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function runAutomaticSurpriseTick({
  db,
  memberId,
  runtimeId,
  agentId,
  assetDir,
  now = Date.now(),
  random = Math.random,
  timeZone = "Europe/Moscow"
}) {
  const stamp = asMs(now);
  const state = ensureState(db, memberId);
  const due = state.autoNextAt ? Date.parse(state.autoNextAt) : null;
  if (!Number.isFinite(due)) {
    const nextEligibleAt = nextAutomaticAt(stamp, random, timeZone);
    db.prepare("UPDATE surprise_member_state SET auto_next_at=?,updated_at=CURRENT_TIMESTAMP WHERE member_id=?")
      .run(asIso(nextEligibleAt), memberId);
    return { status: "scheduled", nextEligibleAt };
  }
  if (stamp < due) return { status: "not_due", nextEligibleAt: due };
  const minute = localMinuteOfDay(stamp, timeZone);
  if (minute < 9 * 60 + 30 || minute > 20 * 60 + 30) {
    const nextEligibleAt = dayThreshold(stamp, minute < 9 * 60 + 30 ? 0 : 1, timeZone);
    db.prepare("UPDATE surprise_member_state SET auto_next_at=?,updated_at=CURRENT_TIMESTAMP WHERE member_id=?")
      .run(asIso(nextEligibleAt), memberId);
    return { status: "quiet_hours", nextEligibleAt };
  }
  return runScheduledAutomaticSurprise({
    db,
    eventId: `legacy-${asIso(stamp)}`,
    scheduledAt: asIso(stamp),
    memberId,
    runtimeId,
    agentId,
    assetDir,
    now: stamp,
    random,
    timeZone
  });
}

export function stageSurpriseAsset(filePath, mediaDir) {
  const source = path.resolve(String(filePath));
  const targetDir = path.resolve(String(mediaDir));
  fs.mkdirSync(targetDir, { recursive: true });
  const name = path.basename(source);
  const target = path.join(targetDir, name);
  const sourceStat = fs.statSync(source);
  let copy = true;
  try {
    const targetStat = fs.statSync(target);
    copy = targetStat.size !== sourceStat.size || targetStat.mtimeMs < sourceStat.mtimeMs;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (copy) fs.copyFileSync(source, target);
  return target;
}

export function releaseManualSurprise({ db, memberId, viewId }) {
  const id = Number(viewId);
  if (!Number.isInteger(id) || id < 1) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`SELECT id,asset_key AS assetKey FROM surprise_views
      WHERE id=? AND member_id=? AND source='manual'`).get(id, memberId);
    if (!row) {
      db.exec("COMMIT");
      return false;
    }

    db.prepare("DELETE FROM surprise_views WHERE id=?").run(id);
    const history = historyForAsset(db, memberId, row.assetKey);
    const minPos = Number(
      db.prepare("SELECT COALESCE(MIN(queue_pos),0) AS value FROM surprise_member_queue WHERE member_id=?")
        .get(memberId)?.value ?? 0
    );
    db.prepare(`UPDATE surprise_member_queue
      SET seen_count=?,queue_pos=?,last_seen_at=?,last_source=?
      WHERE member_id=? AND asset_key=?`).run(
      history.seenCount,
      minPos - 1,
      history.lastSeenAt,
      history.lastSource,
      memberId,
      row.assetKey
    );
    db.prepare(`UPDATE surprise_member_state
      SET manual_count=CASE WHEN manual_count>0 THEN manual_count-1 ELSE 0 END,
          manual_window_started_at=CASE WHEN manual_count<=1 THEN NULL ELSE manual_window_started_at END,
          updated_at=CURRENT_TIMESTAMP
      WHERE member_id=?`).run(memberId);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function runScheduledAutomaticSurprise({
  db,
  eventId,
  scheduledAt,
  memberId,
  runtimeId,
  agentId,
  assetDir,
  now = Date.now(),
  random = Math.random,
  timeZone = "Europe/Moscow"
}) {
  const sync = syncSurpriseLibrary(db, assetDir, { memberIds: [memberId], random });
  if (!sync.activeAssets) return { status: "empty" };

  const stamp = asMs(now);
  const scheduledMs = asMs(scheduledAt);
  requireMember(db, memberId);
  const scheduledMinute = localMinuteOfDay(scheduledMs, timeZone);
  if (scheduledMinute < 9 * 60 + 30 || scheduledMinute > 20 * 60 + 30) {
    return { status: "invalid_schedule" };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const dedupeKey = "surprise:auto:event:" + String(eventId);
    const existing = db.prepare("SELECT id,status FROM outbox WHERE dedupe_key=?").get(dedupeKey);
    if (existing) {
      db.exec("COMMIT");
      return { status: "duplicate", outboxId: existing.id, outboxStatus: existing.status };
    }

    const route = getMemberRoute(db, memberId, { runtimeId, agentId });
    if (!route) {
      db.exec("COMMIT");
      return { status: "no_route" };
    }

    const recent = db.prepare(`SELECT shown_at AS shownAt FROM surprise_views
      WHERE member_id=? AND source='auto' AND shown_at>=? ORDER BY shown_at`)
      .all(memberId, asIso(stamp - 7 * DAY_MS));
    const today = localDateKey(stamp, timeZone);
    if (recent.some(row => localDateKey(Date.parse(row.shownAt), timeZone) === today)) {
      db.exec("COMMIT");
      return { status: "daily_limited" };
    }
    if (recent.length >= 3) {
      db.exec("COMMIT");
      return { status: "weekly_limited" };
    }

    const chosen = consumeQueueRow(db, { memberId, source: "auto", shownAt: stamp });
    if (!chosen) {
      db.exec("COMMIT");
      return { status: "empty" };
    }

    const outboxId = enqueueOutbox(db, {
      dedupeKey,
      recipientMemberId: memberId,
      kind: "surprise_media",
      payload: {
        agentId,
        assetKey: chosen.assetKey,
        filePath: path.join(assetDir, chosen.assetKey),
        caption: "💝 Кстати, маленький сюрприз для тебя ♡",
        eventId: String(eventId),
        scheduledAt: new Date(scheduledMs).toISOString()
      },
      availableAt: asIso(stamp)
    });
    db.prepare("UPDATE surprise_member_state SET cycle=?,auto_next_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE member_id=?")
      .run(chosen.cycle, memberId);
    db.exec("COMMIT");
    return {
      status: "queued",
      outboxId,
      ...chosen,
      shownAt: stamp
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function surpriseQueueStatus(db, memberId) {
  requireMember(db, memberId);
  const totals = db.prepare(`SELECT
      count(*) AS total,
      sum(CASE WHEN a.active=1 THEN 1 ELSE 0 END) AS active,
      sum(CASE WHEN a.active=1 AND q.seen_count=0 THEN 1 ELSE 0 END) AS unseen,
      min(CASE WHEN a.active=1 THEN q.seen_count END) AS minSeen,
      max(CASE WHEN a.active=1 THEN q.seen_count END) AS maxSeen
    FROM surprise_member_queue q
    JOIN surprise_assets a ON a.asset_key=q.asset_key
    WHERE q.member_id=?`).get(memberId);
  const views = db.prepare(`SELECT source,count(*) AS count FROM surprise_views
    WHERE member_id=? GROUP BY source ORDER BY source`).all(memberId);
  const next = db.prepare(`SELECT q.asset_key AS assetKey,q.seen_count AS seenCount,q.queue_pos AS queuePos
    FROM surprise_member_queue q JOIN surprise_assets a ON a.asset_key=q.asset_key
    WHERE q.member_id=? AND a.active=1
    ORDER BY q.seen_count,q.queue_pos LIMIT 10`).all(memberId);
  return {
    total: Number(totals?.total ?? 0),
    active: Number(totals?.active ?? 0),
    unseen: Number(totals?.unseen ?? 0),
    minSeen: totals?.minSeen == null ? null : Number(totals.minSeen),
    maxSeen: totals?.maxSeen == null ? null : Number(totals.maxSeen),
    views: Object.fromEntries(views.map(row => [row.source, Number(row.count)])),
    next
  };
}
