import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily, upsertMemberRoute } from "../dist/db.js";
import { getCapsuleForViewer } from "../dist/domain.js";
import { createFamilyTool } from "../dist/tool.js";
import { createFamilyRuntime, processOutboxOnce, createCalendarOutboxHandlers, createCapsuleOutboxHandlers } from "../dist/index.js";

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"family-caps-cal-"));
  const db=openFamilyDb(path.join(dir,"family.sqlite"));
  bootstrapFamily(db,{household:{id:"home",name:"Семья"},members:[
    {id:"participant_alpha",name:"Иван",role:"parent"},{id:"participant_beta",name:"Мария",role:"parent"}
  ],bindings:[{runtimeId:"agent_core",agentId:"main",memberId:"participant_alpha"},{runtimeId:"agent_core",agentId:"agent_second",memberId:"participant_beta"}]});
  upsertMemberRoute(db,"participant_alpha",{runtimeId:"agent_core",agentId:"main",channel:"telegram",accountId:"default",to:"telegram:111"});
  upsertMemberRoute(db,"participant_beta",{runtimeId:"agent_core",agentId:"agent_second",channel:"telegram",accountId:"agent_second",to:"telegram:222"});
  return {dir,db};
}
function cleanup(fx){fx.db.close();fs.rmSync(fx.dir,{recursive:true,force:true});}
function tool(db){return createFamilyTool({db,runtimeId:"agent_core",agentId:"main",now:()=>Date.parse("2026-09-19T00:00:00Z"),toolContext:{senderIsOwner:true,messageChannel:"telegram",agentId:"main",sessionKey:"agent:main:telegram:direct:123"}})}
let seq=0; async function act(t,p){return t.execute(`caps-cal-${++seq}`,p)}

test("capsule creation hides payload until unlock and schedules internal lifecycle job", async()=>{
  const fx=fixture();
  try{
    const t=tool(fx.db);
    const created=await act(t,{action:"create_capsule",recipientId:"participant_beta",unlockAt:"2026-09-20T12:00:00+03:00",payload:"Сюрприз!"});
    const id=created.details.value.id;
    assert.equal(getCapsuleForViewer(fx.db,id,"participant_beta",new Date("2026-09-19T10:00:00Z")).payload,null);
    assert.equal(getCapsuleForViewer(fx.db,id,"participant_alpha",new Date("2026-09-19T10:00:00Z")).payload,null);
    const job=fx.db.prepare("SELECT kind,available_at AS availableAt,recipient_member_id AS recipientId FROM outbox WHERE kind='capsule_unlock'").get();
    assert.equal(job.recipientId,"participant_beta");
    assert.equal(job.availableAt,"2026-09-20T09:00:00.000Z");
    const handlers=createCapsuleOutboxHandlers({db:fx.db});
    const result=await processOutboxOnce({db:fx.db,workerId:"agent_second",runtimeId:"agent_core",agentId:"agent_second",now:"2026-09-20T09:00:01.000Z",send:async()=>{},handlers});
    assert.equal(result.status,"sent");
    assert.equal(fx.db.prepare("SELECT status FROM capsules WHERE id=?").get(id).status,"delivered");
    assert.equal(getCapsuleForViewer(fx.db,id,"participant_beta",new Date("2026-09-20T09:00:02Z")).payload,"Сюрприз!");
    const delivery=fx.db.prepare("SELECT recipient_member_id AS recipient,payload_json AS payload FROM outbox WHERE dedupe_key=?").get(`capsule:${id}:delivery`);
    assert.equal(delivery.recipient,"participant_beta");
    assert.match(JSON.parse(delivery.payload).text,/Капсула от Иван/);
    assert.match(JSON.parse(delivery.payload).text,/Сюрприз!/);
    const sent=[];
    const delivered=await processOutboxOnce({db:fx.db,workerId:"agent_second2",runtimeId:"agent_core",agentId:"agent_second",now:"2026-09-20T09:00:02.000Z",send:async(route,text)=>sent.push({route,text}),handlers});
    assert.equal(delivered.status,"sent");
    assert.equal(sent[0].route.accountId,"agent_second");
    assert.equal(sent[0].route.to,"telegram:222");
    assert.match(sent[0].text,/Сюрприз!/);
  }finally{cleanup(fx)}
});


