import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {openFamilyDb,bootstrapFamily,upsertMemberRoute} from '../dist/db.js';
import {familyMiniapp} from './api.mjs';
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'family-miniapp-check-'));
const file=path.join(folder,'db.sqlite');
const db=openFamilyDb(file);
bootstrapFamily(db,{household:{id:'h',name:'test'},members:[{id:'one',name:'Member One',role:'parent'},{id:'two',name:'Member Two',role:'parent'}],bindings:[{runtimeId:'agent_core',agentId:'main',memberId:'one'},{runtimeId:'agent_core',agentId:'agent_second',memberId:'two'}]});
upsertMemberRoute(db,'one',{runtimeId:'agent_core',agentId:'main',channel:'telegram',accountId:'default',to:'telegram:123456'});
upsertMemberRoute(db,'two',{runtimeId:'agent_core',agentId:'agent_second',channel:'telegram',accountId:'agent_second',to:'telegram:654321'});
db.close();
const tokens={default:'test-token-a',agent_second:'test-token-b'};
const app=familyMiniapp({dbPath:file,appUrl:'https://family.example.invalid/family-app/',accountToken:id=>tokens[id],surpriseAssetDir:folder,placePhotoDir:path.join(folder,'place-photos'),aiShopping:async()=>({items:['Курица','Яйца','Творог'],method:'ai'}),aiDraft:async()=>({values:{title:'Поездка в парк',dueAt:'2027-07-03'},method:'ai'})});
function init(userId,account='default',stamp=Math.floor(Date.now()/1000),withSignature=true){
 const p=new URLSearchParams();p.set('user',JSON.stringify({id:userId,first_name:'User'}));p.set('auth_date',String(stamp));if(withSignature)p.set('signature','synthetic-telegram-signature');
 const text=[...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 const key=createHmac('sha256','WebAppData').update(tokens[account]).digest();p.set('hash',createHmac('sha256',key).update(text).digest('hex'));return p.toString();
}
async function request(payload,method='POST',url='/family-app/api'){
 const raw=JSON.stringify(payload),req=Readable.from(method==='POST'?[Buffer.from(raw)]:[]);
 req.method=method;req.url=url;req.headers={'content-type':'application/json','origin':'https://family.example.invalid'}; let status=0,body='';const res={writeHead:(n)=>{status=n;},end:value=>{body=value?.toString()||'';}};
 await app.handle(req,res);return {status,data:body?JSON.parse(body):null};
}
const a=init(123456),b=init(654321,'agent_second');
assert.equal((await request({initData:a,kind:'bootstrap'})).data.member.id,'one');
assert.equal((await request({initData:b,kind:'bootstrap'})).data.member.id,'two');
assert.equal((await request({initData:init(123456,'default',Math.floor(Date.now()/1000),false),kind:'bootstrap'})).data.member.id,'one');
assert.equal((await request({initData:init(654321,'agent_second',Math.floor(Date.now()/1000),false),kind:'bootstrap'})).data.member.id,'two');
assert.equal((await request({initData:init(123456,'agent_second'),kind:'bootstrap'})).status,401);
assert.equal((await request({initData:init(123456,'default',1),kind:'bootstrap'})).status,401);
assert.equal((await request({initData:a.slice(0,-3)+'bad',kind:'bootstrap'})).status,401);
const changedSignature=new URLSearchParams(a);changedSignature.set('signature','tampered-signature');
assert.equal((await request({initData:changedSignature.toString(),kind:'bootstrap'})).status,401);
const changedUser=new URLSearchParams(b);changedUser.set('user',JSON.stringify({id:123456}));
assert.equal((await request({initData:changedUser.toString(),kind:'bootstrap'})).status,401);
assert.equal((await request({kind:'list',section:'notes',initData:a})).data.items.length,0);
const mutation={kind:'action',params:{action:'create_note',title:'Test',body:'Only for us',visibility:'household'},actionId:'one-test-unique-action-id-01',initData:a};
assert.equal((await request(mutation)).data.ok,true);
assert.equal((await request(mutation)).data.duplicate,true);
assert.equal((await request({initData:b,kind:'list',section:'notes'})).data.items[0].title,'Test');
assert.equal((await request({initData:a,kind:'action',actionId:'second-test-unique-01',params:{action:'unsupported_action'}})).status,400);
assert.equal((await request({initData:a,kind:'bootstrap'},'GET','/family-app/health')).status,200);

async function assetGet(route,mime){
 const req=Readable.from([]);req.method='GET';req.url='/family-app/'+route;
 req.headers={};
 let status=0,headers={},body=Buffer.alloc(0);
 const res={
  writeHead:(n,h)=>{status=n;headers=h;},
  end:v=>{body=Buffer.isBuffer(v)?v:Buffer.from(v||'');}
 };
 await app.handle(req,res);
 assert.equal(status,200,'HTTP '+route);
 assert.equal(headers['Content-Type'],mime);
 assert(body.length>500,'Empty asset '+route);
 return body;
}
const robotHTML=await assetGet('','text/html; charset=utf-8');
assert(!/robot(?:\.js|\.css|\.webp)/i.test(robotHTML.toString('utf8')));


const placeWrite=await request({initData:b,kind:'action',actionId:'test-place-create-unique-01',params:{action:'create_place',title:'Молочная кухня',comment:'Новое место'}});
assert.equal(placeWrite.status,200);
const placeId=placeWrite.data.value.id;
const placeList=await request({initData:a,kind:'list',section:'places'});
assert.equal(placeList.data.items[0].name,'Молочная кухня');
assert.equal(placeList.data.counts.unread,1);
assert.equal((await request({initData:a,kind:'seen',section:'places',ids:[placeId]})).data.counts.unread,0);
const media=Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.alloc(250,12)]).toString('base64');
const added=await request({initData:b,kind:'photo_upload',placeId,mime:'image/jpeg',data:media});
assert.equal(added.status,200);
const got=await request({initData:a,kind:'photo_get',id:added.data.item.id});
assert.equal(got.data.item.data,media);
const archived=await request({initData:a,kind:'meta',section:'places',id:placeId,archive:true});
assert.equal(archived.status,200);
assert.equal((await request({initData:b,kind:'list',section:'places',archive:true})).data.items[0].name,'Молочная кухня');
await request({initData:b,kind:'meta',section:'places',id:placeId,restore:true});
const planWrite=await request({initData:b,kind:'action',actionId:'family-photo-plan-create-2026',params:{action:'create_plan',title:'План с фотографией',comment:'Общий',participants:['one','two']},dueAt:'2027-04-17'});
assert.equal(planWrite.status,200);
const planId=planWrite.data.value.id;
const planPhoto=await request({initData:b,kind:'photo_upload',section:'plans',entityId:planId,mime:'image/jpeg',data:media});
assert.equal(planPhoto.status,200);
assert.equal((await request({initData:a,kind:'list',section:'plans'})).data.items[0]._photos[0].id,planPhoto.data.item.id);
assert.equal((await request({initData:a,kind:'photo_get',id:planPhoto.data.item.id})).data.item.data,media);
assert.equal((await request({initData:a,kind:'photo_delete',id:planPhoto.data.item.id})).status,200);
assert.equal((await request({initData:b,kind:'list',section:'plans'})).data.items[0]._photos.length,0);
const ai=await request({initData:a,kind:'smart_shopping',text:'курица яйца творог'});
assert.deepEqual(ai.data.items,['Курица','Яйца','Творог']);
const draft=await request({initData:b,kind:'smart_draft',section:'plans',text:'в парк в субботу'});
assert.equal(draft.data.values.title,'Поездка в парк');
const unauthorized=await request({initData:a,kind:'photo_get',id:'missing'});
assert.equal(unauthorized.status,400);

app.close();fs.rmSync(folder,{recursive:true,force:true});console.log('MiniApp tests: 36 checks passed (two users, auth, expiry, tamper, CRUD, idempotence, routing)');
