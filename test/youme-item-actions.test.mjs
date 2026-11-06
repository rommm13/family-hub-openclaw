import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createFamilyTool } from "../dist/tool.js";
import { createFamilyRuntime } from "../dist/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-youme-items-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [
      { id: "participant_alpha", name: "Иван", role: "parent" },
      { id: "participant_beta", name: "Мария", role: "parent" }
    ],
    bindings: [
      { runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" },
      { runtimeId: "agent_second", agentId: "main", memberId: "participant_beta" }
    ]
  });
  return { dir, db };
}
function cleanup(fx){ fx.db.close(); fs.rmSync(fx.dir,{recursive:true,force:true}); }
function tool(db,runtimeId="agent_core") {
  return createFamilyTool({
    db,runtimeId,agentId:"main",
    toolContext:{senderIsOwner:true,messageChannel:"telegram",agentId:"main",sessionKey:"agent:main:telegram:direct:123"}
  });
}
let seq=0;
async function act(t, params){ return t.execute(`call-${++seq}`,params); }


test("note update and delete are available through family tool", async()=>{
  const fx=fixture();
  try{
    const t=tool(fx.db);
    const created=await act(t,{action:"create_note",title:"Wi-Fi",body:"Старый пароль"});
    const id=created.details.value.id;
    await act(t,{action:"update_note",noteId:id,title:"Wi-Fi дома",body:"Новый пароль"});
    let row=fx.db.prepare("SELECT title,body,deleted_at AS deletedAt FROM notes WHERE id=?").get(id);
    assert.deepEqual({...row},{title:"Wi-Fi дома",body:"Новый пароль",deletedAt:null});
    await act(t,{action:"delete_note",noteId:id});
    row=fx.db.prepare("SELECT deleted_at AS deletedAt FROM notes WHERE id=?").get(id);
    assert.ok(row.deletedAt);
  }finally{cleanup(fx)}
});

test("wish place and plan support update and removal/archive", async()=>{
  const fx=fixture();
  try{
    const t=tool(fx.db);
    const wish=(await act(t,{action:"create_wish",title:"Рюкзак"})).details.value.id;
    await act(t,{action:"update_wish",wishId:wish,title:"Рюкзак 30л",targetPrice:12000});
    assert.equal(fx.db.prepare("SELECT title,target_price AS price FROM wishes WHERE id=?").get(wish).title,"Рюкзак 30л");
    await act(t,{action:"remove_wish",wishId:wish});
    assert.equal(fx.db.prepare("SELECT status FROM wishes WHERE id=?").get(wish).status,"removed");

    const place=(await act(t,{action:"create_place",title:"Парк"})).details.value.id;
    await act(t,{action:"update_place",familyPlaceId:place,title:"Парк Горького",comment:"вечером"});
    assert.equal(fx.db.prepare("SELECT name FROM places WHERE id=?").get(place).name,"Парк Горького");
    await act(t,{action:"delete_place",familyPlaceId:place});
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM places WHERE id=?").get(place).c,0);

    const plan=(await act(t,{action:"create_plan",title:"Питер",participants:["participant_alpha","participant_beta"]})).details.value.id;
    await act(t,{action:"update_plan",planId:plan,title:"Питер на выходные",comment:"Сапсан"});
    assert.equal(fx.db.prepare("SELECT title FROM plans WHERE id=?").get(plan).title,"Питер на выходные");
    await act(t,{action:"archive_plan",planId:plan});
    assert.equal(fx.db.prepare("SELECT status FROM plans WHERE id=?").get(plan).status,"archived");
  }finally{cleanup(fx)}
});

test("actions goals and polls support management mutations", async()=>{
  const fx=fixture();
  try{
    const t=tool(fx.db);
    const action=(await act(t,{action:"create_action",title:"Купить торт",assigneeId:"participant_alpha",dueAt:"2026-09-19"})).details.value.id;
    await act(t,{action:"update_action",actionId:action,title:"Заказать торт",assigneeId:"participant_beta",dueAt:"2026-09-20T12:00:00+03:00"});
    let a=fx.db.prepare("SELECT title,assignee_id AS assigneeId,due_at AS dueAt FROM actions WHERE id=?").get(action);
    assert.deepEqual({...a},{title:"Заказать торт",assigneeId:"participant_beta",dueAt:"2026-09-20T12:00:00+03:00"});
    await act(t,{action:"complete_action",actionId:action});
    assert.equal(fx.db.prepare("SELECT status FROM actions WHERE id=?").get(action).status,"completed");

    const action2=(await act(t,{action:"create_action",title:"Черновик",assigneeId:"participant_alpha",allowUndated:true})).details.value.id;
    await act(t,{action:"cancel_action",actionId:action2});
    assert.equal(fx.db.prepare("SELECT status FROM actions WHERE id=?").get(action2).status,"cancelled");

    const goal=(await act(t,{action:"create_goal",title:"Отпуск",amount:100000,dueAt:"2026-12-30",assigneeId:"participant_alpha"})).details.value.id;
    await act(t,{action:"update_goal",goalId:goal,title:"Отпуск 2027",amount:150000,dueAt:"2027-01-15"});
    assert.equal(fx.db.prepare("SELECT amount FROM money_goals WHERE id=?").get(goal).amount,150000);
    await act(t,{action:"complete_goal",goalId:goal});
    assert.equal(fx.db.prepare("SELECT status FROM money_goals WHERE id=?").get(goal).status,"completed");

    const poll=(await act(t,{action:"create_poll",question:"Куда?",options:["Кино","Театр"],participants:["participant_alpha","participant_beta"]})).details.value.id;
    await act(t,{action:"close_poll",pollId:poll});
    assert.equal(fx.db.prepare("SELECT status FROM polls WHERE id=?").get(poll).status,"closed");
  }finally{cleanup(fx)}
});