test("attached reply postcard becomes a timed media capsule and asks when to send", async()=>{
  const fx=fixture();
  try{
    const source=path.join(fx.dir,"reply-card.jpg");
    fs.writeFileSync(source,Buffer.from("fake-jpeg"));
    const mediaDir=path.join(fx.dir,"capsule-media");
    const runtime=createFamilyRuntime({
      db:fx.db,runtimeId:"agent_core",agentId:"main",
      now:()=>Date.parse("2026-09-18T12:41:13Z"),capsuleMediaDir:mediaDir
    });
    const claimed=await runtime.inboundClaim({
      channel:"telegram",isGroup:false,content:"отправь Ивану в ответ",
      media:[{path:source,contentType:"image/jpeg"}]
    },{
      sessionKey:"agent:agent_second:telegram:direct:222",agentId:"agent_second",
      conversationId:"222",accountId:"agent_second"
    });
    assert.equal(claimed.handled,true);
    assert.match(claimed.reply.text,/Получатель: Иван/i);
    assert.match(claimed.reply.text,/Когда отправить/i);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM capsules").get().c,0);

    const scheduled=await runtime.beforeDispatch({
      channel:"telegram",content:"сегодня 19:00"
    },{
      sessionKey:"agent:agent_second:telegram:direct:222",agentId:"agent_second",
      conversationId:"222",accountId:"agent_second"
    });
    assert.equal(scheduled.handled,true);
    assert.match(scheduled.text,/Открытка запечатана/i);
    const capsule=fx.db.prepare("SELECT id,author_id AS authorId,recipient_id AS recipientId,unlock_at AS unlockAt,payload,status FROM capsules").get();
    assert.equal(capsule.authorId,"participant_beta");
    assert.equal(capsule.recipientId,"participant_alpha");
    assert.equal(capsule.unlockAt,"2026-09-18T19:00:00+03:00");
    assert.equal(capsule.status,"sealed");
    const media=fx.db.prepare("SELECT file_path AS filePath,content_type AS contentType FROM capsule_media WHERE capsule_id=?").get(capsule.id);
    assert.equal(media.contentType,"image/jpeg");
    assert.equal(fs.existsSync(media.filePath),true);
    const job=fx.db.prepare("SELECT recipient_member_id AS recipient,kind,available_at AS availableAt FROM outbox WHERE dedupe_key=?").get(`capsule:${capsule.id}:unlock`);
    assert.equal(job.recipient,"participant_alpha");
    assert.equal(job.kind,"capsule_unlock");
    assert.equal(job.availableAt,"2026-09-18T16:00:00.000Z");
  }finally{cleanup(fx)}
});


test("media capsule trigger stays narrow and accepts natural reply wording", async()=>{
  const fx=fixture();
  try{
    const source=path.join(fx.dir,"reply-card.jpg");
    fs.writeFileSync(source,Buffer.from("fake-jpeg"));
    const cases=["пошли Ивану в ответ","скинь Ивану эту открытку","отошли Ивану Love Is"];
    for(const content of cases){
      const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",now:()=>Date.parse("2026-09-18T12:41:13Z"),capsuleMediaDir:path.join(fx.dir,"capsule-media")});
      const claimed=await runtime.inboundClaim({channel:"telegram",isGroup:false,content,media:[{path:source,contentType:"image/jpeg"}]},
        {sessionKey:"agent:agent_second:telegram:direct:222",agentId:"agent_second",conversationId:"222",accountId:"agent_second"});
      assert.equal(claimed?.handled,true,content);
    }
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",capsuleMediaDir:path.join(fx.dir,"capsule-media")});
    for(const content of ["перешли Ивану документ","скинь Ивану фото","пришли карту фикс прайс"]){
      const claimed=await runtime.inboundClaim({channel:"telegram",isGroup:false,content,media:[{path:source,contentType:"image/jpeg"}]},
        {sessionKey:"agent:agent_second:telegram:direct:222",agentId:"agent_second",conversationId:"222",accountId:"agent_second"});
      assert.equal(claimed,undefined,content);
    }
  }finally{cleanup(fx)}
});


