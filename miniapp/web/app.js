const tg=window.Telegram?.WebApp;
const area=document.getElementById('content');
const notice=document.getElementById('notice');
const menu=[
 {key:'calendar',name:'Календарь',icon:'🗓️',note:'Наши даты и встречи'},
 {key:'shopping',name:'Купить',icon:'🛒',note:'Список покупок'},
 {key:'actions',name:'Дела',icon:'📌',note:'Общие задачи'},
 {key:'notes',name:'Записки',icon:'📝',note:'Важные мелочи'},
 {key:'plans',name:'Планы',icon:'🧭',note:'То, что впереди'},
 {key:'places',name:'Куда',icon:'📍',note:'Места, которые хочется посетить'},
 {key:'goals',name:'Цели',icon:'🌱',note:'Общие цели'},
 {key:'wishes',name:'Хочу',icon:'🎁',note:'Наши желания'},
 {key:'polls',name:'Выбрать',icon:'💬',note:'Решаем вместе'},
 {key:'capsules',name:'Капсулы',icon:'📦',note:'Письма в будущее'},
 {key:'cashback',name:'Кэшбэк',icon:'💳',note:'Выгодные покупки'},
 {key:'surprise',name:'Сюрприз',icon:'🎁',note:'Небольшой сюрприз'}
];
const allMenu=menu;
const photoSections=new Set(['calendar','actions','shopping','notes','plans','places','goals','wishes','polls']);
const fields={
 calendar:[['title','Название','text'],['startAt','Когда, МСК','datetime-local'],['description','Комментарий','textarea']],
 shopping:[['items','Что купить (каждая вещь с новой строки)','textarea']],
 actions:[['title','Дело','text'],['dueAt','Срок','date'],['assigneeId','Для кого','member']],
 notes:[['title','Заголовок','text'],['body','Текст заметки','textarea'],['dueAt','Дата (необязательно)','date'],['visibility','Видимость','visibility']],
 plans:[['title','Название плана','text'],['dueAt','Дата плана (необязательно)','date'],['comment','Описание','textarea']],
 places:[['title','Название места','text'],['dueAt','Когда посетить (необязательно)','date'],['comment','Комментарий','textarea'],['mapsUrl','Ссылка на карту','url']],
 goals:[['title','Название цели','text'],['amount','Сумма','number'],['currency','Валюта','text'],['dueAt','Планируемая дата','date'],['assigneeId','Ответственный','member']],
 wishes:[['title','Желание','text'],['dueAt','Дата (необязательно)','date'],['targetPrice','Стоимость, ₽','number'],['url','Ссылка','url'],['comment','Комментарий','textarea']],
 polls:[['question','Что выбираем?','text'],['dueAt','Дата (необязательно)','date'],['options','Варианты (по одному на строку)','textarea']],
 capsules:[['recipientId','Кому','member'],['unlockAt','Когда открыть, МСК','datetime-local'],['payload','Послание','textarea']],
 cashback:[['cashbackYear','Год','number'],['cashbackMonth','Месяц','number'],['cashbackTitle','Заголовок','text'],['cashbackBody','Категории и условия','textarea']]
};
const createActions={calendar:'create_calendar_event',shopping:'add_shopping_items',actions:'create_action',notes:'create_note',plans:'create_plan',places:'create_place',goals:'create_goal',wishes:'create_wish',polls:'create_poll',capsules:'create_capsule',cashback:'set_cashback'};
const state={member:null,members:[],counts:{},current:null,items:[],expanded:null,form:null,loading:false,error:null,archive:false,history:false};
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;};
const put=(parent,...children)=>{for(const child of children)if(child)parent.append(child);return parent;};
function button(label,onClick,cls='link'){const e=node('button',cls,label);e.type='button';e.onclick=onClick;return e;}
function say(message,good=false){notice.textContent=message;notice.className='notice'+(good?' success':'');notice.hidden=false;clearTimeout(say.timer);say.timer=setTimeout(()=>{notice.hidden=true;},5200);}
function loading(){document.body.classList.remove('home-view');area.replaceChildren(node('div','loading','Открываем страничку… ♡'));}
function formatDate(raw){if(!raw)return '';const d=new Date(raw);return !Number.isNaN(d.getTime())?d.toLocaleString('ru-RU',{day:'numeric',month:'long',year:'numeric',...(String(raw).includes('T')?{hour:'2-digit',minute:'2-digit'}:{})}):String(raw);}
const s=v=>String(v??'');
function meta(section,item){switch(section){
 case 'calendar':return formatDate(item.start||item.startAt);
 case 'actions':return item.dueAt?'До '+formatDate(item.dueAt):'Без срока';
 case 'shopping':return item.checked?'Куплено':'Купить';
 case 'wishes':return item.targetPrice?Number(item.targetPrice).toLocaleString('ru-RU')+' ₽':'';
 case 'capsules':return 'Открыть '+formatDate(item.unlockAt);
 case 'cashback':return [item.month,item.year].filter(Boolean).join('.');
 case 'goals':return item.amount+' '+item.currency;
 default:return '';
}}
function titleOf(section,item){return s(({calendar:item.summary||item.title,shopping:item.name,actions:item.title,notes:item.title,plans:item.title,places:item.name,goals:item.title,wishes:item.title,polls:item.question,capsules:'Капсула времени',cashback:item.title})[section]||item.title||'Без названия');}
async function call(payload){
 if(!tg?.initData)throw new Error('Открой мини-приложение кнопкой «Семья» в Telegram.');
 const response=await fetch('/family-app/api',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({initData:tg.initData,...payload})});
 const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Не удалось выполнить операцию');return data;
}
async function action(params,extra={}){return call({kind:'action',params,...extra,actionId:crypto.randomUUID()});}
function home(){
 document.body.classList.add('home-view');
 state.current=null;state.form=null;state.expanded=null;state.error=null;state.archive=false;area.replaceChildren();
 put(area,node('div','welcome',`${state.member?'Привет, '+state.member.name+'!':'Семейный центр'} Здесь собраны общие дела, планы и заметки.`));
 const grid=node('div','tiles');
 for(const section of menu){const b=button('',()=>openSection(section.key),'tile');b.setAttribute('aria-label',section.name);
  put(b,node('span','symbol',section.icon),node('span','name',section.name));
  const counts=state.counts[section.key];const total=typeof counts==='number'?counts:counts?.total||0;const unread=typeof counts==='number'?0:counts?.unread||0;
  if(total)put(b,node('span','count'+(unread?' fresh':''),unread?'+'+unread:String(total)));
  put(grid,b);
 }
 put(area,grid,button('Закрыть',()=>tg?.close?.(),'quiet full'));
}
async function openSection(section,archive=false){
 state.current=section;state.form=null;state.expanded='all';state.error=null;state.items=[];
 state.archive=archive;state.history=false;loading();
 if(section==='surprise'){render();return;}
 try{
  const data=await call({kind:'list',section,archive});
  state.items=data.items||[];state.counts[section]=data.counts||{total:state.items.length,unread:0,archived:0};
  render();
  const ids=state.items.filter(item=>item._unread).map(item=>item.id).filter(Boolean);
  if(ids.length){try{const seen=await call({kind:'seen',section,ids});if(seen.counts)state.counts[section]=seen.counts;}catch{}}
 }catch(error){state.error=error.message;render();}
}
function header(section){const info=allMenu.find(m=>m.key===section);const h=node('div','section-head');const text=node('div');put(text,node('p','section-kicker','Семейный центр'),node('h2','section-title',`${info.icon} ${info.name}`),node('div','hint',info.note));put(h,text,button('‹ Назад',home,'quiet back'));return h;}
function render(){if(!state.current){home();return;}document.body.classList.remove('home-view');const section=state.current;area.replaceChildren(header(section));if(section==='surprise'){renderSurprise();return;}
 if(state.error){put(area,node('div','notice',state.error),button('Повторить',()=>openSection(section),'primary full'));return;}
 if(state.form?.type==='search'){renderSearch();return;}
 if(state.form){renderForm(section);return;}
 if(section==='cashback'){renderLatestCashback();return;}
 const controls=node('div','pill-row');if(fields[section]&&!state.archive)put(controls,button(section==='shopping'?'＋ Добавить покупки':'＋ Добавить',()=>{state.form={type:'create'};render();},'primary'));
 if(section==='notes'&&!state.archive)put(controls,button('Поиск',searchNotes,'quiet'));
 if(section==='shopping' && state.items.some(x=>x.checked))put(controls,button('✓ Убрать купленное',()=>confirmAction({action:'clear_bought_shopping'}),'quiet'));
 if(section!=='cashback')put(controls,button(state.archive?'← Активные':`📦 Архив${state.counts[section]?.archived?' '+state.counts[section].archived:''}`,()=>openSection(section,!state.archive),'small-button quiet'));
 put(area,controls,node('div','',' '));
 if(!state.items.length){put(area,node('div','empty',state.archive?'Архив пока пуст.':'Здесь пока нет записей. Можно добавить первую.'));return;}
 const list=node('div','items');for(const item of state.items)put(list,renderItem(section,item));put(area,list);
}
function renderLatestCashback(){
 const months=[...state.items].sort((a,b)=>Number(b.year)-Number(a.year)||Number(b.month)-Number(a.month));
 const latest=months[0];
 if(!latest){put(area,node('div','empty','Категории кэшбэка пока не добавлены. Когда участник семьи сохранит их в Family Hub, эта страница обновится автоматически.'));return;}
 if(state.history){
  put(area,button('‹ К актуальному кэшбэку',()=>{state.history=false;render();},'quiet'));
  const older=months.slice(1);
  if(!older.length)put(area,node('div','empty','Прошлые месяцы пока отсутствуют.'));
  for(const item of older)put(area,node('h3','cashback-title',item.title),renderCashbackBody(item.body));
  return;
 }
 const month=Number(latest.month),year=Number(latest.year);
 const current=new Date(),isCurrent=current.getFullYear()===year && current.getMonth()+1===month;
 const intro=node('div','cashback-intro');
 put(intro,node('h3','cashback-title',latest.title||`Кэшбэк — ${String(month).padStart(2,'0')}.${year}`));
 put(intro,node('p','cashback-note',isCurrent?'Актуальные категории на этот месяц':'Последние сохранённые данные Family Hub'));
 put(area,intro,renderCashbackBody(latest.body));
 const controls=node('div','cashback-controls');
 put(controls,button('📦 Архив',()=>{state.history=true;render();},'small-button quiet'));
 put(controls,button('✎ Изменить',()=>{state.form={type:'edit',item:latest};render();},'small-button quiet'));
 put(area,controls);
}
function renderCashbackBody(text){
 const content=node('div','cashback-bank-list');
 for(const part of s(text).trim().split(/\n\s*\n/u)){
  if(!part.trim())continue;
  const lines=part.split('\n').map(x=>x.trim()).filter(Boolean);
  const group=node('div','bank');
  if(lines.length && !lines[0].startsWith('•'))put(group,node('h3','bank-name',lines.shift()));
  const entries=node('div','bank-entries');
  for(const line of lines){
   const entry=node('div','bank-line');
   const percent=/(?:до\s+)?\d+(?:[.,]\d+)?(?:\s*[–-]\s*\d+(?:[.,]\d+)?)?\s*%/giu;
   let from=0,match;
   while((match=percent.exec(line))!==null){
    if(match.index>from)entry.append(document.createTextNode(line.slice(from,match.index)));
    put(entry,node('span','cashback-percent',match[0]));
    from=percent.lastIndex;
   }
   if(from<line.length)entry.append(document.createTextNode(line.slice(from)));
   put(entries,entry);
  }
  put(group,entries);put(content,group);
 }
 return content;
}
function renderItem(section,item){
 const card=node('article','item'),row=node('div','item-head');
 const title=button(titleOf(section,item),()=>showItem(section,item),'item-main item-title');
 put(row,title,section==='shopping'?button(item.checked?'✓':'○',()=>perform({action:'toggle_shopping_item',shoppingItemId:item.id}),item.checked?'small-button quiet':'small-button primary'):null);
 put(card,row);const details=meta(section,item);if(details)put(card,node('div','item-meta',details));
 if(state.expanded===item.id||state.expanded==='all'){const expanded=node('div','item-expanded');
   const lines=[];
   if(item._dueAt && !['calendar','actions','goals','capsules'].includes(section))put(expanded,node('div','item-meta','🗓 '+formatDate(item._dueAt)));
   if(item._calendarStatus)put(expanded,node('div','item-meta',item._calendarStatus==='synced'?'📅 В семейном календаре':item._calendarStatus==='pending'?'⏳ Синхронизация с Google':'📅 Ожидает синхронизации'));
   if(section==='notes')lines.push(item.body);
   if(section==='plans'||section==='wishes'||section==='places')lines.push(item.comment);
   if(section==='cashback')put(expanded,renderCashbackBody(item.body));
   if(section==='calendar')lines.push(item.description);
   if(section==='capsules')lines.push(item.payload===null?'♡ Послание пока запечатано':item.payload);
   for(const line of lines.filter(Boolean))put(expanded,node('div','item-body',line));
   if(section==='polls'){const poll=state.pollDetails?.[item.id];if(poll){
     if(poll.status==='active' && poll.options)for(const opt of poll.options){put(expanded,button(opt.label,()=>perform({action:'vote_poll',pollId:item.id,optionIndex:opt.optionIndex}),'small-button full'));}
     if(poll.votes)put(expanded,node('div','item-meta',`Голосов: ${poll.votes.length}`));
   }}
   const controls=node('div','item-actions');
   if((section==='places' && item.mapsUrl) || (section==='wishes' && item.url)){
     const link=section==='places'?item.mapsUrl:item.url;
     try{const parsed=new URL(link);if(['http:','https:'].includes(parsed.protocol))put(controls,button('↗ Открыть ссылку',()=>{if(tg?.openLink)tg.openLink(parsed.href);else window.open(parsed.href,'_blank','noopener');},'small-button'));}catch{}
   }
   const edit=(key=idKey(section))=>{state.form={type:'edit',item};render();};
   const op=(actionName,key)=>button('✓ Выполнено',()=>perform({action:actionName,[key]:item.id}),'small-button primary');
   if(section==='actions')put(controls,op('complete_action','actionId'));
   if(section==='goals')put(controls,op('complete_goal','goalId'));
   if(section==='wishes' && item.ownerId!==state.member?.id)put(controls,button('♡ Забронировать',()=>perform({action:'reserve_wish',wishId:item.id}),'small-button primary'));
   if(['notes','plans','places','goals','actions','wishes','calendar','cashback'].includes(section)){
    if((section!=='calendar'||item.entityType==='family_event') && (section!=='wishes'||item.ownerId===state.member?.id))put(controls,button('Изменить',edit,'small-button'));
   }
   if(section==='polls' && item.status==='active')put(controls,button('Закрыть голосование',()=>confirmAction({action:'close_poll',pollId:item.id}),'small-button quiet'));
   const del={actions:['cancel_action','actionId'],notes:['delete_note','noteId'],wishes:['remove_wish','wishId'],capsules:['cancel_capsule','capsuleId'],calendar:['delete_calendar_event','calendarEventId']};
   if(del[section] && (section!=='calendar'||item.entityType==='family_event') && (section!=='wishes'||item.ownerId===state.member?.id)){
    put(controls,button(section==='plans'?'В архив':'Удалить',()=>confirmAction({action:del[section][0],[del[section][1]]:section==='calendar'?(item.entityId||item.id):item.id}),'small-button danger'));
   }
   if(!['cashback','shopping'].includes(section)&&!(section==='calendar'&&item.entityType!=='family_event'))put(controls,button(state.archive?'↩ Восстановить':'📦 В архив',()=>archiveEntry(section,item,!state.archive),'small-button quiet'));
   if(photoSections.has(section)&&(section!=='calendar'||item.entityType==='family_event'))renderItemPhotos(section,item,expanded,controls);
   put(expanded,controls);put(card,expanded);
 }
 return card;
}
function idKey(section){return ({notes:'noteId',plans:'planId',places:'familyPlaceId',goals:'goalId',wishes:'wishId',calendar:'calendarEventId',actions:'actionId'})[section]||'id';}
async function showItem(section,item){
 state.expanded='all';
 if(section==='polls'){
   try{const details=await action({action:'get_poll',pollId:item.id});state.pollDetails??={};state.pollDetails[item.id]=details.item;}catch(error){say(error.message);}
 }
 render();
}
async function perform(params){
 if(state.loading)return;state.loading=true;
 try{const result=await action(params);if(result.needsDate)throw new Error('Укажи дату или явно создай дело без срока.');say('Сохранено ♡',true);await openSection(state.current);tg?.HapticFeedback?.notificationOccurred?.('success');}
 catch(error){say(error.message);tg?.HapticFeedback?.notificationOccurred?.('error');}finally{state.loading=false;}
}
function confirmAction(params){const ask='Точно выполнить это действие?';if(tg?.showConfirm){tg.showConfirm(ask,yes=>{if(yes)void perform(params);});}else if(window.confirm(ask)){void perform(params);}}
function searchNotes(){state.form={type:'search'};render();}
function renderSearch(){
 const form=node('form','form');const title=node('h3','','♡ Поиск по семейным запискам');
 const field=node('label');const input=node('input');input.type='search';input.name='query';input.required=true;input.placeholder='Что найти?';
 put(field,node('span','','Поиск по заголовку и содержимому'),input);put(form,title,field);
 const controls=node('div','form-actions');put(controls,button('Отмена',()=>{state.form=null;render();},'quiet'));
 const submit=node('button','primary','🔎 Найти');submit.type='submit';put(controls,submit);put(form,controls);
 form.onsubmit=async event=>{
  event.preventDefault();const query=input.value.trim();if(!query)return;
  submit.disabled=true;
  try{const result=await action({action:'search_notes',query});state.items=result.items||[];state.form=null;state.expanded=null;render();}
  catch(error){say(error.message);}finally{submit.disabled=false;}
 };
 put(area,form);input.focus?.();
}

