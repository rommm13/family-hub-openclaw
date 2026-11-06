import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily, upsertMemberRoute } from "../dist/db.js";
import { createFamilyTool } from "../dist/tool.js";
import { processOutboxOnce } from "../dist/index.js";

function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"family-create-notify-"));
  const db=openFamilyDb(path.join(dir,"family.sqlite"));
  bootstrapFamily(db,{
    household:{id:"home",name:"Семья"},
    members:[
      {id:"participant_alpha",name:"Иван",role:"parent"},
      {id:"participant_beta",name:"Мария",role:"parent"}
    ],
    bindings:[
      {runtimeId:"agent_core",agentId:"main",memberId:"participant_alpha"},
      {runtimeId:"agent_core",agentId:"agent_second",memberId:"participant_beta"}
    ]
  });
  upsertMemberRoute(db,"participant_alpha",{runtimeId:"agent_core",agentId:"main",channel:"telegram",accountId:"default",to:"telegram:100000001"});
  upsertMemberRoute(db,"participant_beta",{runtimeId:"agent_core",agentId:"agent_second",channel:"telegram",accountId:"agent_second",to:"telegram:100000002"});
  return {dir,db};
}
function cleanup(fx){fx.db.close();fs.rmSync(fx.dir,{recursive:true,force:true});}
function tool(db,agentId){
  return createFamilyTool({
    db,runtimeId:"agent_core",agentId,now:()=>Date.parse("2026-09-19T00:00:00Z"),
    toolContext:{
      senderIsOwner:true,messageChannel:"telegram",agentId,
      sessionKey:`agent:${agentId}:telegram:direct:${agentId==="main"?"100000001":"100000002"}`
    }
  });
}
let seq=0;
async function act(t,params){return t.execute("create-notify-"+(++seq),params);}

test("shared creations enqueue one concise counterpart notification while secret creations stay quiet",async()=>{
  const fx=fixture();
  try{
    const t=tool(fx.db,"main");
    await act(t,{action:"add_shopping_items",items:["Молоко","Хлеб"]});
    await act(t,{action:"create_note",title:"Дом",body:"Проверить фильтр"});
    await act(t,{action:"create_wish",title:"Книга"});
    await act(t,{action:"create_place",title:"Новое кафе"});
    await act(t,{action:"create_plan",title:"Выходные",participants:["participant_alpha","participant_beta"]});
    await act(t,{action:"create_poll",question:"Куда поедем?",options:["Море","Горы"],participants:["participant_alpha","participant_beta"]});
    await act(t,{action:"create_goal",title:"Отпуск",amount:200000,dueAt:"2027-06-01",assigneeId:"participant_alpha"});
    await act(t,{action:"create_action",title:"Купить билеты",assigneeId:"participant_alpha",allowUndated:true});
    await act(t,{action:"create_calendar_event",title:"Ужин",startAt:"2026-09-20T19:00:00+03:00"});

    const texts=fx.db.prepare("SELECT recipient_member_id AS recipient,payload_json AS payload FROM outbox WHERE kind='text' AND dedupe_key NOT LIKE 'notify:due:calendar:%' ORDER BY id").all();
    assert.equal(texts.length,9);
    assert(texts.every(row=>row.recipient==="participant_beta"));
    assert.deepEqual(texts.map(row=>JSON.parse(row.payload).text),[
      "🛒 Иван · в покупки: Молоко, Хлеб",
      "📝 Иван · новая заметка: Дом",
      "🎁 Иван · новое желание: Книга",
      "📍 Иван · новое место: Новое кафе",
      "🧳 Иван · новый план: Выходные",
      "💬 Иван · новое голосование: Куда поедем?",
      "🌱 Иван · новая цель: Отпуск",
      "📌 Иван · новое дело: Купить билеты",
      "📅 Иван · новое событие: Ужин"
    ]);
    const reminder=fx.db.prepare("SELECT recipient_member_id AS recipient,available_at AS availableAt,payload_json AS payload FROM outbox WHERE dedupe_key LIKE 'notify:due:calendar:%'").get();
    assert.equal(reminder.recipient,"participant_beta");
    assert.equal(reminder.availableAt,"2026-09-20T16:00:00.000Z");
    assert.equal(JSON.parse(reminder.payload).text,"⏰ Напоминание: Ужин");

    await act(t,{action:"create_note",title:"Личное",body:"Не пушить",visibility:"owner"});
    await act(t,{action:"create_capsule",recipientId:"participant_beta",unlockAt:"2027-01-01T12:00:00Z",payload:"Секрет"});
    const after=fx.db.prepare("SELECT count(*) AS c FROM outbox WHERE kind='text' AND dedupe_key NOT LIKE 'notify:due:calendar:%'").get().c;
    assert.equal(after,9);
  }finally{cleanup(fx)}
});

test("Ivan creations are delivered through Agent Beta and Maria creations through Agent Alpha",async()=>{
  const fx=fixture();
  try{
    const participant_alpha=tool(fx.db,"main");
    await act(participant_alpha,{action:"create_note",title:"От Ивана",body:"Общее"});
    const sentToMaria=[];
    const first=await processOutboxOnce({
      db:fx.db,workerId:"test-agent_second",runtimeId:"agent_core",agentId:"agent_second",
      now:new Date(Date.now()+2000).toISOString(),leaseMs:60000,
      send:async(route,text)=>sentToMaria.push({route,text})
    });
    assert.equal(first.status,"sent");
    assert.equal(sentToMaria.length,1);
    assert.equal(sentToMaria[0].route.accountId,"agent_second");
    assert.equal(sentToMaria[0].route.to,"telegram:100000002");
    assert.equal(sentToMaria[0].text,"📝 Иван · новая заметка: От Ивана");

    const agent_second=tool(fx.db,"agent_second");
    await act(agent_second,{action:"create_calendar_event",title:"От Марии",startAt:"2026-09-18T18:00:00+03:00"});
    const sentToIvan=[];
    const second=await processOutboxOnce({
      db:fx.db,workerId:"test-main",runtimeId:"agent_core",agentId:"main",
      now:new Date(Date.now()+3000).toISOString(),leaseMs:60000,
      send:async(route,text)=>sentToIvan.push({route,text})
    });
    assert.equal(second.status,"sent");
    assert.equal(sentToIvan.length,1);
    assert.equal(sentToIvan[0].route.accountId,"default");
    assert.equal(sentToIvan[0].route.to,"telegram:100000001");
    assert.equal(sentToIvan[0].text,"📅 Мария · новое событие: От Марии");
  }finally{cleanup(fx)}
});