test("reply context restores capsule intent for a short «Отправь» caption", async()=>{
  const fx=fixture();
  try{
    const source=path.join(fx.dir,"reply-card.jpg");
    fs.writeFileSync(source,Buffer.from("fake-jpeg"));
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",now:()=>Date.parse("2026-09-18T16:03:48Z"),capsuleMediaDir:path.join(fx.dir,"capsule-media")});
    const claimed=await runtime.inboundClaim({
      channel:"telegram",isGroup:false,content:"Отправь",replyToBody:"отправь Ивану в ответ",
      media:[{path:source,contentType:"image/jpeg"}]
    },{sessionKey:"agent:agent_second:telegram:direct:222",agentId:"agent_second",conversationId:"222",accountId:"agent_second"});
    assert.equal(claimed?.handled,true);
    assert.match(claimed.reply.text,/Получатель: Иван/i);
    assert.match(claimed.reply.text,/Когда отправить/i);
  }finally{cleanup(fx)}
});


test("media capsule draft survives runtime restart and finalizes exactly once", async()=>{
  const fx=fixture();
  try{
    const source=path.join(fx.dir,"reply-card.jpg");
    fs.writeFileSync(source,Buffer.from("fake-jpeg"));
    const mediaDir=path.join(fx.dir,"capsule-media");
    const now=()=>Date.parse("2026-09-18T12:41:13Z");
    const first=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",now,capsuleMediaDir:mediaDir});
    const claimed=await first.inboundClaim({
      channel:"telegram",isGroup:false,content:"отправь Ивану в ответ",
      media:[{path:source,contentType:"image/jpeg"}]
    },{sessionKey:"agent:agent_second:main",agentId:"agent_second",conversationId:"222",accountId:"agent_second"});
    assert.equal(claimed?.handled,true);
    const draft=fx.db.prepare("SELECT author_id AS authorId,recipient_id AS recipientId,file_path AS filePath FROM capsule_media_drafts").get();
    assert.equal(draft.authorId,"participant_beta");
    assert.equal(draft.recipientId,"participant_alpha");
    assert.equal(fs.existsSync(draft.filePath),true);

    const afterRestart=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",now,capsuleMediaDir:mediaDir});
    const scheduled=await afterRestart.beforeDispatch(
      {channel:"telegram",content:"сегодня 19:00"},
      {sessionKey:"agent:agent_second:main",agentId:"agent_second",conversationId:"222",accountId:"agent_second"}
    );
    assert.equal(scheduled?.handled,true);
    assert.match(scheduled.text,/Открытка запечатана/i);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM capsule_media_drafts").get().c,0);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM capsules").get().c,1);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM outbox WHERE kind='capsule_unlock'").get().c,1);

    const repeated=await afterRestart.beforeDispatch(
      {channel:"telegram",content:"сегодня 19:00"},
      {sessionKey:"agent:agent_second:main",agentId:"agent_second",conversationId:"222",accountId:"agent_second"}
    );
    assert.equal(repeated,undefined);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM capsules").get().c,1);
  }finally{cleanup(fx)}
});

test("media capsule accepts natural time-only reply but rejects date-only and past time", async()=>{
  const fx=fixture();
  try{
    const source=path.join(fx.dir,"reply-card.jpg");
    fs.writeFileSync(source,Buffer.from("fake-jpeg"));
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",now:()=>Date.parse("2026-09-18T16:01:00Z"),capsuleMediaDir:path.join(fx.dir,"capsule-media")});
    await runtime.inboundClaim({channel:"telegram",isGroup:false,content:"отправь Ивану в ответ",media:[{path:source,contentType:"image/jpeg"}]},
      {sessionKey:"agent:agent_second:telegram:direct:222",agentId:"agent_second",conversationId:"222",accountId:"agent_second"});
    let reply=await runtime.beforeDispatch({channel:"telegram",content:"19:00"},{sessionKey:"agent:agent_second:telegram:direct:222",agentId:"agent_second",conversationId:"222",accountId:"agent_second"});
    assert.match(reply.text,/уже прошло/i);
    reply=await runtime.beforeDispatch({channel:"telegram",content:"сегодня"},{sessionKey:"agent:agent_second:telegram:direct:222",agentId:"agent_second",conversationId:"222",accountId:"agent_second"});
    assert.match(reply.text,/Нужны дата и время/i);
    reply=await runtime.beforeDispatch({channel:"telegram",content:"в 20:00"},{sessionKey:"agent:agent_second:telegram:direct:222",agentId:"agent_second",conversationId:"222",accountId:"agent_second"});
    assert.match(reply.text,/Открытка запечатана/i);
    const capsule=fx.db.prepare("SELECT unlock_at AS unlockAt FROM capsules ORDER BY created_at DESC LIMIT 1").get();
    assert.equal(capsule.unlockAt,"2026-09-18T20:00:00+03:00");
  }finally{cleanup(fx)}
});