function initialValue(key,item){
 if(key==='cashbackYear')return item.year||new Date().getFullYear();
 if(key==='cashbackMonth')return item.month||new Date().getMonth()+1;
 if(key==='cashbackTitle')return item.title||'Кэшбэк';
 if(key==='cashbackBody')return item.body||'';
 if(key==='startAt')return (item.start||item.startAt||'').slice(0,16);
 if(key==='unlockAt')return (item.unlockAt||'').slice(0,16);
 if(key==='assigneeId')return item.assigneeId||state.member?.id;
 if(key==='recipientId')return item.recipientId||state.members.find(m=>m.id!==state.member?.id)?.id||'';
 if(key==='targetPrice')return item.targetPrice||'';
 if(key==='dueAt')return String(item._dueAt||item.dueAt||'').slice(0,10);
 if(key==='currency')return item.currency||'RUB';
 if(key==='options')return '';
 if(key==='items')return '';
 return item[key]??'';
}
function renderForm(section){
 if(section==='shopping'&&state.form?.type==='create'){renderShoppingForm();return;}
 const {type,item={}}=state.form;
 const form=node('form','form');const formTitle=node('h3','',(type==='edit'?'Изменить':'Добавить')+' · '+allMenu.find(m=>m.key===section).name);put(form,formTitle);
 const schema=fields[section];if(!schema){state.form=null;render();return;}
 const inputs={};let firstInput=null;
 if(!['cashback','capsules'].includes(section)){
  const smart=node('div','smart-draft');const prompt=node('textarea');prompt.rows=2;prompt.placeholder='Опиши своими словами: что, когда, где...';
  const parse=button('✨ Заполнить с ИИ',async()=>{
   const text=prompt.value.trim();if(!text){say('Напиши, что нужно добавить.');return;}
   parse.disabled=true;
   try{const data=await call({kind:'smart_draft',section,text});
    for(const [key,value] of Object.entries(data.values||{})){
     if(!Object.hasOwn(inputs,key))continue;
     inputs[key].value=String(value);
    }
    say(data.method==='ai'?'Черновик заполнен. Проверь и исправь перед сохранением.':'ИИ недоступен. Текст перенесён в черновик, заполни остальные поля.',true);
   }catch(error){say(error.message);}finally{parse.disabled=false;}
  },'small-button quiet');
  put(smart,node('div','hint','Можно написать как Алану, поля заполнятся автоматически.'),prompt,parse);
  put(form,smart);
 }
 for(const [key,label,typeName] of schema){
   const wrap=node('label');put(wrap,node('span','',label));let input;
   if(typeName==='textarea'){input=node('textarea');input.rows=key==='items'?4:3;}
   else if(typeName==='member'||typeName==='visibility'){input=node('select');
     const choices=typeName==='member'?state.members.map(m=>[m.id,m.name]):[['household','Для всей семьи'],['parents','Только родители'],['owner','Личная']];
     for(const [value,title] of choices){const opt=node('option','',title);opt.value=value;input.append(opt);}
   }else{input=node('input');input.type=typeName;}
   input.name=key;input.value=s(initialValue(key,item));if(!firstInput&&(typeName==='text'||typeName==='textarea')){firstInput=input;input.autofocus=true;}input.autocomplete='off';if(key==='title'||key==='question'||key==='payload'||key==='startAt'||key==='unlockAt'||key==='cashbackBody'||['recipientId','options','items'].includes(key)||(section==='notes'&&key==='body')||(section==='goals'&&['amount','dueAt'].includes(key)))input.required=true;
   inputs[key]=input;put(wrap,input);put(form,wrap);
 }
 if(section==='calendar'||section==='capsules')put(form,node('small','hint','Время указывается по Москве (UTC+3).'));
 if(section==='notes')put(form,node('small','hint','Записки с датой попадают в семейный календарь, кроме личных записок.'));
 if(['plans','places','wishes','polls','goals'].includes(section))put(form,node('small','hint','Если указана дата, запись автоматически синхронизируется с общим календарём.'));
 const pendingPhotos=[];
 if(photoSections.has(section)){
  const photosGroup=node('div','photo-attach-field');
  const photoInput=node('input');photoInput.type='file';photoInput.accept='image/*';photoInput.multiple=true;photoInput.className='photo-file';
  const previews=node('div','photo-selection');
  photoInput.onchange=()=>{
   const selected=[...(photoInput.files||[])];
   for(const file of selected){
    if(pendingPhotos.length>=6){say('Можно добавить до шести фотографий.');break;}
    if(file.size>12*1024*1024){say('Фото должно быть меньше 12 МБ.');continue;}
    pendingPhotos.push(file);
    const preview=node('div','photo-selected');
    const img=node('img');img.alt=file.name||'Выбранное фото';
    if(typeof URL.createObjectURL==='function'){
     const src=URL.createObjectURL(file);img.src=src;img.onload=()=>URL.revokeObjectURL(src);
    }
    put(preview,img,button('×',()=>{const index=pendingPhotos.indexOf(file);if(index>=0)pendingPhotos.splice(index,1);preview.remove();},'photo-remove'));
    put(previews,preview);
   }
   photoInput.value='';
  };
  put(photosGroup,button('📷 Добавить фото к записи',()=>photoInput.click(),'small-button quiet'),photoInput,previews);
  put(form,photosGroup);
 }
 const controls=node('div','form-actions');put(controls,button('Отмена',()=>{state.form=null;render();},'quiet'));const save=node('button','primary','♡ Сохранить');save.type='submit';put(controls,save);put(form,controls);
 form.onsubmit=async event=>{event.preventDefault();if(state.loading)return;save.disabled=true;state.loading=true;
  const params={action:type==='create'?createActions[section]:({calendar:'update_calendar_event',actions:'update_action',notes:'update_note',plans:'update_plan',places:'update_place',goals:'update_goal',wishes:'update_wish',cashback:'set_cashback'})[section]};
  if(!params.action){say('Редактирование пока недоступно');save.disabled=false;state.loading=false;return;}
  if(type==='edit' && section!=='cashback')params[idKey(section)]=section==='calendar'?(item.entityId||item.id):item.id;
  let extraDueAt;
  for(const [key,input] of Object.entries(inputs)){
    let value=input.value.trim();
    if(key==='dueAt'&&!['actions','goals'].includes(section)){extraDueAt=value;continue;}
    if(type==='edit' && !value && !['body','comment','description'].includes(key))continue;
    if(['startAt','unlockAt'].includes(key)&&value)value=value+':00+03:00';
    if(key==='items'){params.items=value.split('\n').map(x=>x.trim()).filter(Boolean);continue;}
    if(key==='options'){params.options=value.split('\n').map(x=>x.trim()).filter(Boolean);continue;}
    if(['targetPrice','amount','cashbackYear','cashbackMonth'].includes(key)){if(value)params[key]=Number(value);continue;}
    if(value || ['body','comment','description'].includes(key))params[key]=value;
  }
  if(section==='polls')params.participants=state.members.map(m=>m.id);
  if(section==='plans' && type==='create')params.participants=state.members.map(m=>m.id);
  if(section==='actions' && !params.dueAt)params.allowUndated=true;
  if(section==='notes' && type==='edit')params.expectedRevision=item.revision;
  try{
   const result=await action(params,extraDueAt===undefined?{}:{dueAt:extraDueAt});
   if(result.needsDate)throw new Error(result.message);
   const entityId=type==='edit'?(item.entityId||item.id):result.value?.id;
   let photoErrors=0,photoWaiting=false;
   if(pendingPhotos.length){
    if(!entityId){say('Запись сохранена, но ID для фотографий не получен. Добавь фото из карточки.');photoErrors=pendingPhotos.length;}
    else for(const file of pendingPhotos){
     try{
      const image=await preparePhoto(file);
      const answer=await call({kind:'photo_upload',section,entityId,mime:'image/jpeg',data:image});
      if(answer.photoCalendar?.failed||answer.photoCalendar?.waiting)photoWaiting=true;
     }catch(error){photoErrors++;}
    }
   }
   state.form=null;
   if(photoErrors)say(`Запись сохранена, но ${photoErrors} фото не прикрепились. Попробуй из карточки.`);
   else if(photoWaiting||result.calendarSync==='pending')say('Запись и фото сохранены. Google Calendar обновится автоматически.',true);
   else say('Сохранено ♡',true);
   await openSection(section);
  }
  catch(error){say(error.message);}finally{state.loading=false;save.disabled=false;}
 };
 put(area,form);firstInput?.focus?.();
}

