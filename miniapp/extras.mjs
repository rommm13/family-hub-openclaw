import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,unlinkSync,renameSync,statSync} from 'node:fs';
import {basename,join,resolve,sep} from 'node:path';
import {listSection,getCapsuleForViewer,getWishForViewer} from '../dist/domain.js';

const sections=new Set(['calendar','actions','shopping','notes','plans','places','goals','wishes','polls','capsules','cashback']);
const dated=new Set(['calendar','actions','notes','plans','places','goals','wishes','polls','capsules']);
export const photoSections=new Set(['calendar','actions','shopping','notes','plans','places','goals','wishes','polls']);
const moscowToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function setupExtras(db){
 db.exec(`CREATE TABLE IF NOT EXISTS miniapp_meta (
 section TEXT NOT NULL, entity_id TEXT NOT NULL, household_id TEXT NOT NULL,
 due_at TEXT, archived_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(section,entity_id));
 CREATE TABLE IF NOT EXISTS miniapp_seen (
 member_id TEXT NOT NULL, section TEXT NOT NULL,entity_id TEXT NOT NULL,
 last_event_id INTEGER NOT NULL DEFAULT 0,viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(member_id,section,entity_id));
 CREATE TABLE IF NOT EXISTS miniapp_place_photos (
 id TEXT PRIMARY KEY,place_id TEXT NOT NULL, household_id TEXT NOT NULL,
 uploader_id TEXT NOT NULL,mime TEXT NOT NULL,file_name TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE INDEX IF NOT EXISTS miniapp_place_photos_lookup ON miniapp_place_photos(place_id);
 CREATE TABLE IF NOT EXISTS miniapp_photos (
 id TEXT PRIMARY KEY,section TEXT NOT NULL,entity_id TEXT NOT NULL,household_id TEXT NOT NULL,
 uploader_id TEXT NOT NULL,mime TEXT NOT NULL,file_name TEXT NOT NULL,
 drive_file_id TEXT,drive_file_url TEXT,deleted_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE INDEX IF NOT EXISTS miniapp_photos_lookup ON miniapp_photos(section,entity_id,household_id);
 CREATE TABLE IF NOT EXISTS miniapp_photo_jobs (
 section TEXT NOT NULL,entity_id TEXT NOT NULL,household_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(section,entity_id));
 CREATE TABLE IF NOT EXISTS miniapp_calendar_jobs (
 section TEXT NOT NULL,entity_id TEXT NOT NULL,household_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,last_event_id INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(section,entity_id));`);
 db.exec(`CREATE TABLE IF NOT EXISTS miniapp_plugin_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
 const done=db.prepare("SELECT value FROM miniapp_plugin_meta WHERE key='legacy_photos_migrated'").get();
 if(!done){
  db.exec(`INSERT OR IGNORE INTO miniapp_photos(id,section,entity_id,household_id,uploader_id,mime,file_name,created_at)
   SELECT id,'places',place_id,household_id,uploader_id,mime,file_name,created_at FROM miniapp_place_photos`);
  db.prepare('INSERT INTO miniapp_plugin_meta(key,value) VALUES(?,?)').run('legacy_photos_migrated','1');
 }
 // On upgrades, legacy photos may already be imported without a Google sync job.
 // Queue unuploaded photos once; never reset completed or waiting jobs.
 db.exec(`INSERT OR IGNORE INTO miniapp_photo_jobs(section,entity_id,household_id,state)
 SELECT DISTINCT section,entity_id,household_id,'pending' FROM miniapp_photos
 WHERE deleted_at IS NULL AND drive_file_id IS NULL`);
}
function checkSection(section){if(!sections.has(section))throw new Error('Unknown section');}
function relatedEventType(section){return {calendar:'family_event',actions:'action',places:'place',plans:'plan',goals:'money_goal',shopping:'shopping_item',notes:'note',wishes:'wish',polls:'poll',capsules:'capsule',cashback:'cashback'}[section]||section;}
function version(db,section,id){
 const row=db.prepare('SELECT MAX(id) AS last FROM entity_events WHERE entity_type=? AND entity_id=?').get(relatedEventType(section),id);
 return Number(row?.last)||0;
}
function dateEnded(raw){
 if(!raw)return false;
 const value=String(raw);
 if(/^\d{4}-\d{2}-\d{2}$/.test(value))return value<moscowToday();
 const time=Date.parse(value);return Number.isFinite(time) && time<Date.now();
}
function meta(db,section,id){return db.prepare('SELECT due_at AS dueAt,archived_at AS archivedAt,updated_at AS updatedAt FROM miniapp_meta WHERE section=? AND entity_id=?').get(section,id)||{};}
function deriveDate(section,row,metadata){
 if(section==='calendar')return row.end||row.start||row.startAt;
 if(section==='actions'||section==='goals')return row.dueAt;
 if(section==='capsules')return row.unlockAt;
 return metadata.dueAt||null;
}
function archived(section,row,m){
 const ended=['completed','cancelled','archived','closed','removed'].includes(row.status);
 return Boolean(m.archivedAt||ended||dateEnded(deriveDate(section,row,m))||(section==='shopping'&&row.checked));
}
function inactiveRows(db,section,member){
 const h=member.householdId;
 if(section==='calendar')return db.prepare("SELECT id,id AS entityId,'family_event' AS entityType,title AS summary,start_at AS start,end_at AS end,description,status FROM family_events WHERE household_id=? ORDER BY start_at DESC LIMIT 100").all(h);
 if(section==='actions')return db.prepare("SELECT id,title,due_at AS dueAt,status,assignee_id AS assigneeId FROM actions WHERE household_id=? ORDER BY created_at DESC LIMIT 100").all(h);
 if(section==='plans')return db.prepare("SELECT id,title,status,comment FROM plans WHERE household_id=? ORDER BY created_at DESC LIMIT 100").all(h);
 if(section==='goals')return db.prepare("SELECT id,title,amount,currency,due_at AS dueAt,status FROM money_goals WHERE household_id=? ORDER BY created_at DESC LIMIT 100").all(h);
 if(section==='polls')return db.prepare("SELECT id,question,status FROM polls WHERE household_id=? ORDER BY created_at DESC LIMIT 100").all(h);
 if(section==='places')return db.prepare("SELECT id,name,maps_url AS mapsUrl,comment,created_by AS createdBy FROM places WHERE household_id=? ORDER BY created_at DESC LIMIT 100").all(h);
 if(section==='notes')return db.prepare("SELECT id,title,body,visibility,created_by AS createdBy,revision FROM notes WHERE household_id=? AND deleted_at IS NULL AND (created_by=? OR visibility='household' OR (visibility='parents' AND ?='parent')) ORDER BY updated_at DESC LIMIT 100").all(h,member.id,member.role);
 if(section==='capsules')return db.prepare("SELECT id FROM capsules WHERE household_id=? AND (author_id=? OR recipient_id=?) ORDER BY unlock_at DESC LIMIT 100").all(h,member.id,member.id).map(row=>getCapsuleForViewer(db,row.id,member.id)).filter(Boolean);
 if(section==='wishes')return db.prepare("SELECT id FROM wishes WHERE household_id=? ORDER BY created_at DESC LIMIT 100").all(h).map(row=>getWishForViewer(db,row.id,member.id)).filter(Boolean);
 return listSection(db,section,member.id,100);
}
export function listEntries(db,section,member,{archive=false}={}){
 checkSection(section);
 const raw=inactiveRows(db,section,member);
 const rows=[];
 for(const r of raw){const item={...r};const m=meta(db,section,item.id);
  const isArchived=archived(section,item,m);
  if(isArchived!==archive)continue;
  const v=version(db,section,item.id),seen=db.prepare('SELECT last_event_id AS lastEvent FROM miniapp_seen WHERE member_id=? AND section=? AND entity_id=?').get(member.id,section,item.id);
  item._unread=!seen || Number(seen.lastEvent)<v;
  item._dueAt=deriveDate(section,item,m);
  if(item._dueAt&&['places','plans','goals','wishes','notes','polls','capsules'].includes(section)){
   const entityType={places:'place',plans:'plan',goals:'goal',wishes:'wish',notes:'note',polls:'poll',capsules:'capsule'}[section];
   const link=db.prepare('SELECT sync_status AS status FROM calendar_links WHERE entity_type=? AND entity_id=?').get(entityType,item.id);
   const job=db.prepare('SELECT state FROM miniapp_calendar_jobs WHERE section=? AND entity_id=?').get(section,item.id);
   item._calendarStatus=link?.status==='synced'&&job?.state!=='pending'?'synced':job?.state==='pending'?'pending':'not_synced';
  }
  item._archived=isArchived;
  if(photoSections.has(section))item._photos=db.prepare(`SELECT id,mime,CASE WHEN drive_file_id IS NOT NULL THEN 1 ELSE 0 END AS driveReady
   FROM miniapp_photos WHERE household_id=? AND section=? AND entity_id=? AND deleted_at IS NULL ORDER BY created_at LIMIT 6`).all(member.householdId,section,item.id);
  rows.push(item);
 }
 return rows;
}
export function countEntries(db,section,member){const rows=listEntries(db,section,member);return {total:rows.length,unread:rows.filter(x=>x._unread).length,archived:listEntries(db,section,member,{archive:true}).length};}
export function markSeen(db,section,entityIds,member){
 checkSection(section);const visible=new Set(inactiveRows(db,section,member).map(x=>x.id));let count=0;
 for(const id of entityIds.slice(0,100)){
  if(typeof id!=='string'||!visible.has(id))continue;
  db.prepare(`INSERT INTO miniapp_seen(member_id,section,entity_id,last_event_id,viewed_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
   ON CONFLICT(member_id,section,entity_id) DO UPDATE SET last_event_id=excluded.last_event_id,viewed_at=CURRENT_TIMESTAMP`).run(member.id,section,id,version(db,section,id));count++;
 }
 return count;
}
export function updateMeta(db,section,id,member,{dueAt,archive,restore}={}){
 if(!dated.has(section))throw new Error('Section does not support dates or archive');
 if(!inactiveRows(db,section,member).some(x=>x.id===id))throw new Error('Unknown family entry');
 const previous=meta(db,section,id);
 if(dueAt!==undefined && dueAt!==null && dueAt!=='' && !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(dueAt))throw new Error('Invalid date');
 const date=(dueAt!==undefined) ? (dueAt||null) : (previous.dueAt||null);
 const stamp=archive?new Date().toISOString():restore?null:(previous.archivedAt||null);
 db.prepare(`INSERT INTO miniapp_meta(section,entity_id,household_id,due_at,archived_at,updated_at)
 VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(section,entity_id) DO UPDATE SET due_at=excluded.due_at,archived_at=excluded.archived_at,updated_at=CURRENT_TIMESTAMP`)
 .run(section,id,member.householdId,date,stamp);
 return {dueAt:date,archivedAt:stamp};
}
export function getMeta(db,section,id){return meta(db,section,id);}

const allowedTypes={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'};
const photoName=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/;
const MAX_PHOTO_BYTES=1_700_000;
const MAX_PHOTO_PIXELS=40_000_000;
const MAX_PHOTO_DIMENSION=12_000;
const DEFAULT_MAX_PHOTO_STORAGE_BYTES=250*1024*1024;
// Metadata-bearing markers/chunks are stripped server-side before storage/Drive.
// Client-side processing is not trusted.
const JPEG_METADATA_MARKERS=new Set([0xffe1,0xffe2,0xffed,0xfffe]); // APP1(EXIF/XMP), APP2, APP13(IPTC), COM
const PNG_METADATA_CHUNKS=new Set(['eXIf','tEXt','zTXt','iTXt']);
const WEBP_METADATA_CHUNKS=new Set(['EXIF','XMP ']);

function readUInt16BE(buf,offset){return buf.readUInt16BE(offset);}
function jpegDimensions(buf){
 for(let i=2;i+8<buf.length;){
  if(buf[i]!==0xff){i++;continue;}
  let marker=buf[i+1];
  while(marker===0xff && i+2<buf.length){i++;marker=buf[i+1];}
  if(marker===0xd9||marker===0xda)break; // EOI/SOS
  if(marker>=0xd0&&marker<=0xd9){i+=2;continue;} // RST/TEM/SOI/EOI
  if(i+4>buf.length)break;
  const len=readUInt16BE(buf,i+2);
  if(len<2||i+2+len>buf.length)break;
  if(marker===0xc0||marker===0xc1||marker===0xc2||marker===0xc3||marker===0xc5||marker===0xc6||marker===0xc7||marker===0xc9||marker===0xca||marker===0xcb||marker===0xcd||marker===0xce||marker===0xcf){
   if(len>=7){
    const h=readUInt16BE(buf,i+5),w=readUInt16BE(buf,i+7);
    if(w&&h)return {width:w,height:h};
   }
  }
  i+=2+len;
 }
 return null;
}
function stripJpegMetadata(buf){
 if(buf.length<4||buf[0]!==0xff||buf[1]!==0xd8)return buf;
 const out=[buf.subarray(0,2)];
 let i=2;
 while(i+1<buf.length){
  if(buf[i]!==0xff){ // damaged/unknown; preserve remainder to avoid corrupting scan
   out.push(buf.subarray(i));return Buffer.concat(out);
  }
  let marker=buf[i+1];
  while(marker===0xff && i+2<buf.length){i++;marker=buf[i+1];}
  if(marker===0xda){out.push(buf.subarray(i));return Buffer.concat(out);} // SOS + scan + EOI
  if(marker===0xd9){out.push(buf.subarray(i,i+2));return Buffer.concat(out);} // EOI
  if(marker>=0xd0&&marker<=0xd7){out.push(buf.subarray(i,i+2));i+=2;continue;} // RST
  if(i+4>buf.length){out.push(buf.subarray(i));return Buffer.concat(out);}
  const len=readUInt16BE(buf,i+2);
  if(len<2||i+2+len>buf.length){out.push(buf.subarray(i));return Buffer.concat(out);}
  const full=0xff00|marker;
  if(!JPEG_METADATA_MARKERS.has(full))out.push(buf.subarray(i,i+2+len));
  i+=2+len;
 }
 return Buffer.concat(out);
}
function pngDimensions(buf){
 if(buf.length<24)return null;
 return {width:buf.readUInt32BE(16),height:buf.readUInt32BE(20)};
}
function stripPngMetadata(buf){
 if(buf.length<8)return buf;
 const out=[buf.subarray(0,8)];
 let i=8;
 while(i+8<=buf.length){
  const len=buf.readUInt32BE(i);
  if(i+12+len>buf.length){out.push(buf.subarray(i));break;}
  const type=buf.toString('ascii',i+4,i+8);
  if(!PNG_METADATA_CHUNKS.has(type))out.push(buf.subarray(i,i+12+len));
  i+=12+len;
  if(type==='IEND')break;
 }
 return Buffer.concat(out);
}
function webpDimensions(buf){
 if(buf.length<16)return null;
 const type=buf.toString('ascii',12,16);
 if(type==='VP8X'&&buf.length>=30)return {width:1+buf.readUIntLE(24,3),height:1+buf.readUIntLE(27,3)};
 if(type==='VP8L'&&buf.length>=25){
  const bits=buf.readUInt32LE(21);
  return {width:(bits&0x3fff)+1,height:((bits>>14)&0x3fff)+1};
 }
 if(type==='VP8 '&&buf.length>=30){
  // Lossy bitstream: scan for start code 9d 01 2a
  for(let i=20;i+9<Math.min(buf.length,40);i++){
   if(buf[i]===0x9d&&buf[i+1]===0x01&&buf[i+2]===0x2a)return {width:buf.readUInt16LE(i+3)&0x3fff,height:buf.readUInt16LE(i+5)&0x3fff};
  }
 }
 return null;
}
function stripWebpMetadata(buf){
 if(buf.length<12||buf.toString('ascii',0,4)!=='RIFF'||buf.toString('ascii',8,12)!=='WEBP')return buf;
 const chunks=[];
 let i=12;
 while(i+8<=buf.length){
  const type=buf.toString('ascii',i,i+4);
  const len=buf.readUInt32LE(i+4);
  const pad=len%2;
  if(i+8+len+pad>buf.length){chunks.push(buf.subarray(i));break;}
  if(!WEBP_METADATA_CHUNKS.has(type))chunks.push(buf.subarray(i,i+8+len+pad));
  i+=8+len+pad;
 }
 const body=Buffer.concat(chunks);
 const out=Buffer.alloc(8+body.length);
 out.write('RIFF',0);out.writeUInt32LE(4+body.length,4);out.write('WEBP',8);body.copy(out,12);
 return out;
}
function sanitizeImageBuffer(bytes,mime){
 let dims=null;
 let clean=bytes;
 if(mime==='image/jpeg'){dims=jpegDimensions(bytes);clean=stripJpegMetadata(bytes);}
 else if(mime==='image/png'){dims=pngDimensions(bytes);clean=stripPngMetadata(bytes);}
 else if(mime==='image/webp'){dims=webpDimensions(bytes);clean=stripWebpMetadata(bytes);}
 if(dims){
  const {width,height}=dims;
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1)throw new Error('Invalid image dimensions');
  if(width>MAX_PHOTO_DIMENSION||height>MAX_PHOTO_DIMENSION)throw new Error(`Image dimensions too large (max ${MAX_PHOTO_DIMENSION}px)`);
  if(width*height>MAX_PHOTO_PIXELS)throw new Error('Image has too many pixels');
 }
 if(clean.length<100||clean.length>MAX_PHOTO_BYTES)throw new Error('Image too large');
 return clean;
}
export function resolvePhotoPath(imageDir,fileName){
 if(typeof fileName!=='string')throw new Error('Invalid photo file name');
 const name=basename(fileName);
 if(name!==fileName||!photoName.test(name))throw new Error('Invalid photo file name');
 const base=resolve(imageDir);
 const target=resolve(base,name);
 const prefix=base.endsWith(sep)?base:base+sep;
 if(target!==base && !target.startsWith(prefix))throw new Error('Invalid photo file path');
 return target;
}
function authorizePhoto(db,member,section,entityId){
 if(!photoSections.has(section))throw new Error('This section does not support photos');
 if(typeof entityId!=='string'||!entityId||entityId.length>160)throw new Error('Invalid record id');
 if(!inactiveRows(db,section,member).some(row=>row.id===entityId))throw new Error('Record unavailable');
}
function photoJob(db,section,entityId,householdId){
 db.prepare(`INSERT INTO miniapp_photo_jobs(section,entity_id,household_id,state,updated_at) VALUES(?,?,?,'pending',CURRENT_TIMESTAMP)
 ON CONFLICT(section,entity_id) DO UPDATE SET state='pending',attempts=0,last_error=NULL,updated_at=CURRENT_TIMESTAMP`)
 .run(section,entityId,householdId);
}
function storedPhotoBytes(db,imageDir){
 const rows=db.prepare('SELECT file_name AS fileName FROM miniapp_photos').all();
 let total=0;
 for(const row of rows){
  const file=resolvePhotoPath(imageDir,row.fileName); // fail closed on invalid db path
  try{
   const st=statSync(file);
   if(st.isFile())total+=st.size;
  }catch(error){
   if(error&&error.code==='ENOENT')continue;
   throw error;
  }
 }
 return total;
}
export function photoUpload(db,member,{section='places',entityId,placeId,mime,data},imageDir,maxStorageBytes=DEFAULT_MAX_PHOTO_STORAGE_BYTES){
 if(entityId!=null && placeId!=null)throw new Error('Provide either entityId or placeId, not both');
 const idRef=entityId||placeId;
 authorizePhoto(db,member,section,idRef);
 if(!Object.hasOwn(allowedTypes,mime)||typeof data!=='string'||data.length>2_400_000)throw new Error('Image must be JPG, PNG or WebP, under 1.7MB');
 const existing=db.prepare('SELECT COUNT(*) AS n FROM miniapp_photos WHERE section=? AND entity_id=? AND household_id=? AND deleted_at IS NULL').get(section,idRef,member.householdId).n;
 if(existing>=6)throw new Error('Maximum six photos for one record');
 const data64=data.replace(/^data:image\/(?:jpeg|png|webp);base64,/,'');
 if(!/^[A-Za-z0-9+/]+={0,2}$/.test(data64))throw new Error('Invalid image');
 const bytes=Buffer.from(data64,'base64');
 if(bytes.length<100||bytes.length>MAX_PHOTO_BYTES)throw new Error('Image too large');
 const valid=mime==='image/jpeg' && bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff || mime==='image/png' && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) || mime==='image/webp' && bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
 if(!valid)throw new Error('Image content mismatch');
 const safeBytes=sanitizeImageBuffer(bytes,mime);
 if(storedPhotoBytes(db,imageDir)+safeBytes.length>maxStorageBytes)throw new Error('Photo storage quota exceeded');
 const id=randomUUID(),fileName=id+allowedTypes[mime],file=join(imageDir,fileName);
 try{
  mkdirSync(imageDir,{recursive:true,mode:0o700});
  writeFileSync(file,safeBytes,{flag:'wx',mode:0o600});
  db.prepare('INSERT INTO miniapp_photos(id,section,entity_id,household_id,uploader_id,mime,file_name) VALUES(?,?,?,?,?,?,?)').run(id,section,idRef,member.householdId,member.id,mime,fileName);
  db.prepare('INSERT INTO entity_events(entity_type,entity_id,actor_id,event_type) VALUES(?,?,?,?)').run(relatedEventType(section),idRef,member.id,'photo_added');
  photoJob(db,section,idRef,member.householdId);
 }catch(error){try{unlinkSync(file);}catch{}throw error;}
 return {id,mime,section,entityId:idRef,calendar:'pending'};
}
export function photoGet(db,member,id,imageDir){
 const row=db.prepare('SELECT section,entity_id AS entityId,mime,file_name AS fileName FROM miniapp_photos WHERE id=? AND household_id=? AND deleted_at IS NULL').get(id,member.householdId);
 if(!row)throw new Error('Photo not found');
 authorizePhoto(db,member,row.section,row.entityId);
 const bytes=readFileSync(resolvePhotoPath(imageDir,row.fileName));
 return {id,mime:row.mime,data:bytes.toString('base64')};
}
export function photoDelete(db,member,id,imageDir){
 const row=db.prepare('SELECT section,entity_id AS entityId,file_name AS fileName,drive_file_id AS driveFileId FROM miniapp_photos WHERE id=? AND household_id=? AND deleted_at IS NULL').get(id,member.householdId);
 if(!row)throw new Error('Photo not found');
 authorizePhoto(db,member,row.section,row.entityId);
 const file=resolvePhotoPath(imageDir,row.fileName);
 if(row.driveFileId){
  db.prepare('UPDATE miniapp_photos SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
 }else{
  db.prepare('DELETE FROM miniapp_photos WHERE id=?').run(id);
  try{unlinkSync(file);}catch{}
 }
 db.prepare('INSERT INTO entity_events(entity_type,entity_id,actor_id,event_type) VALUES(?,?,?,?)').run(relatedEventType(row.section),row.entityId,member.id,'photo_deleted');
 photoJob(db,row.section,row.entityId,member.householdId);
 return {id,deleted:true,calendar:'pending'};
}