test("media capsule keeps the attachment while clarifying an ambiguous recipient", async()=>{
  const fx=fixture();
  try{
    const source=path.join(fx.dir,"reply-card.jpg");
    fs.writeFileSync(source,Buffer.from("fake-jpeg"));
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",now:()=>Date.parse("2026-09-18T12:41:13Z"),capsuleMediaDir:path.join(fx.dir,"capsule-media")});
    const claimed=await runtime.inboundClaim({channel:"telegram",isGroup:false,content:"отправь Ивану эту открытку",media:[{path:source,contentType:"image/jpeg"}]},
      {sessionKey:"agent:main:telegram:direct:111",agentId:"main",conversationId:"111",accountId:"default"});
    assert.equal(claimed?.handled,true);
    assert.match(claimed.reply.text,/Кому отправить/i);
    let reply=await runtime.beforeDispatch({channel:"telegram",content:"Мария"},{sessionKey:"agent:main:telegram:direct:111",agentId:"main",conversationId:"111",accountId:"default"});
    assert.match(reply.text,/Получатель: Мария/i);
    reply=await runtime.beforeDispatch({channel:"telegram",content:"завтра 09:00"},{sessionKey:"agent:main:telegram:direct:111",agentId:"main",conversationId:"111",accountId:"default"});
    assert.match(reply.text,/Открытка запечатана/i);
    const capsule=fx.db.prepare("SELECT author_id AS authorId,recipient_id AS recipientId FROM capsules ORDER BY created_at DESC LIMIT 1").get();
    assert.equal(capsule.authorId,"participant_alpha");
    assert.equal(capsule.recipientId,"participant_beta");
  }finally{cleanup(fx)}
});

test("generic family image forwarding is not hijacked by capsule flow", async()=>{
  const fx=fixture();
  try{
    const source=path.join(fx.dir,"document.jpg");
    fs.writeFileSync(source,Buffer.from("fake-jpeg"));
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",capsuleMediaDir:path.join(fx.dir,"capsule-media")});
    const claimed=await runtime.inboundClaim({channel:"telegram",isGroup:false,content:"перешли Ивану документ",media:[{path:source,contentType:"image/jpeg"}]},
      {sessionKey:"agent:agent_second:telegram:direct:222",agentId:"agent_second",conversationId:"222",accountId:"agent_second"});
    assert.equal(claimed,undefined);
  }finally{cleanup(fx)}
});

test("unrelated attached image is not claimed as a family send", async()=>{
  const fx=fixture();
  try{
    const source=path.join(fx.dir,"photo.jpg");
    fs.writeFileSync(source,Buffer.from("fake-jpeg"));
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",capsuleMediaDir:path.join(fx.dir,"capsule-media")});
    const claimed=await runtime.inboundClaim({
      channel:"telegram",isGroup:false,content:"что это?",
      media:[{path:source,contentType:"image/jpeg"}]
    },{
      sessionKey:"agent:agent_second:telegram:direct:222",agentId:"agent_second",
      conversationId:"222",accountId:"agent_second"
    });
    assert.equal(claimed,undefined);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM capsules").get().c,0);
  }finally{cleanup(fx)}
});

