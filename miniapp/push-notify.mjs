import { DatabaseSync } from 'node:sqlite';

// Family Hub notification dispatcher. Runs inside OpenClaw Gateway, without
// changing existing /family commands or making private data publicly readable.
const types = {
  family_event: ['family_events', 'title', '🗓️ Новое событие'],
  action: ['actions', 'title', '📌 Новое дело'],
  place: ['places', 'name', '📍 Новое место'],
  plan: ['plans', 'title', '🧭 Новый план'],
  money_goal: ['money_goals', 'title', '🌱 Новая цель'],
  goal: ['money_goals', 'title', '🌱 Новая цель'],
  note: ['notes', 'title', '📝 Новая записка'],
  wish: ['wishes', 'title', '🎁 Новое желание'],
  poll: ['polls', 'question', '💬 Новое голосование'],
  capsule: ['capsules', null, '📦 Новая капсула'],
  shopping_item: ['shopping_items', null, '🛒 Новые покупки'],
};
const sections = {
  family_event:'calendar',action:'actions',place:'places',plan:'plans',
  money_goal:'goals',goal:'goals',note:'notes',wish:'wishes',poll:'polls',
  capsule:'capsules',shopping_item:'shopping',
};
const safeId = /^[a-zA-Z0-9_-]{1,150}$/;
const sendEndpoint = token => `https://api.telegram.org/bot${token}/sendMessage`;
const nowSql = () => new Date().toISOString().replace('T',' ').slice(0,19);

function queryOne(db, table, entityId) {
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(entityId);
}
function readTitle(type, record) {
  if (type==='capsule') return 'Для тебя создана семейная капсула';
  if (type==='shopping_item') return String(record.name || record.title || record.label || 'Покупка');
  return String(record[types[type][1]]||'Новая запись').slice(0,160);
}
function householdOf(db,record,memberId){
  return record.household_id || db.prepare('SELECT household_id FROM members WHERE id=?').get(memberId)?.household_id;
}
function canNotify(db,type,row,recipientId){
  if(type==='note'){
    if(row.deleted_at)return false;
    if(row.visibility==='owner')return false;
    if(row.visibility==='parents')return db.prepare('SELECT role FROM members WHERE id=?').get(recipientId)?.role==='parent';
    if(row.visibility==='household')return true;
    return Boolean(db.prepare('SELECT 1 FROM note_acl WHERE note_id=? AND member_id=?').get(row.id,recipientId));
  }
  if(type==='capsule')return row.recipient_id===recipientId;
  if(type==='poll')return Boolean(db.prepare('SELECT 1 FROM poll_participants WHERE poll_id=? AND member_id=?').get(row.id,recipientId));
  if(type==='wish'&&row.status==='hidden')return false;
  return true;
}
function dateFrom(db,type,entityId,record){
  if(type==='family_event')return record.start_at;
  if(type==='action'||type==='money_goal'||type==='goal')return record.due_at;
  if(type==='capsule')return record.unlock_at;
  const section=sections[type];
  return db.prepare('SELECT due_at FROM miniapp_meta WHERE section=? AND entity_id=?').get(section,entityId)?.due_at||null;
}
function niceDate(input){
  if(!input)return '';
  const raw=String(input);
  const date=new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw)?`${raw}T12:00:00+03:00`:raw);
  if(!Number.isFinite(+date))return raw;
  return new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',year:'numeric',...(raw.includes('T')&&!raw.startsWith('0000')?{hour:'2-digit',minute:'2-digit'}:{})}).format(date);
}