async function archiveEntry(section,item,archive){
 try{const data=await call({kind:'meta',section,id:item.id,archive,restore:!archive});
  if(data.counts)state.counts[section]=data.counts;
  say(archive?'Перемещено в архив ♡':'Восстановлено ♡',true);
  await openSection(section,state.archive);
 }catch(error){say(error.message);}
}
function renderItemPhotos(section,item,expanded,controls){
 const photos=node('div','place-photos');
 for(const photo of item._photos||[]){
  const container=node('div','photo-thumb');const picture=node('img');picture.alt='Прикреплённая фотография';picture.loading='lazy';
  picture.onclick=()=>showFullPhoto(picture.src);
  put(container,picture,button('×',async()=>{
    const remove=async()=>{
     try{const answer=await call({kind:'photo_delete',id:photo.id});
      say(answer.photoCalendar?.failed?'Фото удалено. Из календаря исчезнет после повторной попытки.':'Фото удалено ♡',true);
      await openSection(section,state.archive);
     }catch(error){say(error.message);}
    };
    if(tg?.showConfirm)tg.showConfirm('Удалить фотографию?',yes=>{if(yes)void remove();});
    else if(window.confirm('Удалить фотографию?'))await remove();
   },'photo-remove'));
  put(photos,container);
  void call({kind:'photo_get',id:photo.id}).then(({item:found})=>{
   if(found?.mime&&found?.data)picture.src=`data:${found.mime};base64,${found.data}`;
  }).catch(()=>{picture.alt='Фото временно недоступно';});
 }
 put(expanded,photos);
 if(!state.archive){
  const input=node('input');input.type='file';input.accept='image/*';input.className='photo-file';
  input.onchange=async()=>{
   const file=input.files?.[0];if(!file)return;
   try{
    const image=await preparePhoto(file);
    const data=await call({kind:'photo_upload',section,entityId:item.id,mime:'image/jpeg',data:image});
    say(data.photoCalendar?.failed?'Фото сохранено. Синхронизация Google повторится позже.':'Фото прикреплено ♡',true);
    await openSection(section,state.archive);
   }catch(error){say(error.message);}
  };
  put(controls,button('📷 Прикрепить фото',()=>input.click(),'small-button'),input);
 }
}
function showFullPhoto(src){
 if(!src)return;
 const overlay=node('div','photo-overlay');
 const img=node('img');img.src=src;img.alt='Семейная фотография';
 put(overlay,img,button('× Закрыть',()=>overlay.remove(),'small-button quiet'));
 overlay.onclick=event=>{if(event.target===overlay)overlay.remove();};
 put(document.body,overlay);
}
async function preparePhoto(file){
 if(file.size>12*1024*1024)throw Error('Выбери фото до 12 МБ.');
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onerror=()=>reject(Error('Не удалось открыть фото'));
  reader.onload=()=>{
   const image=new Image();image.onerror=()=>reject(Error('Формат изображения не поддерживается'));
   image.onload=()=>{
    const scale=Math.min(1,1200/Math.max(image.width,image.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
    const context=canvas.getContext('2d');if(!context){reject(Error('Обработка фотографии недоступна'));return;}
    context.drawImage(image,0,0,canvas.width,canvas.height);
    let encoded=canvas.toDataURL('image/jpeg',.75);
    if(encoded.length>2_300_000){canvas.width=Math.max(1,Math.round(canvas.width*.75));canvas.height=Math.max(1,Math.round(canvas.height*.75));context.drawImage(image,0,0,canvas.width,canvas.height);encoded=canvas.toDataURL('image/jpeg',.62);}
    if(encoded.length>2_300_000){reject(Error('Фото слишком большое'));return;}
    resolve(encoded);
   };image.src=String(reader.result||'');
  };
  reader.readAsDataURL(file);
 });
}
function renderShoppingForm(){
 const form=node('div','form'),heading=node('h3','','🛒 Быстрый список покупок');
 const wrap=node('label');const entry=node('textarea');entry.placeholder='Например: курица, яйца, творог';entry.rows=3;entry.autofocus=true;
 put(wrap,node('span','','Что купить? Просто напиши своими словами'),entry);
 const hint=node('div','hint','ИИ разделит текст на товары. Перед сохранением всё можно поправить.');
 const preview=node('div','shopping-preview');
 const parse=button('✨ Разобрать список',async()=>{
  const text=entry.value.trim();if(!text){say('Напиши, что нужно купить');entry.focus?.();return;}
  parse.disabled=true;
  try{const data=await call({kind:'smart_shopping',text});
   preview.replaceChildren();for(const value of data.items||[])addShoppingPreview(preview,value);
   hint.textContent=data.method==='ai'?'ИИ подготовил список. Проверь и исправь перед сохранением.':'Список разделён автоматически, ИИ сейчас недоступен. Проверь позиции.';
  }catch(error){say(error.message);}finally{parse.disabled=false;}
 },'quiet full');
 const save=button('♡ Добавить в покупки',async()=>{
  if(!preview.querySelectorAll('.shopping-item-input').length){await parse.onclick();if(!preview.querySelectorAll('.shopping-item-input').length)return;}
  const items=[...preview.querySelectorAll('.shopping-item-input')].map(x=>x.value.trim()).filter(Boolean);
  if(!items.length){say('Добавь хотя бы один товар');return;}
  save.disabled=true;
  try{await action({action:'add_shopping_items',items});say('Покупки сохранены ♡',true);await openSection('shopping');}
  catch(error){say(error.message);}finally{save.disabled=false;}
 },'primary full');
 put(form,heading,wrap,hint,parse,preview,button('＋ Товар вручную',()=>addShoppingPreview(preview,''),'small-button quiet'),save,button('Отмена',()=>{state.form=null;render();},'small-button quiet'));
 put(area,form);entry.focus?.();
}
function addShoppingPreview(parent,value){
 const line=node('div','shopping-edit-row');const input=node('input','shopping-item-input');input.type='text';input.value=value;input.placeholder='Название товара';
 put(line,input,button('×',()=>line.remove(),'small-button danger'));put(parent,line);
 if(!value)input.focus?.();
}

function renderSurprise(){
 put(area,node('div','empty','Открыть случайный сюрприз из семейной коллекции?'));
 put(area,node('div','',' '),button('Получить сюрприз',async()=>{
  if(state.loading)return;state.loading=true;
  try{const result=await call({kind:'surprise'});
   if(result.status==='sent')say('Сюрприз отправлен в ваш чат.',true);
   else if(result.status==='cooldown')say('Сюрпризы на этот час закончились.');
   else say('В коллекции пока нет доступных сюрпризов.');
  }catch(error){say(error.message);}finally{state.loading=false;}
 },'primary full'));
}
try{tg?.ready();tg?.expand();tg?.setHeaderColor?.('#f5f6f8');tg?.setBackgroundColor?.('#eef1f5');tg?.BackButton?.onClick?.(()=>{if(state.form){state.form=null;render();}else home();});}catch{}
async function start(){if(!tg?.initData){home();say('Полный доступ доступен только из кнопки Mini App в Telegram.');return;}
 try{const data=await call({kind:'bootstrap'});state.member=data.member;state.members=data.members||[];state.counts=data.counts||{};home();}
 catch(error){home();say(error.message);}
}
void start();