test("media capsule unlock enqueues and sends media through recipient handler", async()=>{
  const fx=fixture();
  try{
    const source=path.join(fx.dir,"card.jpg");
    fs.writeFileSync(source,Buffer.from("fake-jpeg"));
    const t=tool(fx.db);
    const created=await act(t,{action:"create_capsule",recipientId:"participant_beta",unlockAt:"2026-09-20T12:00:00+03:00",payload:"🖼 Открытка"});
    const id=created.details.value.id;
    fx.db.prepare("INSERT INTO capsule_media(capsule_id,file_path,content_type,caption) VALUES (?,?,?,?)")
      .run(id,source,"image/jpeg",null);
    const sent=[];
    const handlers=createCapsuleOutboxHandlers({
      db:fx.db,
      sendMedia:async row=>sent.push(row)
    });
    const unlocked=await processOutboxOnce({
      db:fx.db,workerId:"agent_second-unlock",runtimeId:"agent_core",agentId:"agent_second",
      now:"2026-09-20T09:00:01.000Z",send:async()=>{},handlers
    });
    assert.equal(unlocked.status,"sent");
    const delivery=fx.db.prepare("SELECT kind,recipient_member_id AS recipient,payload_json AS payload FROM outbox WHERE dedupe_key=?").get(`capsule:${id}:delivery`);
    assert.equal(delivery.kind,"capsule_media");
    assert.equal(delivery.recipient,"participant_beta");
    assert.match(JSON.parse(delivery.payload).caption,/Открытка · Иван/);
    const delivered=await processOutboxOnce({
      db:fx.db,workerId:"agent_second-media",runtimeId:"agent_core",agentId:"agent_second",
      now:"2026-09-20T09:00:02.000Z",send:async()=>{},handlers
    });
    assert.equal(delivered.status,"sent");
    assert.equal(sent.length,1);
    assert.equal(sent[0].payload.filePath,source);
  }finally{cleanup(fx)}
});

test("direct family calendar event uses local metadata and calendar outbox", async()=>{
  const fx=fixture();
  try{
    const t=tool(fx.db);
    const created=await act(t,{action:"create_calendar_event",title:"День рождения мамы",startAt:"2026-09-21",description:"Позвонить утром"});
    const id=created.details.value.id;
    const local=fx.db.prepare("SELECT title,start_at AS startAt,all_day AS allDay,status FROM family_events WHERE id=?").get(id);
    assert.deepEqual({...local},{title:"День рождения мамы",startAt:"2026-09-21",allDay:1,status:"active"});
    const calls=[];
    const calendar={async ensureEvent(input){calls.push(["ensure",input]);return {id:"evt-direct",created:true}},async updateEvent(input){calls.push(["update",input]);return {id:input.eventId}},async deleteEvent(input){calls.push(["delete",input]);return {id:input.eventId,deleted:true}}};
    const handlers=createCalendarOutboxHandlers({db:fx.db,calendar,calendarId:"family-cal"});
    const res=await processOutboxOnce({db:fx.db,workerId:"agent_core",runtimeId:"agent_core",agentId:"main",now:"2099-01-01T00:00:00Z",send:async()=>{},handlers});
    assert.equal(res.status,"sent");
    assert.equal(calls[0][0],"ensure");
    assert.equal(calls[0][1].entityType,"family_event");
    assert.equal(fx.db.prepare("SELECT google_event_id AS id FROM family_events WHERE id=?").get(id).id,"evt-direct");

    await act(t,{action:"update_calendar_event",calendarEventId:id,title:"ДР мамы",startAt:"2026-09-21T18:00:00+03:00"});
    await processOutboxOnce({db:fx.db,workerId:"agent_core2",runtimeId:"agent_core",agentId:"main",now:"2099-01-01T00:00:01Z",send:async()=>{},handlers});
    assert(calls.some(([kind])=>kind==="update"));
    const reminder=fx.db.prepare("SELECT recipient_member_id AS recipient,available_at AS availableAt,payload_json AS payload FROM outbox WHERE dedupe_key=?").get(`notify:due:calendar:${id}:participant_beta:rev:2`);
    assert.equal(reminder.recipient,"participant_beta");
    assert.equal(reminder.availableAt,"2026-09-21T15:00:00.000Z");
    assert.equal(JSON.parse(reminder.payload).text,"⏰ Напоминание: ДР мамы");

    await act(t,{action:"delete_calendar_event",calendarEventId:id});
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM outbox WHERE dedupe_key LIKE ?").get(`notify:due:calendar:${id}:%`).c,0);
    await processOutboxOnce({db:fx.db,workerId:"agent_core3",runtimeId:"agent_core",agentId:"main",now:"2099-01-01T00:00:02Z",send:async()=>{},handlers});
    assert(calls.some(([kind])=>kind==="delete"));
    assert.equal(fx.db.prepare("SELECT status FROM family_events WHERE id=?").get(id).status,"cancelled");
  }finally{cleanup(fx)}
});