export function createFamilyNotifications({dbPath,db:providedDb,tokenForAccount,appUrl,fetchImpl=fetch,logger=console,initialCursor=null}){
  const db=providedDb||new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS miniapp_notification_cursor (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),last_event_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS miniapp_notification_jobs (
      event_id INTEGER NOT NULL,recipient_id TEXT NOT NULL,actor_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,household_id TEXT NOT NULL,
      label TEXT NOT NULL,title TEXT NOT NULL,occur_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      telegram_message_id INTEGER,
      last_error TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT,
      PRIMARY KEY(event_id,recipient_id)
    );
    CREATE INDEX IF NOT EXISTS miniapp_notification_pending ON miniapp_notification_jobs(status,available_at);
  `);
  const existing=db.prepare('SELECT last_event_id AS id FROM miniapp_notification_cursor WHERE singleton=1').get();
  if(!existing){
    const last = initialCursor ?? Number(db.prepare('SELECT MAX(id) AS n FROM entity_events').get()?.n||0);
    db.prepare('INSERT INTO miniapp_notification_cursor(singleton,last_event_id) VALUES(1,?)').run(last);
    logger.info?.('family-miniapp: family push notifications initialized');
  }
  let closed=false,busy=false;

  function capture(){
    const cursor=db.prepare('SELECT last_event_id AS id FROM miniapp_notification_cursor WHERE singleton=1').get().id;
    const events=db.prepare(`SELECT id,entity_type,entity_id,actor_id,event_type
     FROM entity_events WHERE id>? ORDER BY id LIMIT 100`).all(cursor);
    if(!events.length)return 0;
    db.exec('BEGIN IMMEDIATE');
    let inserted=0;
    try{
      for(const event of events){
        if(event.event_type!=='created'||!Object.hasOwn(types,event.entity_type)||!event.actor_id||!safeId.test(event.entity_id))continue;
        const [table,,label]=types[event.entity_type];
        const entry=queryOne(db,table,event.entity_id);
        if(!entry)continue;
        const householdId=householdOf(db,entry,event.actor_id);
        if(!householdId)continue;
        const members=db.prepare('SELECT id FROM members WHERE household_id=? AND id<>?').all(householdId,event.actor_id);
        for(const {id:recipientId} of members){
          if(!canNotify(db,event.entity_type,entry,recipientId))continue;
          const route=db.prepare("SELECT 1 FROM member_routes WHERE member_id=? AND channel='telegram' LIMIT 1").get(recipientId);
          if(!route)continue;
          const title=readTitle(event.entity_type,entry);
          const when=dateFrom(db,event.entity_type,event.entity_id,entry);
          const delayed=event.entity_type==='shopping_item'?new Date(Date.now()+18000).toISOString().replace('T',' ').slice(0,19):nowSql();
          const written=db.prepare(`INSERT OR IGNORE INTO miniapp_notification_jobs(event_id,recipient_id,actor_id,entity_type,entity_id,household_id,label,title,occur_at,available_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`).run(event.id,recipientId,event.actor_id,event.entity_type,event.entity_id,householdId,label,title,when,delayed);
          inserted+=Number(written.changes);
        }
      }
      db.prepare('UPDATE miniapp_notification_cursor SET last_event_id=? WHERE singleton=1').run(events.at(-1).id);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return inserted;
  }
  function recipientsRoute(memberId){
    const route=db.prepare("SELECT account_id AS accountId,target FROM member_routes WHERE member_id=? AND channel='telegram' ORDER BY updated_at DESC LIMIT 1").get(memberId);
    if(!route||!/^telegram:\d+$/.test(route.target))throw new Error('Telegram recipient route unavailable');
    const token=tokenForAccount(route.accountId||'default');
    if(!token)throw new Error('Telegram bot token unavailable');
    return {chatId:route.target.slice(9),token};
  }
  function bodyFor(jobs){
    const first=jobs[0];
    const name=db.prepare('SELECT name FROM members WHERE id=?').get(first.actor_id)?.name||'Кто-то из семьи';
    const names=jobs.map(row=>row.title);
    const title=first.entity_type==='shopping_item'&&jobs.length>1?`🛒 Новые покупки (${jobs.length})`:first.label;
    const description=first.entity_type==='shopping_item'&&jobs.length>1?names.slice(0,12).map(x=>`• ${x}`).join('\n')+(names.length>12?`\n…и ещё ${names.length-12}`:''):names[0];
    const date=first.occur_at?`\n📅 ${niceDate(first.occur_at)}`:'';
    return `${title}\n${description}${date}\n\nДобавил(а): ${name}\n\nОткрой 🫶 Семья, чтобы посмотреть подробности.`;
  }
  async function deliver(jobs){
    const {chatId,token}=recipientsRoute(jobs[0].recipient_id);
    const response=await fetchImpl(sendEndpoint(token),{
      method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000),
      body:JSON.stringify({chat_id:chatId,text:bodyFor(jobs),disable_notification:false,
        reply_markup:{inline_keyboard:[[{text:'🫶 Открыть Family Hub',web_app:{url:appUrl}}]]}})
    });
    const answer=await response.json();
    if(!response.ok||!answer?.ok)throw new Error('Telegram sendMessage rejected: '+String(answer?.error_code||response.status));
    return Number(answer.result?.message_id)||null;
  }
  async function process({max=5}={}){
    const pending=db.prepare("SELECT * FROM miniapp_notification_jobs WHERE status='pending' AND attempts<8 AND available_at<=? ORDER BY event_id LIMIT ?").all(nowSql(),Math.min(max,12));
    if(!pending.length)return {processed:0,sent:0,failed:0};
    let sent=0,failed=0,processed=0;
    const done=new Set();
    for(const item of pending){
      if(done.has(item.event_id+'|'+item.recipient_id))continue;
      const group=item.entity_type==='shopping_item'?pending.filter(j=>j.entity_type==='shopping_item'&&j.recipient_id===item.recipient_id&&j.actor_id===item.actor_id&&!done.has(j.event_id+'|'+j.recipient_id)): [item];
      group.forEach(j=>done.add(j.event_id+'|'+j.recipient_id));
      processed+=group.length;
      try{
        const messageId=await deliver(group);
        const finish=db.prepare("UPDATE miniapp_notification_jobs SET status='sent',telegram_message_id=?,sent_at=CURRENT_TIMESTAMP,last_error=NULL WHERE event_id=? AND recipient_id=?");
        for(const j of group)finish.run(messageId,j.event_id,j.recipient_id);
        sent+=group.length;
      }catch(error){
        const retry=db.prepare("UPDATE miniapp_notification_jobs SET attempts=attempts+1,last_error=?,available_at=datetime('now','+' || min(300,30*(attempts+1)) || ' seconds') WHERE event_id=? AND recipient_id=?");
        for(const j of group)retry.run(String(error?.message||error).slice(0,130),j.event_id,j.recipient_id);
        failed+=group.length;
        logger.warn?.('family-miniapp: family notification delivery pending');
      }
    }
    return {processed,sent,failed};
  }
  async function tick(){
    if(closed||busy)return {skipped:true};busy=true;
    try{const discovered=capture();const result=await process();return {discovered,...result};}
    finally{busy=false;}
  }
  return {tick,capture,process,close(){closed=true;if(!providedDb)db.close();}};
}
