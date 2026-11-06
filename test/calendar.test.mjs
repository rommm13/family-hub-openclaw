import test from "node:test";
import assert from "node:assert/strict";
import * as indexApi from "../dist/index.js";

function parsedArg(args, flag) {
  const i=args.indexOf(flag); assert.ok(i>=0, `missing ${flag}`); return JSON.parse(args[i+1]);
}

test("calendar adapter reuses an event found by Family Hub private properties", async () => {
  const calls=[];
  const run=async args => { calls.push(args); return {items:[{id:"evt-existing",summary:"Купить корм"}]}; };
  const calendar=indexApi.createGwsCalendarAdapter({run,calendarId:"family@example"});
  const result=await calendar.ensureEvent({entityType:"action",entityId:"a1",summary:"Купить корм",from:"2026-09-18",to:"2026-09-19",allDay:true});
  assert.deepEqual(result,{id:"evt-existing",created:false});
  assert.deepEqual(calls[0].slice(0,3),["calendar","events","list"]);
  const p=parsedArg(calls[0],"--params");
  assert.equal(p.calendarId,"family@example");
  assert.deepEqual(p.privateExtendedProperty,["familyHub=true","entityType=action","entityId=a1"]);
});

test("calendar adapter creates one tagged all-day event when none exists", async () => {
  const calls=[];
  const run=async args => { calls.push(args); return args[2]==="list"?{items:[]}:{id:"evt-new"}; };
  const calendar=indexApi.createGwsCalendarAdapter({run,calendarId:"family@example"});
  const result=await calendar.ensureEvent({entityType:"action",entityId:"a1",summary:"Купить корм",from:"2026-09-18",to:"2026-09-19",allDay:true});
  assert.deepEqual(result,{id:"evt-new",created:true});
  assert.deepEqual(calls[1].slice(0,3),["calendar","events","insert"]);
  const p=parsedArg(calls[1],"--params");
  assert.deepEqual(p,{calendarId:"family@example",sendUpdates:"none"});
  const b=parsedArg(calls[1],"--json");
  assert.equal(b.summary,"Купить корм");
  assert.deepEqual(b.start,{date:"2026-09-18"});
  assert.deepEqual(b.end,{date:"2026-09-19"});
  assert.deepEqual(b.extendedProperties.private,{familyHub:"true",entityType:"action",entityId:"a1"});
});

test("calendar adapter updates an existing tagged event without recreating it", async () => {
  const calls=[]; const run=async args => {calls.push(args); return {id:"evt-1"};};
  const calendar=indexApi.createGwsCalendarAdapter({run,calendarId:"family@example"});
  const result=await calendar.updateEvent({eventId:"evt-1",entityType:"action",entityId:"a1",summary:"✅ Купить корм",from:"2026-09-18",to:"2026-09-19",allDay:true});
  assert.deepEqual(result,{id:"evt-1"});
  assert.deepEqual(calls[0].slice(0,3),["calendar","events","patch"]);
  const p=parsedArg(calls[0],"--params"); assert.equal(p.eventId,"evt-1"); assert.equal(p.calendarId,"family@example");
  const b=parsedArg(calls[0],"--json"); assert.equal(b.summary,"✅ Купить корм");
});

test("calendar adapter lists only upcoming Family calendar events in chronological order", async () => {
  const calls=[];
  const run=async args=>{calls.push(args);return {items:[
    {id:"past",summary:"Прошлое",start:{dateTime:"2026-09-16T18:00:00Z"}},
    {id:"all",summary:"Годовщина",start:{date:"2026-09-18"}},
    {id:"timed",summary:"Семейный ужин",start:{dateTime:"2026-09-17T16:30:00Z"}},
    {id:"cancelled",summary:"Отмена",status:"cancelled",start:{dateTime:"2026-09-17T12:00:00Z"}}
  ]};};
  const calendar=indexApi.createGwsCalendarAdapter({run,calendarId:"family@example"});
  const events=await calendar.listUpcomingEvents({from:"2026-09-16T20:00:00.000Z",max:10});
  assert.deepEqual(events,[
    {id:"timed",summary:"Семейный ужин",start:"2026-09-17T16:30:00Z",allDay:false},
    {id:"all",summary:"Годовщина",start:"2026-09-18",allDay:true}
  ]);
  const p=parsedArg(calls[0],"--params");
  assert.equal(p.calendarId,"family@example"); assert.equal(p.timeMin,"2026-09-16T20:00:00.000Z"); assert.equal(p.maxResults,10); assert.equal(p.orderBy,"startTime");
});

test("GWS calendar adapter deletes event with explicit writable output", async () => {
  const calls = [];
  const run = async args => { calls.push(args); return { status: "success" }; };
  const calendar = indexApi.createGwsCalendarAdapter({ run, calendarId: "family-cal" });
  const result = await calendar.deleteEvent({ eventId: "evt-delete" });
  assert.deepEqual(result, { id: "evt-delete", deleted: true });
  const args = calls.at(-1);
  assert.deepEqual(args.slice(0, 3), ["calendar", "events", "delete"]);
  const params = JSON.parse(args[args.indexOf("--params") + 1]);
  assert.equal(params.calendarId, "family-cal");
  assert.equal(params.eventId, "evt-delete");
  const outputIndex = args.indexOf("--output");
  assert(outputIndex > -1);
  assert.match(args[outputIndex + 1], /family-gws-delete/);
});