test("capsule and calendar sections expose create wizards", async()=>{
  const fx=fixture();
  try{
    const calendar={async listUpcomingEvents(){return []}};
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",calendar,now:()=>Date.parse("2026-09-17T09:00:00Z")});
    const edits=[];
    const click=async payload=>runtime.interactive.handler({auth:{isAuthorizedSender:true},callback:{payload},respond:{async editMessage(v){edits.push(v)},async reply(){}}});
    await click("section:capsules");
    assert(edits.at(-1).buttons.flat().some(b=>b.callback_data==="family:create:capsules"));
    await click("section:calendar");
    assert(edits.at(-1).buttons.flat().some(b=>b.callback_data==="family:create:calendar"));
  }finally{cleanup(fx)}
});

async function clickUi(runtime,payload){
  const edits=[];
  await runtime.interactive.handler({
    sessionKey:"agent:main:telegram:direct:123",
    auth:{isAuthorizedSender:true},callback:{payload},
    respond:{async editMessage(v){edits.push(v)},async reply(){}}
  });
  return edits.at(-1);
}
async function sayUi(runtime,text){
  return runtime.beforeDispatch(
    {content:text,channel:"telegram"},
    {sessionKey:"agent:main:main",conversationId:"123",accountId:"default"}
  );
}

test("capsule wizard creates sealed capsule for selected family member", async()=>{
  const fx=fixture();
  try{
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",now:()=>Date.parse("2026-09-17T09:00:00Z")});
    assert.match((await clickUi(runtime,"create:capsules")).text,/кому/i);
    assert.match((await sayUi(runtime,"Мария")).text,/когда/i);
    assert.match((await sayUi(runtime,"20.09 12:00")).text,/сообщ/i);
    const done=await sayUi(runtime,"Открой, когда наступит время");
    assert.match(done.text,/капсул/i);
    const row=fx.db.prepare("SELECT recipient_id AS recipientId,unlock_at AS unlockAt,payload,status FROM capsules").get();
    assert.deepEqual({...row},{recipientId:"participant_beta",unlockAt:"2026-09-20T12:00:00+03:00",payload:"Открой, когда наступит время",status:"sealed"});
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM outbox WHERE kind='capsule_unlock'").get().c,1);
  }finally{cleanup(fx)}
});



test("capsule wizard survives production session normalization and understands «Мария»", async()=>{
  const fx=fixture();
  try{
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",now:()=>Date.parse("2026-09-17T09:00:00Z")});
    assert.match((await clickUi(runtime,"create:capsules")).text,/кому/i);
    const recipient=await runtime.beforeDispatch(
      {content:"Мария",channel:"telegram"},
      {sessionKey:"agent:main:main",conversationId:"111",accountId:"default"}
    );
    assert.equal(recipient.handled,true);
    assert.match(recipient.text,/когда/i);
    const date=await runtime.beforeDispatch(
      {content:"20.09 12:00",channel:"telegram"},
      {sessionKey:"agent:main:main",conversationId:"111",accountId:"default"}
    );
    assert.match(date.text,/сообщ/i);
    const done=await runtime.beforeDispatch(
      {content:"Проверка доставки",channel:"telegram"},
      {sessionKey:"agent:main:main",conversationId:"111",accountId:"default"}
    );
    assert.match(done.text,/запечатана/i);
    const row=fx.db.prepare("SELECT recipient_id AS recipientId,status FROM capsules").get();
    assert.deepEqual({...row},{recipientId:"participant_beta",status:"sealed"});
  }finally{cleanup(fx)}
});