test("item callback opens note detail and destructive delete requires confirmation", async()=>{
  const fx=fixture();
  try{
    const t=tool(fx.db);
    const note=(await act(t,{action:"create_note",title:"Wi-Fi",body:"Пароль у роутера"})).details.value.id;
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main"});
    const edits=[];
    await runtime.interactive.handler({
      auth:{isAuthorizedSender:true},callback:{payload:`item:notes:${note}`},
      respond:{async editMessage(v){edits.push(v)},async reply() {}}
    });
    assert.match(edits.at(-1).text,/Пароль у роутера/);
    assert(edits.at(-1).buttons.flat().some(b=>b.callback_data===`family:do:edit:notes:${note}`));
    assert(edits.at(-1).buttons.flat().some(b=>b.callback_data===`family:do:delete:notes:${note}`));

    await runtime.interactive.handler({
      auth:{isAuthorizedSender:true},callback:{payload:`do:delete:notes:${note}`},
      respond:{async editMessage(v){edits.push(v)},async reply() {}}
    });
    assert.equal(fx.db.prepare("SELECT deleted_at AS d FROM notes WHERE id=?").get(note).d,null);
    assert(edits.at(-1).buttons.flat().some(b=>b.callback_data===`family:apply:delete:notes:${note}`));

    await runtime.interactive.handler({
      auth:{isAuthorizedSender:true},callback:{payload:`apply:delete:notes:${note}`},
      respond:{async editMessage(v){edits.push(v)},async reply() {}}
    });
    assert.ok(fx.db.prepare("SELECT deleted_at AS d FROM notes WHERE id=?").get(note).d);
  }finally{cleanup(fx)}
});

async function uiClick(runtime,payload){
  const edits=[];
  await runtime.interactive.handler({sessionKey:"agent:main:telegram:direct:123",auth:{isAuthorizedSender:true},callback:{payload},respond:{async editMessage(v){edits.push(v)},async reply(){}}});
  return edits.at(-1);
}
async function uiSay(runtime,text){
  return runtime.beforeDispatch({content:text,channel:"telegram"},{sessionKey:"agent:main:telegram:direct:123",conversationId:"123",accountId:"default"});
}

test("note edit wizard updates title and body", async()=>{
  const fx=fixture();
  try{
    const t=tool(fx.db); const id=(await act(t,{action:"create_note",title:"Wi-Fi",body:"Старый"})).details.value.id;
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main"});
    const prompt=await uiClick(runtime,`do:edit:notes:${id}`);
    assert.match(prompt.text,/новое название/i);
    assert.match((await uiSay(runtime,"Wi-Fi дома")).text,/текст/i);
    assert.match((await uiSay(runtime,"Новый пароль")).text,/сохран/i);
    const row=fx.db.prepare("SELECT title,body FROM notes WHERE id=?").get(id);
    assert.deepEqual({...row},{title:"Wi-Fi дома",body:"Новый пароль"});
  }finally{cleanup(fx)}
});

test("action edit wizard updates title assignee and deadline through canonical mutation", async()=>{
  const fx=fixture();
  try{
    const t=tool(fx.db); const id=(await act(t,{action:"create_action",title:"Купить торт",assigneeId:"participant_alpha",dueAt:"2026-09-19"})).details.value.id;
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",now:()=>Date.parse("2026-09-17T09:00:00Z")});
    assert.match((await uiClick(runtime,`do:edit:actions:${id}`)).text,/название/i);
    await uiSay(runtime,"Заказать торт");
    await uiSay(runtime,"Мария");
    const done=await uiSay(runtime,"20.09 12:00");
    assert.match(done.text,/сохран/i);
    const row=fx.db.prepare("SELECT title,assignee_id AS assigneeId,due_at AS dueAt FROM actions WHERE id=?").get(id);
    assert.deepEqual({...row},{title:"Заказать торт",assigneeId:"participant_beta",dueAt:"2026-09-20T12:00:00+03:00"});
    const outbox=fx.db.prepare("SELECT kind FROM outbox WHERE kind='calendar_action_upsert'").all();
    assert(outbox.length>=2);
  }finally{cleanup(fx)}
});

test("goal edit wizard updates title amount and date", async()=>{
  const fx=fixture();
  try{
    const t=tool(fx.db); const id=(await act(t,{action:"create_goal",title:"Отпуск",amount:100000,dueAt:"2026-12-30",assigneeId:"participant_alpha"})).details.value.id;
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",now:()=>Date.parse("2026-09-17T09:00:00Z")});
    await uiClick(runtime,`do:edit:goals:${id}`);
    await uiSay(runtime,"Отпуск 2027");
    await uiSay(runtime,"180000");
    const done=await uiSay(runtime,"15.01.2027");
    assert.match(done.text,/сохран/i);
    const row=fx.db.prepare("SELECT title,amount,due_at AS dueAt FROM money_goals WHERE id=?").get(id);
    assert.deepEqual({...row},{title:"Отпуск 2027",amount:180000,dueAt:"2027-01-15"});
  }finally{cleanup(fx)}
});
