import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {openFamilyDb,bootstrapFamily} from '../dist/db.js';
import {executeFamilyAction} from '../dist/tool.js';
import {setupExtras,photoUpload,photoGet,photoDelete,updateMeta,listEntries} from './extras.mjs';
import {createMiniCalendarSync} from './calendar-sync.mjs';
import {createPhotoCalendarSync} from './photo-calendar.mjs';
const root=mkdtempSync(join(tmpdir(),'fh-attach-audit-'));
const db=openFamilyDb(join(root,'db.sqlite'));
const imageDir=join(root,'photos');
let success=0;
const check=(name,fn)=>{fn();success++;console.log('PASS',name);};
const members=[{id:'participant_alpha',name:'Иван',role:'parent',householdId:'h'},{id:'participant_beta',name:'Мария',role:'parent',householdId:'h'}];
const fakeDrive=new Map(),fakeEvents=new Map();let uploaded=0,patches=0,deleted=0;
const googleRun=async args=>{
 const id=args[0]+'/'+args[1]+'/'+args[2],paramsIndex=args.indexOf('--params'),params=paramsIndex<0?{}:JSON.parse(args[paramsIndex+1]);
 const jsonIndex=args.indexOf('--json'),body=jsonIndex<0?{}:JSON.parse(args[jsonIndex+1]);
 if(id==='drive/files/create'){
  assert(args.includes('--upload'));assert.equal(body.parents[0],'family-private-folder');
  const fileId='file-'+String(++uploaded).padStart(4,'0');fakeDrive.set(fileId,body);return {id:fileId,mimeType:'image/jpeg'};
 }
 if(id==='drive/files/delete'){fakeDrive.delete(params.fileId);deleted++;return {};}
 if(id==='drive/files/get'){if(!fakeDrive.has(params.fileId))throw Error('404 not found');return {id:params.fileId};}
 if(id==='calendar/events/get')return fakeEvents.get(params.eventId);
 if(id==='calendar/events/patch'){
  assert.equal(params.supportsAttachments,true);
  const row=fakeEvents.get(params.eventId);row.attachments=body.attachments;patches++;return row;
 }
 throw Error('Unsupported test Google operation: '+id);
};
try{
 bootstrapFamily(db,{household:{id:'h',name:'Family'},members:members.map(({id,name,role})=>({id,name,role})),bindings:[{runtimeId:'agent_core',agentId:'main',memberId:'participant_alpha'},{runtimeId:'agent_core',agentId:'agent_second',memberId:'participant_beta'}]});
 setupExtras(db);
 const plan=executeFamilyAction({db,member:members[1],actionKey:'photo-test:plan',params:{action:'create_plan',title:'Фото семейного отпуска',comment:'Вместе',participants:['participant_alpha','participant_beta']}}).details.value;
 updateMeta(db,'plans',plan.id,members[1],{dueAt:'2027-05-01'});
 const bridge=createPhotoCalendarSync({db,imageDir,calendarId:'family@test',driveFolderId:'family-private-folder',run:googleRun,logger:{warn(){}}});
 const mime='image/jpeg';const data=Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(500,32)]).toString('base64');
 const first=photoUpload(db,members[1],{section:'plans',entityId:plan.id,mime,data},imageDir);
 check('photo attached to plan created by Maria',()=>{assert.equal(listEntries(db,'plans',members[0])[0]._photos.length,1);});
 check('Ivan can read family plan photo',()=>{assert.equal(photoGet(db,members[0],first.id,imageDir).data,data);});
 const waiting=await bridge.flush();
 check('photo waits for an actual calendar event, no duplicate created',()=>{assert.equal(waiting.waiting,1);assert.equal(uploaded,0);});
 const calendar=createMiniCalendarSync({db,calendarId:'family@test',logger:{warn(){}},calendar:{
  async ensureEvent({entityId}){const eventId='event-'+entityId;fakeEvents.set(eventId,{id:eventId,attachments:[{fileId:'original-unrelated-file',title:'Custom attachment',fileUrl:'https://drive.google.com/anything'}]});return {id:eventId,created:true};},
  async updateEvent(){return {};},async deleteEvent(){return {};
  }},onEventSynced:(section,id,h)=>bridge.queue(section,id,h)});
 calendar.queue('plans',plan.id,'h');const v=await calendar.flush();
 check('original date sync creates only one Google event',()=>{assert.equal(v.failed,0);assert.equal(fakeEvents.size,1);});
 const applied=await bridge.flush();
 check('image uploaded into private family folder and attached to calendar',()=>{
  assert.equal(applied.failed,0);assert.equal(uploaded,1);assert.equal(patches,1);
  const event=[...fakeEvents.values()][0];assert.equal(event.attachments.length,2);
  assert(event.attachments.some(a=>a.fileId==='file-0001'));
  assert(event.attachments.some(a=>a.fileId==='original-unrelated-file'));
 });
 const second=photoUpload(db,members[0],{section:'plans',entityId:plan.id,mime,data},imageDir);
 await bridge.flush();
 check('second image attached to same calendar event, no duplicate',()=>{
  assert.equal(fakeEvents.size,1);assert.equal(uploaded,2);assert.equal(fakeEvents.values().next().value.attachments.length,3);
 });
 photoDelete(db,members[1],first.id,imageDir);
 await bridge.flush();
 check('deleting first photo removes attachment from calendar and Drive',()=>{
  const attached=fakeEvents.values().next().value.attachments;
  assert.equal(attached.length,2);assert(attached.some(a=>a.fileId==='original-unrelated-file'));assert(attached.some(a=>a.fileId==='file-0002'));
  assert.equal(deleted,1);assert.equal(fakeDrive.has('file-0001'),false);
  assert.equal(listEntries(db,'plans',members[1])[0]._photos.length,1);
 });
 const personal=executeFamilyAction({db,member:members[0],actionKey:'photo-test:private',params:{action:'create_note',title:'Private',body:'Only Ivan',visibility:'owner'}}).details.value;
 const secret=photoUpload(db,members[0],{section:'notes',entityId:personal.id,mime,data},imageDir);
 check('private note photo cannot be retrieved by Maria',()=>assert.throws(()=>photoGet(db,members[1],secret.id,imageDir)));
 check('private note image is not uploaded to shared Google Drive',()=>assert.equal(uploaded,2));
 check('unrelated sections and unknown IDs cannot attach photos',()=>{
  assert.throws(()=>photoUpload(db,members[0],{section:'cashback',entityId:'x',mime,data},imageDir));
  assert.throws(()=>photoUpload(db,members[0],{section:'plans',entityId:'missing',mime,data},imageDir));
 });
 bridge.close();calendar.close();
 console.log('PHOTO CALENDAR AUDIT:',success,'passed; simulated Google Drive + Calendar; temp database removed');
}finally{db.close();rmSync(root,{recursive:true,force:true});}
