import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {setupExtras,listEntries,countEntries,markSeen,updateMeta,photoUpload,photoGet,photoDelete} from './extras.mjs';
import {createMiniCalendarSync} from './calendar-sync.mjs';
import {createPhotoCalendarSync} from './photo-calendar.mjs';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {validateInitData} from './auth.mjs';
import {executeFamilyAction,TOOL_PARAMETERS} from '../dist/tool.js';
import {selectManualSurprise,releaseManualSurprise,stageSurpriseAsset} from '../dist/surprises.js';
import {createGwsCalendarAdapter,createGwsCliRunner} from '../dist/calendar.js';
const webDir=join(dirname(fileURLToPath(import.meta.url)),'web');
const sections=new Set(['actions','shopping','notes','plans','wishes','polls','capsules','cashback','goals','places']);
const acts=new Set(TOOL_PARAMETERS.properties.action.enum);
const reads=new Set(['list','list_members','list_shopping','search_notes','get_poll','get_capsule','get_calendar_event','get_cashback']);
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
async function bodyFrom(req){
 if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new Error('bad type');
 const chunks=[];let n=0;for await(const part of req){n+=part.length;if(n>2_500_000)throw new Error('too large');chunks.push(part);}
 const out=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(!out||typeof out!=='object'||Array.isArray(out))throw new Error('bad body');if(n>50000&&out.kind!=='photo_upload')throw new Error('too large');return out;
}
function paramsFrom(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('bad params');
 for(const [k,v] of Object.entries(raw)){
  if(!Object.hasOwn(TOOL_PARAMETERS.properties,k))throw new Error('unknown param');
  if(typeof v==='string' && v.length>4000)throw new Error('text too long');
  if(Array.isArray(v) && (v.length>50 || v.some(x=>typeof x!=='string'||x.length>400)))throw new Error('list too long');
 }
 return raw;
}

async function smartDraft(text,section){
 const fallback={values:section==='polls'?{question:text.slice(0,120)}:section==='notes'?{title:text.slice(0,120),body:text}:section==='calendar'?{title:text.slice(0,120)}:{title:text.slice(0,120)},method:'local'};
 const key=process.env.GEMINI_API_KEY;
 if(!key)return fallback;
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const keys={actions:['title','dueAt'],notes:['title','body','dueAt'],plans:['title','comment','dueAt'],places:['title','comment','dueAt','mapsUrl'],goals:['title','amount','dueAt'],wishes:['title','comment','dueAt','targetPrice'],polls:['question','options','dueAt'],calendar:['title','description','startAt']}[section];
 try{
  const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',{
   method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},signal:AbortSignal.timeout(8000),
   body:JSON.stringify({contents:[{parts:[{text:`Преобразуй краткую фразу в редактируемый черновик для семейного приложения. Текущая дата Москвы: ${today}. Разрешённые поля: ${keys.join(', ')}. Верни JSON объект с этими полями. Не выдумывай даты, участников, цены, места или подробности. Для dueAt используй YYYY-MM-DD, для startAt используй YYYY-MM-DDTHH:MM. Если даты нет, не добавляй её. Для options верни массив строк. Ввод: ${text}`}]}],generationConfig:{temperature:0,responseMimeType:'application/json',maxOutputTokens:450}})
  });
  if(!response.ok)return fallback;
  const output=await response.json();const raw=output.candidates?.[0]?.content?.parts?.find(x=>x.text)?.text;
  const item=JSON.parse(raw);
  if(!item||typeof item!=='object'||Array.isArray(item))return fallback;
  const values={};
  for(const field of keys){const value=item[field];if(value===undefined||value===null)continue;
   if(field==='options'&&Array.isArray(value)){values[field]=value.filter(v=>typeof v==='string').slice(0,10).join('\n');continue;}
   if(typeof value==='string'&&value.length<=1000)values[field]=value;
   if(['amount','targetPrice'].includes(field)&&typeof value==='number'&&Number.isFinite(value))values[field]=String(value);
  }
  if(!Object.keys(values).length)return fallback;
  return {values,method:'ai'};
 }catch{return fallback;}
}
async function smartShopping(text){
 const fallback=()=>{
  const parts=text.split(/[,;\n]+/u).map(x=>x.trim()).filter(Boolean);
  const raw=parts.length===1&&parts[0].split(/\s+/u).length<=5?parts[0].split(/\s+/u):parts;
  return {items:[...new Set(raw.map(x=>x.trim().replace(/^[-•.)\s]+/u,'')).filter(Boolean).map(x=>x.slice(0,1).toLocaleUpperCase('ru-RU')+x.slice(1)))].slice(0,35),method:'local'};
 };
 const key=process.env.GEMINI_API_KEY;
 if(!key)return fallback();
 try{
  const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',{
   method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},signal:AbortSignal.timeout(8000),
   body:JSON.stringify({contents:[{parts:[{text:`Раздели список покупок на отдельные пункты. Исправь опечатки и капитализацию, сохрани смысл, ничего не придумывай, не добавляй брендов, количества или цен. Верни только JSON-массив строк. Ввод: ${text}`}]}],generationConfig:{temperature:0,responseMimeType:'application/json',maxOutputTokens:500}})
  });
  if(!response.ok)return fallback();
  const responseData=await response.json();
  const raw=responseData.candidates?.[0]?.content?.parts?.find(x=>x.text)?.text;
  const data=JSON.parse(raw);
  if(!Array.isArray(data)||data.length>35||!data.length||data.some(v=>typeof v!=='string'||v.length>100))return fallback();
  return {items:[...new Set(data.map(x=>x.trim()).filter(Boolean))],method:'ai'};
 }catch{return fallback();}
}

