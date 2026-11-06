import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { executeFamilyAction } from "../dist/tool.js";

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"family-tz-guard-"));
  const db=openFamilyDb(path.join(dir,"family.sqlite"));
  bootstrapFamily(db,{
    household:{id:"home",name:"Семья"},
    members:[{id:"participant_alpha",name:"Иван",role:"parent"}],
    bindings:[{runtimeId:"agent_core",agentId:"main",memberId:"participant_alpha"}]
  });
  return {dir,db,member:{id:"participant_alpha",name:"Иван",householdId:"home"}};
}
function cleanup(fx){fx.db.close();fs.rmSync(fx.dir,{recursive:true,force:true});}

test("family calendar rejects Z for user wall-clock timestamps",()=>{
  const fx=fixture();
  try{
    assert.throws(()=>executeFamilyAction({
      db:fx.db,member:fx.member,actionKey:"tz-z",
      params:{action:"create_calendar_event",title:"Тест",startAt:"2026-09-18T14:55:00Z"}
    }),/numeric timezone offset.*not Z/i);
  } finally { cleanup(fx); }
});

test("family calendar accepts explicit Moscow numeric offset",()=>{
  const fx=fixture();
  try{
    const r=executeFamilyAction({
      db:fx.db,member:fx.member,actionKey:"tz-msk",
      params:{action:"create_calendar_event",title:"Тест",startAt:"2026-09-18T14:55:00+03:00"}
    }).details;
    const row=fx.db.prepare("select start_at as startAt from family_events where id=?").get(r.value.id);
    assert.equal(row.startAt,"2026-09-18T14:55:00+03:00");
  } finally { cleanup(fx); }
});

test("family calendar update also rejects ambiguous or Z timestamps",()=>{
  const fx=fixture();
  try{
    const created=executeFamilyAction({
      db:fx.db,member:fx.member,actionKey:"tz-create",
      params:{action:"create_calendar_event",title:"Тест",startAt:"2026-09-18T14:55:00+03:00"}
    }).details.value.id;
    assert.throws(()=>executeFamilyAction({
      db:fx.db,member:fx.member,actionKey:"tz-update-z",
      params:{action:"update_calendar_event",calendarEventId:created,startAt:"2026-09-18T16:00:00Z"}
    }),/numeric timezone offset.*not Z/i);
    assert.throws(()=>executeFamilyAction({
      db:fx.db,member:fx.member,actionKey:"tz-update-naive",
      params:{action:"update_calendar_event",calendarEventId:created,startAt:"2026-09-18T16:00:00"}
    }),/explicit numeric timezone offset/i);
  } finally { cleanup(fx); }
});
