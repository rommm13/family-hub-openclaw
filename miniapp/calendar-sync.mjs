import {createGwsCalendarAdapter,createGwsCliRunner} from '../dist/calendar.js';
import {getMeta} from './extras.mjs';

const config={places:['place','places','name'],plans:['plan','plans','title'],goals:['goal','money_goals','title'],wishes:['wish','wishes','title'],notes:['note','notes','title'],polls:['poll','polls','question'],capsules:['capsule','capsules',null]};
function plusOneDay(value){const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);}
function timeWindow(dueAt){
 const v=String(dueAt||'').trim();if(/^\d{4}-\d{2}-\d{2}$/.test(v))return {from:v,to:plusOneDay(v),allDay:true};
 const ts=new Date(v);if(!Number.isFinite(ts.getTime()))throw Error('Invalid calendar date');
 return {from:v,to:new Date(ts.getTime()+30*60000).toISOString(),allDay:false};
}
export function createMiniCalendarSync({db,calendarId,logger=console,calendar=null,onEventSynced=null}){
 if(!calendarId)return {queue(){},scan(){},flush:async()=>({checked:0}),close(){}};
 const rawGwsRun=createGwsCliRunner();
 // The event body uses YYYY-MM-DD for all-day events, but Google's list
 // endpoint requires RFC3339 timeMin/timeMax. Keep these formats separate.
 const calendarRun=async args=>{
  if(args[0]==='calendar'&&args[1]==='events'&&args[2]==='list'){
   const index=args.indexOf('--params');
   if(index!==-1){
    const params=JSON.parse(args[index+1]);
    for(const key of ['timeMin','timeMax']){
     if(/^\d{4}-\d{2}-\d{2}$/.test(params[key]||''))params[key]+='T00:00:00+03:00';
    }
    args=[...args];args[index+1]=JSON.stringify(params);
   }
  }
  return rawGwsRun(args);
 };
 const gws=calendar||createGwsCalendarAdapter({run:calendarRun,calendarId});
 let stopped=false,working=false;
 function queue(section,id,householdId){
  if(!config[section])return;
  db.prepare(`INSERT INTO miniapp_calendar_jobs(section,entity_id,household_id,state,updated_at)
   VALUES(?,?,?,'pending',CURRENT_TIMESTAMP)
   ON CONFLICT(section,entity_id) DO UPDATE SET state='pending',updated_at=CURRENT_TIMESTAMP,last_error=NULL`)
    .run(section,id,householdId);
 }
 function dueRecord(section,id,household){
  const [type,table,col]=config[section];
  const main=db.prepare('SELECT * FROM '+table+' WHERE id=? AND household_id=?').get(id,household);
  if(!main)return {type,date:null};
  const dueAt=section==='goals'?main.due_at:section==='capsules'?main.unlock_at:getMeta(db,section,id).dueAt;
  if(section==='notes' && main.visibility!=='household')return {type,date:null};
  const name=col?main[col]:'Открыть семейную капсулу';
  let description=section==='capsules'?'Содержимое доступно только получателю':undefined;
  if(section==='places'){
   const nameText=String(main.name||'Место');
   let locationUrl=null;
   if(main.maps_url){
    try{const parsed=new URL(main.maps_url);if(['https:','http:'].includes(parsed.protocol))locationUrl=parsed.href;}catch{}
   }
   if(!locationUrl && main.place_id){
    const search=new URL('https://www.google.com/maps/search/');
    search.searchParams.set('api','1');search.searchParams.set('query',nameText);
    search.searchParams.set('query_place_id',main.place_id);
    locationUrl=search.href;
   }
   if(!locationUrl){
    const search=new URL('https://www.google.com/maps/search/');
    search.searchParams.set('api','1');search.searchParams.set('query',nameText);
    locationUrl=search.href;
   }
   description=[`Место: ${nameText}`,
    main.maps_url||main.place_id?'Карта места: '+locationUrl:'Найти место на Google Maps (адрес не указан): '+locationUrl,
    ...(main.comment?.trim()?[`Заметка: ${main.comment.trim()}`]:[])].join('\n');
  }
  return {type,date:dueAt,summary:section==='capsules'?'📦 '+name:({places:'📍 ',plans:'🧭 ',goals:'🌱 ',wishes:'🎁 ',notes:'📝 ',polls:'💬 '}[section]||'')+String(name||'Семейное событие').slice(0,170),
   ...(description?{description}:{})};
 }
 async function sync(row){
  const {section,entity_id:id,household_id:household}=row;
  const info=dueRecord(section,id,household);
  const previous=db.prepare('SELECT google_event_id AS eventId FROM calendar_links WHERE entity_type=? AND entity_id=?').get(info.type,id);
  if(!info.date){
   if(previous?.eventId){await gws.deleteEvent({eventId:previous.eventId});db.prepare('DELETE FROM calendar_links WHERE entity_type=? AND entity_id=?').run(info.type,id);}
   return;
  }
  const input={entityType:info.type,entityId:id,summary:info.summary,...timeWindow(info.date),...(info.description?{description:info.description}:{})};
  let eventId=previous?.eventId;
  if(eventId){try{await gws.updateEvent({eventId,...input});}catch(e){if(!/404|not found/iu.test(String(e?.message||e)))throw e;eventId=null;}}
  if(!eventId){const result=await gws.ensureEvent(input);eventId=result.id; if(!result.created)await gws.updateEvent({eventId,...input});}
  db.prepare(`INSERT INTO calendar_links(entity_type,entity_id,google_event_id,calendar_id,sync_status)
   VALUES(?,?,?,?,'synced') ON CONFLICT(entity_type,entity_id) DO UPDATE SET
   google_event_id=excluded.google_event_id,calendar_id=excluded.calendar_id,sync_status='synced'`)
   .run(info.type,id,eventId,calendarId);
  if(onEventSynced)await onEventSynced(section,id,household);
 }
 async function flush({max=5}={}){
  if(stopped||working)return {checked:0,busy:true};working=true;
  let checked=0,failed=0;
  try{
   const rows=db.prepare("SELECT section,entity_id,household_id,attempts FROM miniapp_calendar_jobs WHERE state='pending' AND attempts<8 ORDER BY updated_at LIMIT ?").all(Math.min(max,10));
   for(const row of rows){if(stopped)break;checked++;
    try{await sync(row);
     const [type]=config[row.section];
     const v=db.prepare('SELECT MAX(id) AS last FROM entity_events WHERE entity_type=? AND entity_id=?').get(type==='goal'?'money_goal':type,row.entity_id);
     db.prepare("UPDATE miniapp_calendar_jobs SET state='synced',last_error=NULL,last_event_id=?,updated_at=CURRENT_TIMESTAMP WHERE section=? AND entity_id=?").run(Number(v?.last)||0,row.section,row.entity_id);
    }catch(e){failed++;
     db.prepare("UPDATE miniapp_calendar_jobs SET attempts=attempts+1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE section=? AND entity_id=?").run(String(e?.message||e).slice(0,180),row.section,row.entity_id);
     logger?.warn?.(`family-miniapp calendar sync pending: ${row.section}`);
    }
   }
  }finally{working=false;}
  return {checked,failed};
 }
function parseRussianPlaceDate(text,createdAt){
  // Only explicit calendar dates, not relative phrases like «в субботу».
  const raw=String(text||'').toLowerCase().replaceAll('ё','е');
  const months={января:1,февраля:2,марта:3,апреля:4,мая:5,июня:6,июля:7,августа:8,сентября:9,октября:10,ноября:11,декабря:12};
  const named=raw.match(/(?:^|[^\d])([0-3]?\d)\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(20\d{2}))?(?![а-я])/u);
  const numeric=raw.match(/(?:^|[^\d])([0-3]?\d)[.\/\-](0?[1-9]|1[012])(?:[.\/\-](20\d{2}))?(?!\d)/u);
  if(!named&&!numeric)return null;
  const day=Number((named||numeric)[1]),month=named?months[named[2]]:Number(numeric[2]);
  const explicitYear=(named||numeric)[3];
  const created=new Date(String(createdAt||'').replace(' ','T')+'Z');
  let year=explicitYear?Number(explicitYear):Number.isFinite(created.getTime())?created.getUTCFullYear():new Date().getUTCFullYear();
  const asDate=(y)=>`${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  if(!explicitYear && Number.isFinite(created.getTime())){
   // A monthless year written in a future-oriented places list means
   // its next occurrence, not a date already past when the place was added.
   const createdDay=created.toISOString().slice(0,10);
   if(asDate(year)<createdDay)year++;
  }
  const date=asDate(year),parsed=new Date(date+'T12:00:00Z');
  if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)return null;
  return date;
 }
  function scan(householdId){
  // Places created in /family store dates inside their comment, not due_at.
  // Import only explicit written dates, keeping the user's original text intact.
  for(const row of db.prepare(`SELECT p.id,p.comment,p.created_at AS createdAt
    FROM places p LEFT JOIN miniapp_meta m ON m.section='places' AND m.entity_id=p.id
    WHERE p.household_id=? AND m.entity_id IS NULL LIMIT 100`).all(householdId)){
   const date=parseRussianPlaceDate(row.comment,row.createdAt);
   if(!date)continue;
   db.prepare(`INSERT INTO miniapp_meta(section,entity_id,household_id,due_at,updated_at)
    VALUES('places',?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(section,entity_id) DO UPDATE SET due_at=excluded.due_at,updated_at=CURRENT_TIMESTAMP`)
    .run(row.id,householdId,date);
   queue('places',row.id,householdId);
  }
  // Scan changes from both Telegram bots and Mini App, not only newly-created records.
  const sources=[
   ['goals','money_goals','due_at','money_goal'],
   ['capsules','capsules','unlock_at','capsule']
  ];
  for(const [section,table,date,entityType] of sources){
   const rows=db.prepare(`SELECT id FROM ${table} WHERE household_id=? AND ${date} IS NOT NULL LIMIT 100`).all(householdId);
   for(const row of rows){
    const j=db.prepare('SELECT state,last_event_id AS lastVersion FROM miniapp_calendar_jobs WHERE section=? AND entity_id=?').get(section,row.id);
    const last=db.prepare('SELECT MAX(id) AS last FROM entity_events WHERE entity_type=? AND entity_id=?').get(entityType,row.id).last||0;
    if(!j || (j.state==='synced'&&Number(last)>Number(j.lastVersion||0)))queue(section,row.id,householdId);
   }
  }
  // Dated notes, plans, places and wishes may also be edited by the Telegram agents.
  for(const row of db.prepare("SELECT section,entity_id AS id FROM miniapp_meta WHERE household_id=? AND due_at IS NOT NULL LIMIT 200").all(householdId)){
   if(!config[row.section] || sources.some(s=>s[0]===row.section))continue;
   const [type]=config[row.section];
   const j=db.prepare('SELECT state,last_event_id AS lastVersion FROM miniapp_calendar_jobs WHERE section=? AND entity_id=?').get(row.section,row.id);
   const last=db.prepare('SELECT MAX(id) AS last FROM entity_events WHERE entity_type=? AND entity_id=?').get(type,row.id).last||0;
   if(!j || (j.state==='synced'&&Number(last)>Number(j.lastVersion||0)))queue(row.section,row.id,householdId);
  }
 }
 return {queue,flush,scan,close(){stopped=true;}};
}
