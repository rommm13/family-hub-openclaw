import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { createFamilyCalendarEvent } from "../dist/domain.js";

function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"family-reconcile-"));
 const db=openFamilyDb(path.join(dir,"family.sqlite"));
 bootstrapFamily(db,{household:{id:"home",name:"Семья"},members:[{id:"participant_alpha",name:"Иван",role:"parent"}],bindings:[{runtimeId:"agent_core",agentId:"main",memberId:"participant_alpha"}]});
 return {dir,db};
}
function cleanup(fx){fx.db.close();fs.rmSync(fx.dir,{recursive:true,force:true});}

test("calendar reconciliation adopts remote edits for direct Family events", async()=>{
 const fx=fixture();
 try{
  const local=createFamilyCalendarEvent(fx.db,{householdId:"home",createdBy:"participant_alpha",title:"Старое",startAt:"2026-09-21",description:"до"});
  fx.db.prepare("UPDATE family_events SET google_event_id='g1' WHERE id=?").run(local.id);
  const {reconcileFamilyCalendarEvents}=await import("../dist/calendar.js");
  const calendar={async getEvent(){return {id:"g1",summary:"Новое",start:"2026-09-22",end:"2026-09-23",allDay:true,description:"после",entityType:"family_event",entityId:local.id}}};
  const result=await reconcileFamilyCalendarEvents({db:fx.db,calendar,calendarId:"family-cal",from:"2026-09-18",to:"2027-09-18"});
  assert.equal(result.updated,1);
  const row=fx.db.prepare("SELECT title,start_at AS startAt,end_at AS endAt,description,status FROM family_events WHERE id=?").get(local.id);
  assert.deepEqual({...row},{title:"Новое",startAt:"2026-09-22",endAt:"2026-09-23",description:"после",status:"active"});
 }finally{cleanup(fx)}
});

test("calendar reconciliation marks a remotely deleted direct event", async()=>{
 const fx=fixture();
 try{
  const local=createFamilyCalendarEvent(fx.db,{householdId:"home",createdBy:"participant_alpha",title:"Удалено",startAt:"2026-09-21"});
  fx.db.prepare("UPDATE family_events SET google_event_id='gone' WHERE id=?").run(local.id);
  const {reconcileFamilyCalendarEvents}=await import("../dist/calendar.js");
  const calendar={async getEvent(){return null}};
  const result=await reconcileFamilyCalendarEvents({db:fx.db,calendar,calendarId:"family-cal",from:"2026-09-18",to:"2027-09-18"});
  assert.equal(result.deleted,1);
  assert.equal(fx.db.prepare("SELECT status FROM family_events WHERE id=?").get(local.id).status,"cancelled");
  assert.equal(fx.db.prepare("SELECT sync_status AS status FROM calendar_links WHERE entity_type='family_event' AND entity_id=?").get(local.id).status,"deleted_remote");
 }finally{cleanup(fx)}
});

test("stale Google event id is recreated idempotently after 404", async()=>{
 const fx=fixture();
 try{
  const local=createFamilyCalendarEvent(fx.db,{householdId:"home",createdBy:"participant_alpha",title:"Событие",startAt:"2026-09-21"});
  fx.db.prepare("UPDATE family_events SET google_event_id='old' WHERE id=?").run(local.id);
  const {syncFamilyEventCalendar}=await import("../dist/calendar.js");
  const error=Object.assign(new Error("404 Not Found"),{code:404});
  const calls=[];
  const calendar={
    async updateEvent(){calls.push("update");throw error},
    async ensureEvent(){calls.push("ensure");return {id:"new",created:true}}
  };
  const result=await syncFamilyEventCalendar({db:fx.db,calendar,calendarId:"family-cal",eventId:local.id});
  assert.equal(result.eventId,"new");
  assert.deepEqual(calls,["update","ensure"]);
  assert.equal(fx.db.prepare("SELECT google_event_id AS id FROM family_events WHERE id=?").get(local.id).id,"new");
 }finally{cleanup(fx)}
});
