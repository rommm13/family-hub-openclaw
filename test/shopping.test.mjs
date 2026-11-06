import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createFamilyTool, TOOL_PARAMETERS } from "../dist/tool.js";
import { createFamilyRuntime } from "../dist/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-shopping-"));
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
function cleanup(fx) { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
function tool(db) {
  return createFamilyTool({
    db, runtimeId: "agent_core", agentId: "main",
    toolContext: { senderIsOwner: true, messageChannel: "telegram", agentId: "main", sessionKey: "agent:main:telegram:direct:123" }
  });
}
let seq = 0;
async function act(t, params) { return t.execute("shop-" + (++seq), params); }

test("shopping contract exposes bulk add list toggle and clear", () => {
  const actions = TOOL_PARAMETERS.properties.action.enum;
  for (const name of ["list_shopping", "add_shopping_items", "toggle_shopping_item", "clear_bought_shopping"])
    assert(actions.includes(name), "missing " + name);
});

test("shopping tool bulk-adds and toggles household checklist items", async () => {
  const fx = fixture();
  try {
    const t = tool(fx.db);
    const added = await act(t, { action: "add_shopping_items", items: ["Молоко", "Яйца", "Сыр"] });
    assert.equal(added.details.ok, true);
    assert.equal(added.details.value.items.length, 3);
    let list = await act(t, { action: "list_shopping" });
    assert.deepEqual(list.details.items.map(x => x.name), ["Молоко", "Яйца", "Сыр"]);
    const id = list.details.items[0].id;
    await act(t, { action: "toggle_shopping_item", shoppingItemId: id });
    list = await act(t, { action: "list_shopping" });
    assert.equal(list.details.items.find(x => x.id === id).checked, true);
    await act(t, { action: "clear_bought_shopping" });
    list = await act(t, { action: "list_shopping" });
    assert.equal(list.details.items.length, 2);
  } finally { cleanup(fx); }
});

test("shopping UI creates multiple items from one Telegram message and toggles inline", async () => {
  const fx = fixture();
  try {
    const runtime = createFamilyRuntime({ db: fx.db, runtimeId: "agent_core", agentId: "main" });
    const edits = [];
    const click = async payload => {
      edits.length = 0;
      await runtime.interactive.handler({
        sessionKey: "agent:main:telegram:direct:123",
        auth: { isAuthorizedSender: true }, callback: { payload },
        respond: { async editMessage(v) { edits.push(v); }, async reply() {} }
      });
      return edits.at(-1);
    };
    const say = text => runtime.beforeDispatch(
      { content: text, channel: "telegram" },
      { sessionKey: "agent:main:telegram:direct:123", conversationId: "123", accountId: "default" }
    );
    const start = await click("create:shopping");
    assert.match(start.text, /добав|куп/i);
    const done = await say("Молоко, яйца; сыр");
    assert.match(done.text, /добав/i);
    const view = await click("section:shopping");
    const toggle = view.buttons.flat().find(b => b.callback_data?.startsWith("family:shopping:toggle:"));
    assert(toggle);
    await click(toggle.callback_data.replace(/^family:/, ""));
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM shopping_items WHERE checked=1").get().c, 1);
  } finally { cleanup(fx); }
});