test("calendar event wizard creates direct family event without action reminder", async()=>{
  const fx=fixture();
  try{
    const calendar={async listUpcomingEvents(){return []}};
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",calendar,now:()=>Date.parse("2026-09-17T09:00:00Z")});
    assert.match((await clickUi(runtime,"create:calendar")).text,/назван|событ/i);
    assert.match((await sayUi(runtime,"День рождения мамы")).text,/когда/i);
    assert.match((await sayUi(runtime,"21.09")).text,/комментар/i);
    const done=await sayUi(runtime,"Позвонить утром");
    assert.match(done.text,/событ/i);
    const row=fx.db.prepare("SELECT title,start_at AS startAt,description FROM family_events").get();
    assert.deepEqual({...row},{title:"День рождения мамы",startAt:"2026-09-21",description:"Позвонить утром"});
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM outbox WHERE kind='calendar_event_upsert'").get().c,1);
    assert.equal(fx.db.prepare("SELECT count(*) AS c FROM actions").get().c,0);
  }finally{cleanup(fx)}
});

test("capsule author can cancel sealed capsule from item detail with confirmation", async()=>{
  const fx=fixture();
  try{
    const t=tool(fx.db);
    const id=(await act(t,{action:"create_capsule",recipientId:"participant_beta",unlockAt:"2026-09-20T12:00:00+03:00",payload:"Секрет"})).details.value.id;
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main"});
    const detail=await clickUi(runtime,`item:capsules:${id}`);
    assert(detail.buttons.flat().some(b=>b.callback_data===`family:do:cancel:capsules:${id}`));
    const confirm=await clickUi(runtime,`do:cancel:capsules:${id}`);
    assert(confirm.buttons.flat().some(b=>b.callback_data===`family:apply:cancel:capsules:${id}`));
    await clickUi(runtime,`apply:cancel:capsules:${id}`);
    assert.equal(fx.db.prepare("SELECT status FROM capsules WHERE id=?").get(id).status,"cancelled");
  }finally{cleanup(fx)}
});

test("Family Hub calendar event opens from calendar and supports edit/delete UI", async()=>{
  const fx=fixture();
  try{
    const t=tool(fx.db);
    const id=(await act(t,{action:"create_calendar_event",title:"День рождения мамы",startAt:"2026-09-21",description:"Утром"})).details.value.id;
    const calendar={async listUpcomingEvents(){return [{id:"google-1",summary:"День рождения мамы",start:"2026-09-21",allDay:true,entityType:"family_event",entityId:id}]}};
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",calendar,now:()=>Date.parse("2026-09-17T09:00:00Z")});
    const calendarView=await clickUi(runtime,"section:calendar");
    assert(calendarView.buttons.flat().some(b=>b.callback_data===`family:item:calendar:${id}`));
    const detail=await clickUi(runtime,`item:calendar:${id}`);
    assert.match(detail.text,/День рождения мамы/);
    assert(detail.buttons.flat().some(b=>b.callback_data===`family:do:edit:calendar:${id}`));
    assert(detail.buttons.flat().some(b=>b.callback_data===`family:do:delete:calendar:${id}`));

    assert.match((await clickUi(runtime,`do:edit:calendar:${id}`)).text,/название/i);
    await sayUi(runtime,"ДР мамы");
    await sayUi(runtime,"21.09 18:00");
    const edited=await sayUi(runtime,"Вечером");
    assert.match(edited.text,/сохран|событ/i);
    let row=fx.db.prepare("SELECT title,start_at AS startAt,description,status FROM family_events WHERE id=?").get(id);
    assert.deepEqual({...row},{title:"ДР мамы",startAt:"2026-09-21T18:00:00+03:00",description:"Вечером",status:"active"});

    const confirm=await clickUi(runtime,`do:delete:calendar:${id}`);
    assert(confirm.buttons.flat().some(b=>b.callback_data===`family:apply:delete:calendar:${id}`));
    await clickUi(runtime,`apply:delete:calendar:${id}`);
    row=fx.db.prepare("SELECT status FROM family_events WHERE id=?").get(id);
    assert.equal(row.status,"cancelled");
  }finally{cleanup(fx)}
});