export function familyMiniapp({db:providedDb,dbPath,appUrl,accountToken,calendarId,calendar:providedCalendar=null,surpriseAssetDir,surpriseMediaDir,surpriseManualLimit=10,surpriseUnlimitedMemberIds=[],placePhotoDir:providedPlacePhotoDir,driveFolderId=null,sendMedia,logger=console,aiShopping=null,aiDraft=null}) {
 const ownsDb=!providedDb;
 const db=providedDb||(dbPath?new DatabaseSync(dbPath):null);
 if(!db)throw new Error('familyMiniapp requires db or dbPath');
 const dataDir=dbPath?dirname(dbPath):join(homedir(),'.openclaw','family-hub');
 const placePhotoDir=providedPlacePhotoDir||join(dataDir,'place-photos');
 db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');setupExtras(db);
 const householdCount=()=>Number(db.prepare('SELECT COUNT(*) AS n FROM households').get()?.n||0);
 // Shared Google Calendar is unsafe across households without explicit per-household mapping.
 // Enforce one household per Mini App instance for calendar integration; block shared calendar when ambiguous.
 const calendarSafe=()=>!calendarId||householdCount()===1;
 if(calendarId&&!calendarSafe())logger?.warn?.('family-miniapp: shared Google Calendar disabled for ambiguous multi-household instance');
 const safeCalendarId=calendarId&&calendarSafe()?calendarId:null;
 const rawPhotos=createPhotoCalendarSync({db,imageDir:placePhotoDir,calendarId:safeCalendarId,driveFolderId,logger});
 const rawSync=createMiniCalendarSync({db,calendarId:safeCalendarId,calendar:providedCalendar,logger,onEventSynced:(section,id,household)=>{
  if(db.prepare('SELECT 1 FROM miniapp_photos WHERE section=? AND entity_id=? LIMIT 1').get(section,id))rawPhotos.queue(section,id,household);
 }});
 // Dynamic invariant: if household count becomes != 1, shared Google Calendar integration must stop immediately.
 const calendarBlocked=()=>Boolean(calendarId)&&!calendarSafe();
 let cachedCalendar={expires:0,items:[]};
 const calendar=providedCalendar||(calendarId?createGwsCalendarAdapter({run:createGwsCliRunner(),calendarId}):null);
 const sync={queue:(...a)=>rawSync.queue(...a),scan:(...a)=>rawSync.scan(...a),flush:async(opts)=>calendarBlocked()?{checked:0,blocked:'multi-household'}:rawSync.flush(opts),close:()=>rawSync.close()};
 const photos={queue:(...a)=>rawPhotos.queue(...a),scan:(...a)=>rawPhotos.scan(...a),flush:async(opts)=>calendarBlocked()?{checked:0,blocked:'multi-household'}:rawPhotos.flush(opts),close:()=>rawPhotos.close()};
 const hits=new Map();const aiHits=new Map();
 function authenticate(initData){
  const rows=db.prepare("SELECT r.member_id AS id,m.name,m.role,m.household_id AS householdId,r.account_id AS accountId,r.target FROM member_routes r JOIN members m ON m.id=r.member_id WHERE r.channel='telegram'").all();
  for(const r of rows){
    const token=accountToken(r.accountId||'default');if(!token)continue;
    const user=validateInitData(initData,token);
    if(user && r.target===`telegram:${user.id}`)return {member:{id:r.id,name:r.name,role:r.role,householdId:r.householdId},accountId:r.accountId||'default'};
  }return null;
 }
 function limit(id){const now=Date.now(),recent=(hits.get(id)||[]).filter(t=>now-t<60000);if(recent.length>=60)return false;recent.push(now);hits.set(id,recent);if(hits.size>30)for(const [key,arr] of hits)if(arr.at(-1)<now-60000)hits.delete(key);return true;}
 async function listCalendar(member){
   const items=db.prepare("SELECT id,id AS entityId,'family_event' AS entityType,title AS summary,start_at AS start,description FROM family_events WHERE household_id=? AND status='active' AND start_at>=? ORDER BY start_at LIMIT 30").all(member.householdId,new Date(Date.now()-86400000).toISOString());
   if(!calendar||calendarBlocked()){cachedCalendar={expires:0,items:[]};return items;}
   if(Date.now()>=cachedCalendar.expires){
     try{cachedCalendar={expires:Date.now()+60000,items:await calendar.listUpcomingEvents({from:new Date(Date.now()-86400000).toISOString(),max:30})};}
     catch{cachedCalendar={expires:Date.now()+15000,items:[]};}
   }
   const localIds=new Set(items.map(row=>row.entityId));
   const remote=cachedCalendar.items.filter(row=>row.entityType!=='family_event'||!localIds.has(row.entityId));
   return [...items,...remote].sort((a,b)=>String(a.start||'').localeCompare(String(b.start||''))).slice(0,30);
 }
 async function handle(req,res){
  const url=new URL(req.url||'/', 'https://family.local');const leaf=url.pathname.slice('/family-app'.length)||'/';
  const files={'/':'index.html','/app.css':'app.css','/app.js':'app.js'};
  const contentTypes={'/':'text/html; charset=utf-8','/app.css':'text/css; charset=utf-8','/app.js':'text/javascript; charset=utf-8'};
  if(req.method==='GET' && Object.hasOwn(files,leaf)){
   res.writeHead(200,{'Content-Type':contentTypes[leaf],'Cache-Control':'no-cache, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors https://web.telegram.org"});
   res.end(readFileSync(join(webDir,files[leaf])));return true;
  }
  if(req.method==='GET' && leaf==='/health'){json(res,200,{ok:true});return true;}
  if(req.method!=='POST'||leaf!=='/api'){json(res,404,{ok:false,error:'Не найдено'});return true;}
  if(appUrl && req.headers.origin){try{if(req.headers.origin!==new URL(appUrl).origin){json(res,403,{ok:false,error:'Недопустимое происхождение запроса'});return true;}}catch{json(res,403,{ok:false,error:'Недопустимое происхождение запроса'});return true;}}
  let body;try{body=await bodyFrom(req);}catch{json(res,400,{ok:false,error:'Некорректный запрос'});return true;}
  const auth=authenticate(body.initData);
  if(!auth){json(res,401,{ok:false,error:'Открой раздел «Семья» из Telegram. Если приложение давно открыто, закрой его и открой снова.'});return true;}
  const {member,accountId}=auth;
  if(!limit(member.id)){json(res,429,{ok:false,error:'Слишком много запросов. Попробуй позже.'});return true;}
  try{
   if(body.kind==='bootstrap'){
    const members=db.prepare('SELECT id,name FROM members WHERE household_id=? ORDER BY name').all(member.householdId);
    const counts={};for(const section of [...sections,'calendar']){try{counts[section]=countEntries(db,section,member);}catch{counts[section]={total:0,unread:0,archived:0};}}
    json(res,200,{ok:true,member:{id:member.id,name:member.name},members,counts});return true;
   }
   if(body.kind==='list'){
    if(!sections.has(body.section)&&body.section!=='calendar')throw new Error('unknown section');
    const archive=body.archive===true;
    let items=listEntries(db,body.section,member,{archive});
    if(body.section==='calendar' && !archive){
      const remote=await listCalendar(member);
      const local=new Set(items.map(x=>x.id));
      for(const event of remote){if(!local.has(event.entityId||event.id))items.push({...event,_dueAt:event.start,_unread:false});}
    }
    json(res,200,{ok:true,items,counts:countEntries(db,body.section,member)});return true;
   }
   if(body.kind==='seen'){
    if(typeof body.section!=='string'||!Array.isArray(body.ids)||body.ids.length>100)throw Error('Invalid seen list');
    const n=markSeen(db,body.section,body.ids,member);
    json(res,200,{ok:true,count:n,counts:countEntries(db,body.section,member)});return true;
   }
   if(body.kind==='meta'){
    if(typeof body.section!=='string'||typeof body.id!=='string')throw Error('Invalid entry');
    const meta=updateMeta(db,body.section,body.id,member,{dueAt:body.dueAt,archive:body.archive,restore:body.restore});
    if(body.dueAt!==undefined)sync.queue(body.section,body.id,member.householdId);
    const result=body.dueAt!==undefined?await sync.flush({max:1}):{checked:0};
    photos.scan();const photoCalendar=await photos.flush({max:2});
    json(res,200,{ok:true,meta,calendar:result,photoCalendar,counts:countEntries(db,body.section,member)});return true;
   }
   if(body.kind==='photo_upload'){
    const item=photoUpload(db,member,body,placePhotoDir);
    const photoCalendar=await photos.flush({max:2});
    json(res,200,{ok:true,item,photoCalendar});return true;
   }
   if(body.kind==='photo_get'){
    json(res,200,{ok:true,item:photoGet(db,member,body.id,placePhotoDir)});return true;
   }
   if(body.kind==='photo_delete'){
    const item=photoDelete(db,member,body.id,placePhotoDir);
    const photoCalendar=await photos.flush({max:2});
    json(res,200,{ok:true,item,photoCalendar});return true;
   }
   if(body.kind==='smart_draft'){
    const text=String(body.text||'').trim(),section=String(body.section||'');
    if(!['actions','notes','plans','places','goals','wishes','polls','calendar'].includes(section)||!text||text.length>900)throw Error('Invalid smart draft');
    const recent=(aiHits.get(member.id)||[]).filter(t=>Date.now()-t<60000);
    if(recent.length>=6){json(res,429,{ok:false,error:'Превышен лимит запросов к ИИ. Попробуй через минуту.'});return true;}
    recent.push(Date.now());aiHits.set(member.id,recent);
    const data=aiDraft?await aiDraft(text,section):await smartDraft(text,section);
    json(res,200,{ok:true,...data});return true;
   }
   if(body.kind==='smart_shopping'){
    const q=String(body.text||'').trim();if(!q||q.length>900)throw Error('Enter a shopping list under 900 characters');
    const recent=(aiHits.get(member.id)||[]).filter(t=>Date.now()-t<60000);
    if(recent.length>=6){json(res,429,{ok:false,error:'Слишком много запросов к ИИ, попробуй через минуту.'});return true;}
    recent.push(Date.now());aiHits.set(member.id,recent);
    const data=aiShopping?await aiShopping(q):await smartShopping(q);
    json(res,200,{ok:true,...data});return true;
   }
   if(body.kind==='action'){
    const params=paramsFrom(body.params);
    if(!acts.has(params.action))throw new Error('action not allowed');
    let actionKey=null;
    if(!reads.has(params.action)){
     if(typeof body.actionId!=='string'|| !/^[a-zA-Z0-9-]{20,64}$/.test(body.actionId))throw new Error('bad action id');
     actionKey=`miniapp:${member.id}:${body.actionId}`;
    }
    const result=executeFamilyAction({db,member,params,actionKey}).details;
    if(result.ok && !result.duplicate){
     const section=({create_place:'places',update_place:'places',create_plan:'plans',update_plan:'plans',create_note:'notes',update_note:'notes',create_wish:'wishes',update_wish:'wishes',create_poll:'polls',create_goal:'goals',update_goal:'goals',create_capsule:'capsules'})[params.action];
     if(section){
      const itemId=result.value?.id||params.familyPlaceId||params.planId||params.noteId||params.wishId||params.goalId;
      if(itemId && body.dueAt!==undefined){
       updateMeta(db,section,itemId,member,{dueAt:body.dueAt});sync.queue(section,itemId,member.householdId);
      }
      if(itemId && (section==='goals'||section==='capsules'))sync.queue(section,itemId,member.householdId);
     }
     // Existing Family Hub tool queues calendar events and tasks in its own outbox.
    }
    if(result.ok){try{
     const r=await sync.flush({max:2});
     photos.scan();const p=await photos.flush({max:2});
     result.calendarSync=r.failed||p.failed?'pending':r.checked||p.checked?'synced':'unchanged';
    }catch{result.calendarSync='pending';}}
    json(res,200,result);return true;
   }
   if(body.kind==='surprise'){
    const value=selectManualSurprise({db,memberId:member.id,assetDir:surpriseAssetDir,manualLimit:surpriseManualLimit,unlimitedMemberIds:surpriseUnlimitedMemberIds});
    if(value.status!=='asset'){json(res,200,{ok:true,status:value.status,cooldownUntil:value.cooldownUntil});return true;}
    try{
      const route=db.prepare("SELECT target AS 'to',account_id AS accountId FROM member_routes WHERE member_id=? AND account_id=? AND channel='telegram'").get(member.id,accountId);
      if(!route||!sendMedia)throw new Error('channel unavailable');
      await sendMedia({route,filePath:value.filePath,caption:'Семейный сюрприз'});
      json(res,200,{ok:true,status:'sent',remaining:value.remaining});return true;
    }catch{
      releaseManualSurprise({db,memberId:member.id,viewId:value.viewId});
      json(res,503,{ok:false,error:'Не удалось отправить открытку в Telegram'});return true;
    }
   }
   throw new Error('unsupported kind');
  }catch(error){logger?.warn?.('family-miniapp request failed: '+String(error?.message||'unknown').slice(0,120));json(res,400,{ok:false,error:'Операция не выполнена. Проверь данные и попробуй ещё раз.'});return true;}
 }
 async function scanCalendar(){
  if(calendarBlocked())return {calendars:{checked:0,blocked:'multi-household'},attachments:{checked:0,blocked:'multi-household'}};
  for(const h of db.prepare('SELECT id FROM households').all())sync.scan(h.id);
  const calendars=await sync.flush({max:4});
  photos.scan();const attachments=await photos.flush({max:3});
  return {calendars,attachments};
 }
 return {handle,close:()=>{sync.close();photos.close();if(ownsDb)db.close();},sync,photos,scanCalendar};
}
