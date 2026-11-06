import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createAction, addShoppingItems } from "../dist/domain.js";
import { createFamilyRuntime } from "../dist/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-warm-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [{ id: "participant_alpha", name: "Иван", role: "parent" }, { id: "participant_beta", name: "Мария", role: "parent" }],
    bindings: [{ runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" }]
  });
  return { dir, db };
}
function cleanup(fx) { fx.db.close(); fs.rmSync(fx.dir,{recursive:true,force:true}); }

test("warm main menu uses compact primary sections with Telegram-compatible buttons", () => {
  const fx=fixture();
  try {
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main"});
    const menu=runtime.command.handler({isAuthorizedSender:true,agentId:"main"});
    const buttons=menu.channelData.telegram.buttons.flat();
    const labels=buttons.map(b=>b.text);
    for (const label of ["📌 Дела","🛒 Купить","🗓 Вместе","📝 Записки","📍 Куда","🎁 Хочу","💝 Сюрприз","✨ Ещё","👋 Закрыть"])
      assert(labels.includes(label), "missing " + label);
    assert.equal(labels.includes("📅 Календарь"), false);
    assert.equal(buttons.some(button => Object.hasOwn(button, "style")), false);
  } finally { cleanup(fx); }
});

test("legacy More callback opens the secondary Ещё screen", async () => {
  const fx=fixture();
  try {
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main"});
    const edits=[];
    await runtime.interactive.handler({
      auth:{isAuthorizedSender:true},callback:{payload:"more"},
      respond:{async editMessage(v){edits.push(v)},async reply(){}}
    });
    const labels=edits.at(-1).buttons.flat().map(b=>b.text);
    for (const label of ["🧭 Планы","🌱 Цели","💬 Выбрать","📦 Капсулы","💳 Кэшбэк","🔎 Поиск","ℹ️ Как это работает"])
      assert(labels.includes(label), "missing " + label);
    assert.equal(labels.includes("📌 Дела"), false);
  } finally { cleanup(fx); }
});

test("Family button dashboard shows todays action nearest event and shopping count", async () => {
  const fx=fixture();
  try {
    createAction(fx.db,{householdId:"home",createdBy:"participant_alpha",assigneeId:"participant_alpha",title:"Оплатить страховку",dueAt:"2026-09-18",allDay:true});
    addShoppingItems(fx.db,{householdId:"home",createdBy:"participant_alpha",items:["Молоко","Яйца"]});
    const calendar={async listUpcomingEvents(){return [{id:"g1",summary:"Ужин с родителями",start:"2026-09-18T16:30:00Z",allDay:false}]}};
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",calendar,now:()=>Date.parse("2026-09-18T06:00:00+03:00")});
    const claimed=await runtime.beforeDispatch(
      {content:"🫶 Семья",channel:"telegram"},
      {sessionKey:"agent:main:telegram:direct:123",conversationId:"123",accountId:"default"}
    );
    assert.match(claimed.text,/Сегодня/);
    assert.match(claimed.text,/Оплатить страховку/);
    assert.match(claimed.text,/Ужин с родителями/);
    assert.match(claimed.text,/Купить · 2/);
  } finally { cleanup(fx); }
});


test("action card uses warm concise labels without unsupported Telegram fields", async () => {
  const fx=fixture();
  try {
    const action=createAction(fx.db,{householdId:"home",createdBy:"participant_alpha",assigneeId:"participant_alpha",title:"Оплатить страховку",dueAt:"2026-09-18",allDay:true});
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main"});
    const edits=[];
    await runtime.interactive.handler({
      auth:{isAuthorizedSender:true},callback:{payload:"item:actions:"+action.id},
      respond:{async editMessage(v){edits.push(v)},async reply(){}}
    });
    const buttons=edits.at(-1).buttons.flat();
    const done=buttons.find(b=>b.text==="✓ Готово");
    const cancel=buttons.find(b=>b.text==="× Отменить");
    assert(done);
    assert(cancel);
    assert.equal(Object.hasOwn(done, "style"), false);
    assert.equal(Object.hasOwn(cancel, "style"), false);
  } finally { cleanup(fx); }
});
