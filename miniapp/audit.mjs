import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {openFamilyDb,bootstrapFamily,upsertMemberRoute} from '../dist/db.js';
import {familyMiniapp} from './api.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-miniapp-audit-'));
const file=path.join(dir,'db.sqlite'),images=path.join(dir,'images');fs.mkdirSync(images);
const db=openFamilyDb(file);
bootstrapFamily(db,{household:{id:'h',name:'Audit household'},members:[{id:'one',name:'One',role:'parent'},{id:'two',name:'Two',role:'parent'}],bindings:[{runtimeId:'agent_core',agentId:'main',memberId:'one'},{runtimeId:'agent_core',agentId:'agent_second',memberId:'two'}]});
upsertMemberRoute(db,'one',{runtimeId:'agent_core',agentId:'main',channel:'telegram',accountId:'default',to:'telegram:123456'});
upsertMemberRoute(db,'two',{runtimeId:'agent_core',agentId:'agent_second',channel:'telegram',accountId:'agent_second',to:'telegram:654321'});
db.close();
const accounts={default:'not-a-real-bot-token-A',agent_second:'not-a-real-bot-token-B'};
let sentMedia=0;let fails=0,passes=0;const failures=[];
const app=familyMiniapp({dbPath:file,appUrl:'https://family.example.invalid/family-app/',accountToken:id=>accounts[id],surpriseAssetDir:images,sendMedia:async()=>{sentMedia++;},logger:{warn:()=>{}}});
function initData(id,account='default',stamp=Math.floor(Date.now()/1000)){
 const values=new URLSearchParams({auth_date:String(stamp),user:JSON.stringify({id,first_name:'Audit'}),signature:'synthetic-telegram-signature'});
 const secret=createHmac('sha256','WebAppData').update(accounts[account]).digest();
 const line=[...values].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 values.set('hash',createHmac('sha256',secret).update(line).digest('hex'));
 return values.toString();
}
const users={one:initData(123456),two:initData(654321,'agent_second')};
async function req(payload,method='POST',url='/family-app/api'){
 const body=JSON.stringify(payload);const stream=Readable.from(method==='POST'?[Buffer.from(body)]:[]);
 stream.method=method;stream.url=url;stream.headers={'content-type':'application/json','origin':'https://family.example.invalid'}; let status=0,headers={},data='';const res={writeHead:(s,h)=>{status=s;headers=h||{};},end:value=>data=String(value||'')};
 await app.handle(stream,res);
 try{return {status,headers,data:JSON.parse(data)};}catch{return {status,headers,text:data};}
}
async function send(member,action,fields={},actionId=randomUUID()){return req({initData:users[member],kind:'action',params:{action,...fields},actionId});}
async function list(member,section,archive=false){const out=await req({initData:users[member],kind:'list',section,archive});assert.equal(out.status,200,`${member} list ${section}: ${out.data?.error}`);return out.data.items;}
async function ok(name,run){try{await run();passes++;console.log('PASS',name);}catch(e){fails++;failures.push({name,error:e.message});console.log('FAIL',name,e.message);}}
await ok('both users authenticate',async()=>{assert.equal((await req({kind:'bootstrap',initData:users.one})).data.member.id,'one');assert.equal((await req({kind:'bootstrap',initData:users.two})).data.member.id,'two');});
await ok('invalid/cross-account/expired authentication rejected',async()=>{
 for(const value of ['',initData(123456,'agent_second'),initData(123456,'default',1),users.one.slice(0,-4)+'AAAA']){
  assert.equal((await req({kind:'bootstrap',initData:value})).status,401);
 }
});
await ok('unauthenticated API and unknown routes rejected',async()=>{assert.equal((await req({kind:'list',section:'cashback'})).status,401);assert.equal((await req({initData:users.one,kind:'list',section:'unknown'})).status,400);assert.equal((await req({initData:users.one},'GET','/family-app/health')).status,200);});
await ok('all existing sections load for each member',async()=>{
 for(const member of ['one','two'])for(const section of ['calendar','shopping','actions','notes','plans','wishes','polls','capsules','cashback','places','goals'])assert(Array.isArray(await list(member,section)));
});
await ok('cashback saved, visible to both, edited in place',async()=>{
 const body='Т-Банк\n• 1% все\n\nСбер\n• 5% АЗС';
 assert.equal((await send('one','set_cashback',{cashbackYear:2026,cashbackMonth:10,cashbackTitle:'Кэшбэк октябрь',cashbackBody:body})).data.ok,true);
 assert.equal((await list('one','cashback')).length,1);assert.equal((await list('two','cashback'))[0].body,body);
 assert.equal((await send('two','set_cashback',{cashbackYear:2026,cashbackMonth:10,cashbackTitle:'Кэшбэк октябрь',cashbackBody:'Обновлено'})).data.ok,true);
 assert.equal((await list('one','cashback')).length,1);assert.equal((await list('one','cashback'))[0].body,'Обновлено');
});
await ok('shopping create, idempotence, toggle and clear',async()=>{
 const op=randomUUID();const data={items:['Молоко','Кофе']};
 assert.equal((await send('one','add_shopping_items',data,op)).data.ok,true);
 assert.equal((await send('one','add_shopping_items',data,op)).data.duplicate,true);
 const items=await list('one','shopping');assert.equal(items.length,2);
 assert.equal((await send('two','toggle_shopping_item',{shoppingItemId:items[0].id})).data.ok,true);
 assert.equal((await list('one','shopping',true)).filter(x=>x.checked).length,1);
 assert.equal((await send('one','clear_bought_shopping')).data.ok,true);
 assert.equal((await list('two','shopping')).length,1);
});
await ok('notes CRUD and private-note visibility',async()=>{
 let r=await send('one','create_note',{title:'Personal',body:'Do not share',visibility:'owner'});assert.equal(r.data.ok,true);
 assert.equal((await list('two','notes')).length,0);
 const row=(await list('one','notes'))[0];r=await send('one','update_note',{noteId:row.id,title:'Updated',body:'Private edit',expectedRevision:row.revision});assert.equal(r.data.ok,true);
 assert.equal((await list('one','notes'))[0].title,'Updated');assert.equal((await send('one','delete_note',{noteId:row.id})).data.ok,true);
 assert.equal((await list('one','notes')).length,0);
 const pub=await send('one','create_note',{title:'Family',body:'For both',visibility:'household'});assert.equal(pub.data.ok,true);
 assert.equal((await list('two','notes'))[0].title,'Family');
});
await ok('actions due-date guard and lifecycle',async()=>{
 assert.equal((await send('one','create_action',{title:'No date'})).data.needsDate,true);
 const created=await send('one','create_action',{title:'Family task',dueAt:'2027-04-01',assigneeId:'two'});assert.equal(created.data.ok,true);
 const id=(await list('two','actions'))[0].id;
 assert.equal((await send('two','update_action',{actionId:id,title:'Task updated'})).data.ok,true);
 assert.equal((await list('one','actions'))[0].title,'Task updated');
 assert.equal((await send('two','complete_action',{actionId:id})).data.ok,true);
 assert.equal((await list('one','actions')).length,0);
});
await ok('plans create/update/archive',async()=>{
 const created=await send('one','create_plan',{title:'Summer',comment:'Together',participants:['one','two']});assert.equal(created.data.ok,true);
 const id=(await list('two','plans'))[0].id;
 assert.equal((await send('one','update_plan',{planId:id,title:'Autumn'})).data.ok,true);
 assert.equal((await list('two','plans'))[0].title,'Autumn');
 assert.equal((await send('one','archive_plan',{planId:id})).data.ok,true);
 assert.equal((await list('one','plans')).length,0);
});
await ok('wishes owner permissions, reservation privacy',async()=>{
 let created=await send('one','create_wish',{title:'Book',targetPrice:900});assert.equal(created.data.ok,true);
 const w=(await list('one','wishes'))[0];assert.equal((await list('two','wishes'))[0].title,'Book');
 assert.equal((await send('two','reserve_wish',{wishId:w.id})).data.ok,true);
 assert.equal((await list('two','wishes'))[0].reservedBy,'two');
 assert.equal((await list('one','wishes'))[0].reservedBy,null);
 assert.equal((await send('two','update_wish',{wishId:w.id,title:'Not allowed'})).status,400);
 assert.equal((await send('one','remove_wish',{wishId:w.id})).data.ok,true);
 assert.equal((await list('two','wishes')).length,0);
});
await ok('polls create, vote, close',async()=>{
 const created=await send('one','create_poll',{question:'Choose?',options:['A','B'],participants:['one','two']});assert.equal(created.data.ok,true);
 const id=(await list('two','polls'))[0].id;
 assert.equal((await send('two','get_poll',{pollId:id})).data.item.options.length,2);
 assert.equal((await send('two','vote_poll',{pollId:id,optionIndex:1})).data.ok,true);
 assert.equal((await send('one','close_poll',{pollId:id})).data.ok,true);
 assert.equal((await send('two','vote_poll',{pollId:id,optionIndex:0})).status,400);
});
await ok('places create, update, delete',async()=>{
 const created=await send('one','create_place',{title:'Somewhere',comment:'Go together'});assert.equal(created.data.ok,true);
 const id=(await list('two','places'))[0].id;
 assert.equal((await send('one','update_place',{familyPlaceId:id,title:'Elsewhere'})).data.ok,true);
 assert.equal((await list('two','places'))[0].name,'Elsewhere');
 assert.equal((await send('one','delete_place',{familyPlaceId:id})).data.ok,true);
 assert.equal((await list('two','places')).length,0);
});
await ok('goals create, edit, complete',async()=>{
 const created=await send('one','create_goal',{title:'Holiday',amount:20000,dueAt:'2027-05-01',assigneeId:'one'});assert.equal(created.data.ok,true);
 const id=(await list('one','goals'))[0].id;
 assert.equal((await send('one','update_goal',{goalId:id,title:'Holiday 2',amount:30000})).data.ok,true);
 assert.equal((await list('one','goals'))[0].amount,30000);
 assert.equal((await send('one','complete_goal',{goalId:id})).data.ok,true);
 assert.equal((await list('one','goals')).length,0);
});
await ok('calendar create/read/edit/cancel and queued synchronization',async()=>{
 const created=await send('one','create_calendar_event',{title:'Event',startAt:'2027-03-01T19:00:00+03:00',description:'Our event'});assert.equal(created.data.ok,true);
 const rows=await list('two','calendar');assert.equal(rows.length,1);assert.equal(rows[0].entityType,'family_event');
 const id=rows[0].entityId;
 assert.equal((await send('one','update_calendar_event',{calendarEventId:id,title:'Changed event'})).data.ok,true);
 assert.equal((await list('one','calendar'))[0].summary,'Changed event');
 assert.equal((await send('one','delete_calendar_event',{calendarEventId:id})).data.ok,true);
 assert.equal((await list('two','calendar')).length,0);
});
await ok('capsules created sealed, receiver privacy, cancellation',async()=>{
 const created=await send('one','create_capsule',{recipientId:'two',unlockAt:'2027-12-12T12:00:00+03:00',payload:'Hidden until future'});assert.equal(created.data.ok,true);
 const row=(await list('two','capsules'))[0];assert.equal(row.payload,null);
 const detail=await send('two','get_capsule',{capsuleId:row.id});assert.equal(detail.data.item.payload,null);
 assert.equal((await send('one','cancel_capsule',{capsuleId:row.id})).data.ok,true);
 assert.equal((await list('two','capsules')).length,0);
});
await ok('surprise sends once and uses existing queue',async()=>{
 fs.writeFileSync(path.join(images,'audit.jpg'),Buffer.from('temporary-audit-image'));
 const x=await req({initData:users.one,kind:'surprise'});assert.equal(x.status,200);assert.equal(x.data.status,'sent');assert.equal(sentMedia,1);
});
await ok('shared Google Calendar blocked after household count becomes ambiguous; local events isolated',async()=>{
  const d2=fs.mkdtempSync(path.join(os.tmpdir(),'family-miniapp-multi-hh-'));
  const f2=path.join(d2,'db.sqlite');
  const db2=openFamilyDb(f2);
  bootstrapFamily(db2,{household:{id:'h1',name:'Household 1'},members:[{id:'a',name:'A',role:'parent'}],bindings:[{runtimeId:'agent_core',agentId:'main',memberId:'a'}]});
  upsertMemberRoute(db2,'a',{runtimeId:'agent_core',agentId:'main',channel:'telegram',accountId:'default',to:'telegram:111001'});
  const now=Date.now();
  db2.prepare("INSERT INTO family_events(id,household_id,created_by,title,start_at,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,'active',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
    .run('ev-h1','h1','a','H1 only event',new Date(now+86400000).toISOString());
  let listCalls=0,syncCalls=0;
  const spyCalendar={
    listUpcomingEvents:async()=>{listCalls++;return [{id:'remote-shared',summary:'REMOTE SHARED',start:new Date(now+3600000).toISOString(),entityType:'external'}];},
    ensureEvent:async()=>{syncCalls++;return {id:'g1',created:true};},
    updateEvent:async()=>{syncCalls++;return {id:'g1'};},
    deleteEvent:async()=>{syncCalls++;return {deleted:true};},
    getEvent:async()=>null,
  };
  const app2=familyMiniapp({db:db2,appUrl:'https://family.example.invalid/family-app/',accountToken:id=>accounts[id],calendarId:'shared@test',calendar:spyCalendar,logger:{warn:()=>{}}});
  const initA=initData(111001,'default');
  async function req2(initData,section,kind='list'){
    const body=JSON.stringify({initData,kind,section});const stream=Readable.from([Buffer.from(body)]);
    stream.method='POST';stream.url='/family-app/api';stream.headers={'content-type':'application/json','origin':'https://family.example.invalid'};
    let status=0,data='';const res={writeHead:s=>{status=s;},end:v=>data=String(v||'')};await app2.handle(stream,res);
    return {status,data:JSON.parse(data)};
  }
  // Single household: remote shared calendar may be listed (spy proves integration active).
  const before=await req2(initA,'calendar');
  assert.equal(before.status,200);
  assert(listCalls>=1,'expected shared calendar list while single-household');
  assert(before.data.items.some(x=>x.summary==='REMOTE SHARED' || x.id==='remote-shared'),'expected remote item while single-household');
  assert(before.data.items.some(x=>(x.summary||x.title)==='H1 only event'));

  // Transition to ambiguous multi-household.
  bootstrapFamily(db2,{household:{id:'h2',name:'Household 2'},members:[{id:'b',name:'B',role:'parent'}],bindings:[{runtimeId:'agent_core',agentId:'agent_second',memberId:'b'}]});
  upsertMemberRoute(db2,'b',{runtimeId:'agent_core',agentId:'agent_second',channel:'telegram',accountId:'agent_second',to:'telegram:222002'});
  db2.prepare("INSERT INTO family_events(id,household_id,created_by,title,start_at,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,'active',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
    .run('ev-h2','h2','b','H2 only event',new Date(now+172800000).toISOString());
  // Queue a dated entry so a naive flush would try to sync; must be blocked.
  db2.prepare("INSERT INTO miniapp_calendar_jobs(section,entity_id,household_id,state,attempts,updated_at) VALUES('places','x-sync','h1','pending',0,CURRENT_TIMESTAMP)").run();
  const listCallsBefore=listCalls,syncCallsBefore=syncCalls;

  const a=await req2(initA,'calendar'), b=await req2(initData(222002,'agent_second'),'calendar');
  assert.equal(a.status,200);assert.equal(b.status,200);
  assert.deepEqual(a.data.items.map(x=>x.summary||x.title),['H1 only event']);
  assert.deepEqual(b.data.items.map(x=>x.summary||x.title),['H2 only event']);
  assert.equal(listCalls,listCallsBefore,'shared calendar list must not be called after multi-household transition');
  const scan=await app2.scanCalendar();
  assert.equal(scan.calendars.blocked,'multi-household');
  assert.equal(scan.attachments.blocked,'multi-household');
  const flushed=await app2.sync.flush({max:5});
  assert.equal(flushed.blocked,'multi-household');
  assert.equal(syncCalls,syncCallsBefore,'shared calendar sync/write must not be called after multi-household transition');
  app2.close();db2.close();fs.rmSync(d2,{recursive:true,force:true});
});
await ok('request throttling after extensive test activity',async()=>{
 assert.equal((await send('one','not_supported_action')).status,400);
 assert([400,429].includes((await send('one','create_note',{title:'bad',body:'x',admin:true})).status));
 let blocked=false;for(let i=0;i<75;i++){const x=await req({initData:users.one,kind:'list',section:'cashback'});if(x.status===429){blocked=true;break;}}assert.equal(blocked,true);
});
try{app.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}
console.log(`AUDIT TOTAL: ${passes} passed; ${fails} failed; temp database removed`);
if(failures.length) {console.log('FAILURES',JSON.stringify(failures));process.exitCode=1;}
