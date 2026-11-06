import {readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createGwsCliRunner} from '../dist/calendar.js';
import {resolvePhotoPath} from './extras.mjs';

const entityTypes={calendar:'family_event',actions:'action',notes:'note',plans:'plan',places:'place',goals:'goal',wishes:'wish',polls:'poll'};
const googleId=/^[a-zA-Z0-9_-]{8,150}$/;
const prefix='https://drive.google.com/file/d/';
const linkFromId=id=>`${prefix}${id}/view`;

/** Keep local images private; only files selected for an existing calendar event are uploaded to Drive. */
export function createPhotoCalendarSync({db,imageDir,calendarId,driveFolderId,run=createGwsCliRunner(),logger=console}){
 let busy=false,closed=false;
 const enabled=Boolean(calendarId&&driveFolderId);
 function queue(section,id,householdId){
  if(!Object.hasOwn(entityTypes,section))return;
  db.prepare(`INSERT INTO miniapp_photo_jobs(section,entity_id,household_id,state,attempts,last_error,updated_at)
   VALUES(?,?,?,'pending',0,NULL,CURRENT_TIMESTAMP)
   ON CONFLICT(section,entity_id) DO UPDATE SET state='pending',attempts=0,last_error=NULL,updated_at=CURRENT_TIMESTAMP`)
  .run(section,id,householdId);
 }
 function googleLink(section,id){
  return db.prepare('SELECT google_event_id AS eventId FROM calendar_links WHERE entity_type=? AND entity_id=? AND sync_status=?').get(entityTypes[section],id,'synced')?.eventId;
 }
 function scan(){
  const waiting=db.prepare("SELECT section,entity_id AS id,household_id AS householdId FROM miniapp_photo_jobs WHERE state='waiting'").all();
  for(const row of waiting)if(googleLink(row.section,row.id))queue(row.section,row.id,row.householdId);
  return waiting.length;
 }
 async function listEvent(eventId){
  return run(['calendar','events','get','--params',JSON.stringify({calendarId,eventId})]);
 }
 async function upload(photo){
  const file=resolvePhotoPath(imageDir,photo.fileName);
  const ext=photo.fileName.endsWith('.png')?'png':photo.fileName.endsWith('.webp')?'webp':'jpg';
  const name=`Family Hub - ${photo.section} - ${photo.id}.${ext}`;
  const metadata={name,parents:[driveFolderId],description:'Private Family Hub calendar attachment',appProperties:{familyHub:'true',familyHubPhoto:photo.id}};
  const result=await run(['drive','files','create','--json',JSON.stringify(metadata),'--upload',file,'--upload-content-type',photo.mime]);
  const driveId=result.id;
  if(typeof driveId!=='string'||!googleId.test(driveId))throw new Error('Drive returned an invalid file id');
  db.prepare('UPDATE miniapp_photos SET drive_file_id=?,drive_file_url=? WHERE id=?').run(driveId,linkFromId(driveId),photo.id);
  return {driveFileId:driveId,driveFileUrl:linkFromId(driveId)};
 }
 async function removeDrive(photo){
  const fileId=photo.driveFileId;
  if(fileId&&googleId.test(fileId)){
   try{await run(['drive','files','delete','--params',JSON.stringify({fileId})]);}
   catch(error){
    // The CLI sometimes returns a non-zero status after a successful HTTP 204.
    // Only delete the local row after verifying that Drive reports the file absent.
    try{const check=await run(['drive','files','get','--params',JSON.stringify({fileId,fields:'id'})]);if(check?.id)throw error;}
    catch(checkError){if(/404|not found/iu.test(String(checkError?.message||checkError))){}else throw error;}
   }
  }
  try{unlinkSync(resolvePhotoPath(imageDir,photo.fileName));}catch{}
  db.prepare('DELETE FROM miniapp_photos WHERE id=? AND deleted_at IS NOT NULL').run(photo.id);
 }
 async function apply(row){
  const eventId=googleLink(row.section,row.entity_id);
  if(!eventId){
   const removed=db.prepare('SELECT id,file_name AS fileName,drive_file_id AS driveFileId FROM miniapp_photos WHERE section=? AND entity_id=? AND household_id=? AND deleted_at IS NOT NULL').all(row.section,row.entity_id,row.household_id);
   for(const photo of removed)await removeDrive(photo);
   const active=db.prepare('SELECT COUNT(*) AS n FROM miniapp_photos WHERE section=? AND entity_id=? AND household_id=? AND deleted_at IS NULL').get(row.section,row.entity_id,row.household_id).n;
   const state=active?'waiting':'synced';
   db.prepare('UPDATE miniapp_photo_jobs SET state=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE section=? AND entity_id=?').run(state,row.section,row.entity_id);
   return state;
  }
  const images=db.prepare(`SELECT id,section,mime,file_name AS fileName,drive_file_id AS driveFileId,
    drive_file_url AS driveFileUrl,deleted_at AS deletedAt FROM miniapp_photos
    WHERE section=? AND entity_id=? AND household_id=? ORDER BY created_at`).all(row.section,row.entity_id,row.household_id);
  for(const image of images){
   if(image.deletedAt||image.driveFileId)continue;
   const result=await upload(image);
   image.driveFileId=result.driveFileId;image.driveFileUrl=result.driveFileUrl;
  }
  const original=await listEvent(eventId);
  if(!original?.id)throw new Error('Google calendar event not found');
  const ours=new Set(images.map(i=>i.driveFileId).filter(Boolean));
  const others=(original.attachments||[]).filter(a=>!ours.has(a.fileId));
  const active=images.filter(i=>!i.deletedAt&&i.driveFileId).map(i=>({
   fileId:i.driveFileId,fileUrl:i.driveFileUrl,title:`Семейное фото (${i.section})`,mimeType:i.mime
  }));
  const desired=[...others,...active];
  // True Drive attachments, not URLs in event descriptions. Preserve manually attached files.
  const same=JSON.stringify((original.attachments||[]).map(x=>x.fileId).sort())===JSON.stringify(desired.map(x=>x.fileId).sort());
  if(!same){
   await run(['calendar','events','patch','--params',JSON.stringify({calendarId,eventId,supportsAttachments:true,sendUpdates:'none'}),'--json',JSON.stringify({attachments:desired})]);
  }
  for(const photo of images.filter(i=>i.deletedAt))await removeDrive(photo);
  db.prepare("UPDATE miniapp_photo_jobs SET state='synced',attempts=0,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE section=? AND entity_id=?").run(row.section,row.entity_id);
  return 'synced';
 }
 async function flush({max=4}={}){
  if(closed||busy)return {checked:0,busy:true};
  if(!enabled)return {checked:0,disabled:true};
  busy=true;let checked=0,failed=0,waiting=0;
  try{
   const jobs=db.prepare("SELECT section,entity_id,household_id FROM miniapp_photo_jobs WHERE state='pending' AND attempts<8 ORDER BY updated_at LIMIT ?").all(Math.min(10,max));
   for(const job of jobs){if(closed)break;checked++;
    try{const status=await apply(job);if(status==='waiting')waiting++;}
    catch(error){failed++;
     db.prepare("UPDATE miniapp_photo_jobs SET attempts=attempts+1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE section=? AND entity_id=?")
     .run(String(error?.message||error).slice(0,200),job.section,job.entity_id);
     logger?.warn?.(`family-miniapp photo calendar sync pending: ${job.section}`);
    }
   }
  }finally{busy=false;}
  return {checked,failed,waiting};
 }
 return {queue,scan,flush,close(){closed=true;}};
}
