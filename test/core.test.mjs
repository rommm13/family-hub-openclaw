import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  openFamilyDb,
  bootstrapFamily,
  resolveMemberForAgent,
  claimProcessedAction,
  integrityCheck,
} from "../dist/db.js";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-hub-"));
  return { dir, file: path.join(dir, "family.sqlite") };
}

test("migrations are idempotent and enable safe SQLite pragmas", () => {
  const { dir, file } = tempDb();
  try {
    const first = openFamilyDb(file);
    assert.equal(first.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(first.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.ok(first.prepare("PRAGMA busy_timeout").get().timeout >= 5000);
    first.close();
    const second = openFamilyDb(file);
    const versions = second.prepare("select version from schema_version").all();
    assert.deepEqual(versions.map(r => r.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    assert.equal(integrityCheck(second), true);
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trusted agent binding resolves a human member", () => {
  const { dir, file } = tempDb();
  try {
    const db = openFamilyDb(file);
    bootstrapFamily(db, {
      household: { id: "home", name: "РЎРµРјСЊСЏ" },
      members: [{ id: "participant_alpha", name: "Р РѕРјР°РЅ", role: "parent" }],
      bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }],
    });
    assert.deepEqual(resolveMemberForAgent(db, "agent_core", "main"), {
      id: "participant_alpha", name: "Р РѕРјР°РЅ", role: "parent", householdId: "home"
    });
    assert.equal(resolveMemberForAgent(db, "agent_core", "fake"), null);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("processed action key is claimed exactly once", () => {
  const { dir, file } = tempDb();
  try {
    const db = openFamilyDb(file);
    assert.equal(claimProcessedAction(db, "tg:1:42:create-note"), true);
    assert.equal(claimProcessedAction(db, "tg:1:42:create-note"), false);
    assert.equal(claimProcessedAction(db, "tg:1:43:create-note"), true);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
