import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {openFamilyDb,bootstrapFamily} from '../dist/db.js';
import {executeFamilyAction} from '../dist/tool.js';
import {setupExtras,listEntries,countEntries,markSeen,updateMeta,photoUpload,photoGet,photoDelete} from './extras.mjs';
import {createMiniCalendarSync} from './calendar-sync.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-extras-'));
const db=openFamilyDb(path.join(dir,'test.sqlite'));
const participant_alpha={id:'participant_alpha',name:'Ivan',role:'parent',householdId:'h'},participant_beta={id:'participant_beta',name:'Maria',role:'parent',householdId:'h'};
let checked=0;
function check(name,fn){fn();checked++;console.log('PASS',name);}
try{
 bootstrapFamily(db,{household:{id:'h',name:'Family'},members:[{id:'participant_alpha',name:'Ivan',role:'parent'},{id:'participant_beta',name:'Maria',role:'parent'}],bindings:[{runtimeId:'agent_core',agentId:'main',memberId:'participant_alpha'},{runtimeId:'agent_core',agentId:'agent_second',memberId:'participant_beta'}]});
 setupExtras(db);
 const value=executeFamilyAction({db,member:participant_beta,actionKey:'test:place:1',params:{action:'create_place',title:'Молочная кухня',comment:'Заехать вместе'}}).details.value;
 check('Maria-created place is shared',()=>{assert.equal(listEntries(db,'places',participant_alpha)[0].name,'Молочная кухня');});
 check('unread counter begins +1',()=>{assert.deepEqual(countEntries(db,'places',participant_alpha),{total:1,unread:1,archived:0});});
 markSeen(db,'places',[value.id],participant_alpha);
 check('read counter becomes 1 with no unread',()=>{assert.deepEqual(countEntries(db,'places',participant_alpha),{total:1,unread:0,archived:0});});
 const media=Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(300,42)]).toString('base64');
 const photo=photoUpload(db,participant_beta,{placeId:value.id,mime:'image/jpeg',data:media},path.join(dir,'media'));
 check('photo attached to Maria place',()=>{assert.equal(listEntries(db,'places',participant_alpha)[0]._photos.length,1);assert.equal(photoGet(db,participant_alpha,photo.id,path.join(dir,'media')).data,media);});
 check('new photo makes place unread again',()=>{assert.equal(countEntries(db,'places',participant_alpha).unread,1);});
 check('unknown place cannot receive an image',()=>{assert.throws(()=>photoUpload(db,participant_alpha,{placeId:'bad',mime:'image/jpeg',data:media},path.join(dir,'media')));});
 check('photo deletion removes attachment',()=>{photoDelete(db,participant_alpha,photo.id,path.join(dir,'media'));assert.equal(listEntries(db,'places',participant_alpha)[0]._photos.length,0);});
 check('dual entityId and placeId are rejected',()=>{assert.throws(()=>photoUpload(db,participant_alpha,{entityId:value.id,placeId:value.id,mime:'image/jpeg',data:media},path.join(dir,'media')));});
 check('DB filename traversal cannot be read or deleted',()=>{
  const outside=path.join(dir,'outside.jpg');
  fs.writeFileSync(outside,'sentinel');
  const badId='00000000-0000-4000-8000-000000000001';
  db.prepare('INSERT INTO miniapp_photos(id,section,entity_id,household_id,uploader_id,mime,file_name) VALUES(?,?,?,?,?,?,?)')
   .run(badId,'places',value.id,'h','participant_alpha','image/jpeg','../outside.jpg');
  assert.throws(()=>photoGet(db,participant_alpha,badId,path.join(dir,'media')));
  assert.throws(()=>photoDelete(db,participant_alpha,badId,path.join(dir,'media')));
  assert.equal(fs.readFileSync(outside,'utf8'),'sentinel');
  assert.ok(db.prepare('SELECT 1 FROM miniapp_photos WHERE id=?').get(badId));
  db.prepare('DELETE FROM miniapp_photos WHERE id=?').run(badId);
 });
 const stored=updateMeta(db,'places',value.id,participant_beta,{dueAt:'2027-07-01'});
 check('dated place remains active',()=>{assert.equal(stored.dueAt,'2027-07-01');assert.equal(countEntries(db,'places',participant_alpha).total,1);});
 updateMeta(db,'places',value.id,participant_beta,{archive:true});
 check('manual archive has separate view',()=>{assert.equal(countEntries(db,'places',participant_alpha).total,0);assert.equal(countEntries(db,'places',participant_alpha).archived,1);assert.equal(listEntries(db,'places',participant_alpha,{archive:true})[0].id,value.id);});
 updateMeta(db,'places',value.id,participant_beta,{restore:true,dueAt:'2024-10-01'});
 check('expired date moves to archive automatically',()=>{assert.equal(countEntries(db,'places',participant_alpha).archived,1);});
 updateMeta(db,'places',value.id,participant_beta,{restore:true,dueAt:'2027-09-01'});
 const generated=[],patched=[],deleted=[];
 const calendar={ensureEvent:async data=>{generated.push(data);return {id:'google-'+generated.length,created:true};},updateEvent:async data=>{patched.push(data);return {id:data.eventId};},deleteEvent:async data=>{deleted.push(data);return {deleted:true};}};
 const sync=createMiniCalendarSync({db,calendarId:'family@test',calendar});
 sync.queue('places',value.id,'h');
 let outcome=await sync.flush();
 check('dated place goes to family calendar',()=>{assert.equal(outcome.failed,0);assert.equal(generated.length,1);assert.equal(generated[0].allDay,true);assert.equal(generated[0].summary,'📍 Молочная кухня');});
 check('Google Calendar event includes clickable Google Maps search link and original note',()=>{
  assert(generated[0].description.includes('https://www.google.com/maps/search/?'));
  assert(generated[0].description.includes('query=%D0%9C%D0%BE%D0%BB%D0%BE%D1%87%D0%BD%D0%B0%D1%8F'));
  assert(generated[0].description.includes('Заехать вместе'));
  assert(generated[0].description.includes('адрес не указан'));
 });
 updateMeta(db,'places',value.id,participant_beta,{dueAt:'2027-09-17'});sync.queue('places',value.id,'h');outcome=await sync.flush();
 check('editing date updates existing family calendar event',()=>{assert.equal(outcome.failed,0);assert.equal(patched.length,1);assert.equal(patched[0].from,'2027-09-17');});
 db.prepare('UPDATE places SET maps_url=? WHERE id=?').run('https://maps.google.com/?q=test-place',value.id);
 sync.queue('places',value.id,'h');await sync.flush();
 check('exact saved map URL replaces search link on calendar update',()=>{
  assert.equal(patched.at(-1).description.includes('https://maps.google.com/?q=test-place'),true);
  assert(!patched.at(-1).description.includes('адрес не указан'));
 });
 updateMeta(db,'places',value.id,participant_beta,{dueAt:''});sync.queue('places',value.id,'h');await sync.flush();
 check('removing date removes calendar event',()=>{assert.equal(deleted.length,1);});
 const goal=executeFamilyAction({db,member:participant_alpha,actionKey:'test:goal:1',params:{action:'create_goal',title:'На отпуск',amount:25000,currency:'RUB',dueAt:'2027-09-30'}}).details.value;
 sync.scan('h');await sync.flush();
 check('bot-created dated goal discovered for calendar',()=>{assert(generated.some(x=>x.summary.includes('На отпуск')));});
 const capsule=executeFamilyAction({db,member:participant_alpha,actionKey:'test:capsule:1',params:{action:'create_capsule',recipientId:'participant_beta',unlockAt:'2027-11-01T19:00:00+03:00',payload:'Секретная записка'}}).details.value;
 sync.scan('h');await sync.flush();
 check('capsule sync does not reveal message',()=>{assert(generated.some(x=>x.entityType==='capsule' && x.summary.includes('капсулу')));assert(!generated.some(x=>JSON.stringify(x).includes('Секретная записка')));});
 const privateNote=executeFamilyAction({db,member:participant_alpha,actionKey:'test:note:1',params:{action:'create_note',title:'Личное',body:'Только мне',visibility:'owner'}}).details.value;
 updateMeta(db,'notes',privateNote.id,participant_alpha,{dueAt:'2027-09-01'});sync.queue('notes',privateNote.id,'h');await sync.flush();
 check('private notes stay out of shared calendar',()=>{assert(!generated.some(x=>x.summary.includes('Личное')));});
 const auto=executeFamilyAction({db,member:participant_beta,actionKey:'test:place:date-comment',params:{action:'create_place',title:'Молочная кухня 2',comment:'14 ноября 2026'}}).details.value;
 sync.scan('h');await sync.flush();
 check('Russian date in place comment becomes calendar date',()=>{
  const meta=db.prepare('SELECT due_at AS dueAt FROM miniapp_meta WHERE section=? AND entity_id=?').get('places',auto.id);
  assert.equal(meta?.dueAt,'2026-11-14');
  assert(generated.some(x=>x.entityId===auto.id&&x.from==='2026-11-14'));
 });
 updateMeta(db,'places',auto.id,participant_beta,{dueAt:''});sync.queue('places',auto.id,'h');await sync.flush();
 sync.scan('h');
 check('explicitly removed date is not silently reimported',()=>{
  assert.equal(db.prepare('SELECT due_at AS dueAt FROM miniapp_meta WHERE section=? AND entity_id=?').get('places',auto.id).dueAt,null);
 });
 sync.close();
 console.log('EXTRAS AUDIT:',checked,'passed; no production changes');
}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
