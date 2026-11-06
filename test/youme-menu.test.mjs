import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createNote } from "../dist/domain.js";
import { createFamilyRuntime } from "../dist/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-youme-menu-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [
      { id: "participant_alpha", name: "Иван", role: "parent" },
      { id: "participant_beta", name: "Мария", role: "parent" }
    ],
    bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }]
  });
  return { dir, db };
}

async function openSection(runtime, section) {
  const edits = [];
  await runtime.interactive.handler({
    auth: { isAuthorizedSender: true }, callback: { payload: `section:${section}` },
    respond: { async editMessage(v) { edits.push(v); }, async reply() {} }
  });
  assert.equal(edits.length, 1);
  return edits[0];
}

for (const section of ["actions", "notes", "wishes", "places", "plans", "polls", "goals"]) {
  test(`empty ${section} section exposes create action`, async () => {
    const fx = fixture();
    try {
      const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
      const view = await openSection(runtime, section);
      const buttons = view.buttons.flat();
      assert(buttons.some(b => b.callback_data === `family:create:${section}`));
      assert(buttons.some(b => b.callback_data === "family:menu"));
      assert(buttons.some(b => b.callback_data === "family:close"));
    } finally { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  });
}

test("existing note is rendered as an item callback", async () => {
  const fx = fixture();
  try {
    const note = createNote(fx.db, {
      householdId: "home", createdBy: "participant_alpha", title: "Wi-Fi", body: "Пароль у роутера", visibility: "household"
    });
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const view = await openSection(runtime, "notes");
    const buttons = view.buttons.flat();
    assert(buttons.some(b => b.callback_data === `family:item:notes:${note.id}` && /Wi-Fi/.test(b.text)));
  } finally { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});
