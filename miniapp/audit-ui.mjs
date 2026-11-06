import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto,randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {parseHTML} from 'linkedom';
const file=fileURLToPath(new URL('./web',import.meta.url));
const html=readFileSync(file+'/index.html','utf8');
const code=readFileSync(file+'/app.js','utf8');
const {window,document}=parseHTML(html);
// linkedom does not implement HTMLSelectElement.value setter; browsers do.
const createElement=document.createElement.bind(document);
document.createElement=function(tag,...args){
 const element=createElement(tag,...args);
 if(String(tag).toLowerCase()==='select')Object.defineProperty(element,'value',{configurable:true,get(){return this._mockSelectedValue||'';},set(value){this._mockSelectedValue=String(value);}});
 return element;
};
const actions=[],requests=[];
let brokenSection=null;
const cashback=[{id:'oct-2026',year:2026,month:10,title:'Кэшбэк — октябрь 2026',body:'Т-Банк\n• 1% все покупки\n• до 28% магазины\n\nСбер\n• 7% рестораны\n• 0,5% услуги\n\nВТБ\n• 2% супермаркеты, лимит 500 ₽\n\nЯндекс Пэй\n• 50% скидка\n• 2–5% категория'}];
const fixture={cashback,places:[{id:'place-1',name:'Молочная кухня',comment:'Вместе с Никитаом',_dueAt:'2027-06-01',_photos:[],_unread:true}],goals:[],plans:[],notes:[{id:'note-one',title:'Фото',body:'<img src=x onerror=alert(1)>',revision:1}],calendar:[],shopping:[],actions:[],wishes:[],polls:[],capsules:[]};
window.Telegram={WebApp:{initData:'mock-telegram-init-data',ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},BackButton:{onClick(){}},HapticFeedback:{notificationOccurred(){}},showConfirm:(text,cb)=>cb(true),openLink(){},close(){}}};
window.open=()=>{};window.prompt=()=>'';window.confirm=()=>true;
const fetch=async (url,options)=>{
 const b=JSON.parse(options.body);requests.push(b);
 let response;
 if(b.kind==='bootstrap')response={ok:true,member:{id:'participant_alpha',name:'Иван'},members:[{id:'participant_alpha',name:'Иван'},{id:'participant_beta',name:'Мария'}],counts:{cashback:{total:1,unread:0,archived:0},places:{total:1,unread:1,archived:0}}};
 else if(b.kind==='list')response=brokenSection===b.section?{ok:false,error:'Проблема сети'}:{ok:true,items:fixture[b.section]||[]};
 else if(b.kind==='smart_shopping')response={ok:true,items:['Курица','Яйца','Творог'],method:'ai'};
 else if(b.kind==='smart_draft')response={ok:true,values:{title:'Поездка в парк',dueAt:'2027-10-15',comment:'Встретиться у входа'},method:'ai'};
 else if(b.kind==='seen')response={ok:true,count:b.ids.length,counts:{total:1,unread:0,archived:0}};
 else if(b.kind==='meta')response={ok:true,meta:{},counts:{total:1,unread:0,archived:1}};
 else if(b.kind==='action'){actions.push(b.params);response=b.params.action==='get_poll'?{ok:true,item:{status:'active',options:[{optionIndex:0,label:'Да'},{optionIndex:1,label:'Нет'}],votes:[]}}:{ok:true,value:{id:'new-item'}};}
 else response={ok:true,status:'sent'};
 return {ok:response.ok,status:response.ok?200:503,json:async()=>response};
};
runInNewContext(code,{window,document,fetch,crypto:{randomUUID},URL,Date,Intl,console,clearTimeout(){},setTimeout(){return 1;}});
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));};
const findButton=(scope,label)=>[...scope.querySelectorAll('button')].find(x=>x.textContent.includes(label));
const click=async b=>{assert(b,'button missing');await b.onclick();await flush();};
let checks=0;const pass=(name,fn)=>{try{fn();checks++;console.log('PASS',name);}catch(e){console.error('FAIL',name,e.message);process.exitCode=1;}};
await flush();
pass('home shows all twelve functions',()=>{assert.equal(document.querySelectorAll('.tile').length,12);assert(findButton(document,'Кэшбэк'));assert(findButton(document,'Сюрприз'));});
pass('unread place badge is +1',()=>{assert(document.querySelector('.tile[aria-label=\"Куда\"] .count')?.textContent==='+1');});
await click(findButton(document.querySelector('.tiles'),'Кэшбэк'));
pass('cashback opens full current month, without expanding a card',()=>{assert(document.querySelectorAll('.bank-name').length===4);assert(document.querySelector('.bank-line').textContent.includes('1%'));assert(document.querySelector('.cashback-title')?.textContent.includes('октябрь 2026'));assert(!document.querySelector('.item-expanded'));});
pass('cashback preserves all bank sections',()=>{assert.deepEqual([...document.querySelectorAll('.bank-name')].map(e=>e.textContent),['Т-Банк','Сбер','ВТБ','Яндекс Пэй']);});

pass('all cashback percentages are individually highlighted in red',()=>{
 const rows=[...document.querySelectorAll('.bank-line')];
 const highlighted=[...document.querySelectorAll('.cashback-percent')];
 assert.equal(highlighted.length,7);
 assert.deepEqual(highlighted.map(e=>e.textContent),['1%','до 28%','7%','0,5%','2%','50%','2–5%']);
 assert.equal(rows.map(row=>row.textContent).join('\n').match(/%/g).length,7);
 assert.equal(document.querySelector('.bank-line').querySelector('.cashback-percent').textContent,'1%');
 assert(!highlighted.some(e=>e.textContent.includes('500')));
 assert.equal(highlighted[1].textContent,'до 28%');
});

pass('home enables compact viewport styling',()=>{assert(document.body.classList.contains('home-view')===false);});
await click(findButton(document,'Изменить'));
pass('cashback editor pre-fills live period and conditions',()=>{
 const form=document.querySelector('form');assert(form);
 assert.equal(form.querySelector('[name="cashbackYear"]').value,'2026');
 assert.equal(form.querySelector('[name="cashbackMonth"]').value,'10');
 assert(form.querySelector('[name="cashbackBody"]').value.includes('Т-Банк'));
});
const cbForm=document.querySelector('form');
cbForm.querySelector('[name="cashbackBody"]').value='Т-Банк\n• 7%';
await cbForm.onsubmit({preventDefault(){}});await flush();
pass('cashback save invokes existing set_cashback',()=>{const a=actions.at(-1);assert.equal(a.action,'set_cashback');assert.equal(a.cashbackYear,2026);assert.equal(a.cashbackMonth,10);});
await click(findButton(document,'Назад'));
pass('home compact mode activates on return',()=>{assert(document.body.classList.contains('home-view'));});
// Monthly update simulation: the bot has written a newer record to the shared DB.
fixture.cashback.unshift({id:'nov-2026',year:2026,month:11,title:'Кэшбэк — ноябрь 2026',body:'Новый банк\n• 4% — спорт'});
await click(findButton(document.querySelector('.tiles'),'Кэшбэк'));
pass('next-month data appears on opening without a frontend redeploy',()=>{
 assert(document.querySelector('.cashback-title').textContent.includes('ноябрь 2026'));
 assert(document.querySelector('.bank-name').textContent==='Новый банк');
 assert(document.querySelector('.bank-line').textContent.includes('4%'));
 assert.equal(document.querySelector('.cashback-percent').textContent,'4%');
 assert(!document.querySelector('#content').textContent.includes('Т-Банк'));
});
fixture.cashback.shift();
await click(findButton(document,'Назад'));
pass('places and goals are directly accessible from home',()=>{assert(findButton(document.querySelector('.tiles'),'Куда'));assert(findButton(document.querySelector('.tiles'),'Цели'));});
await click(findButton(document.querySelector('.tiles'),'Куда'));
pass('places subsection is navigable',()=>{assert(document.querySelector('.section-title').textContent.includes('Куда'));});
pass('Maria-created place is expanded with details and photo input',()=>{assert(document.querySelector('.item-body').textContent.includes('Никитаом'));assert(findButton(document,'Прикрепить фото'));assert(document.querySelector('input[type=\"file\"]'));});
pass('photo button in existing place card opens a real input',()=>{
 const pick=document.querySelector('.item-actions .photo-file');
 assert(pick);assert.equal(pick.type,'file');assert.equal(typeof pick.onchange,'function');
 assert(findButton(document,'Прикрепить фото'));
});
await click(findButton(document,'Добавить'));
pass('places creation form exists',()=>{assert(document.querySelector('form [name="title"]'));assert(document.querySelector('form [name="mapsUrl"]'));});
const form=document.querySelector('form');form.querySelector('[name="title"]').value='Сочи';form.querySelector('[name="comment"]').value='Хочется летом';
await form.onsubmit({preventDefault(){}});await flush();
pass('places create is routed to create_place operation',()=>{assert.equal(actions.at(-1).action,'create_place');assert.equal(actions.at(-1).title,'Сочи');});
await click(findButton(document,'Назад'));
await click(findButton(document.querySelector('.tiles'),'Цели'));
await click(findButton(document,'Добавить'));
pass('goals form includes amount, currency and date',()=>{const f=document.querySelector('form');for(const key of ['title','amount','currency','dueAt'])assert(f.querySelector(`[name="${key}"]`));});
await click(findButton(document,'Отмена'));await click(findButton(document,'Назад'));
await click(findButton(document.querySelector('.tiles'),'Записки'));
await click(findButton(document,'Фото'));
pass('notes render user input as text (no injected HTML)',()=>{assert.equal(document.querySelectorAll('#content img').length,0);assert(document.querySelector('.item-body').textContent.includes('<img'));});
await click(findButton(document,'Назад'));
brokenSection='shopping';await click(findButton(document.querySelector('.tiles'),'Купить'));
pass('fetch errors show retry instead of fake empty sections',()=>{assert(findButton(document,'Повторить'));assert(document.querySelector('#content').textContent.includes('Проблема сети'));assert(!document.querySelector('#content').textContent.includes('Пока здесь пусто'));});
brokenSection=null;await click(findButton(document,'Повторить'));await click(findButton(document,'Назад'));
const labels=['Календарь','Купить','Дела','Записки','Планы','Куда','Цели','Хочу','Выбрать','Капсулы','Кэшбэк','Сюрприз'];
for(const label of labels){
 await click(findButton(document.querySelector('.tiles'),label));
 pass('opens main section '+label,()=>{assert(document.querySelector('.section-title').textContent.includes(label));});
 await click(findButton(document,'Назад'));
}
fixture.shopping=[{id:'shopping1',name:'Чай',checked:false}];
await click(findButton(document.querySelector('.tiles'),'Купить'));
await click(findButton(document,'○'));
pass('shopping tick sends existing toggle action',()=>{assert.equal(actions.at(-1).action,'toggle_shopping_item');});
await click(findButton(document,'Назад'));
fixture.polls=[{id:'poll1',question:'Куда?',status:'active'}];
await click(findButton(document.querySelector('.tiles'),'Выбрать'));
await click(findButton(document,'Куда?'));
pass('poll detail loads voting buttons',()=>{assert(findButton(document,'Да'));assert(findButton(document,'Нет'));});
await click(findButton(document,'Да'));
pass('poll vote dispatches to existing voting action',()=>{assert.equal(actions.at(-1).action,'vote_poll');assert.equal(actions.at(-1).optionIndex,0);});
await click(findButton(document,'Назад'));
await click(findButton(document.querySelector('.tiles'),'Сюрприз'));
await click(findButton(document,'Получить сюрприз'));
pass('surprise button sends existing media request',()=>{assert(requests.some(r=>r.kind==='surprise'));assert(document.querySelector('#notice').textContent.includes('Сюрприз'));});

await click(findButton(document,'Назад'));
await click(findButton(document.querySelector('.tiles'),'Записки'));
await click(findButton(document,'Поиск'));
pass('notes search form uses native input',()=>{assert(document.querySelector('form input[type="search"]'));});
const findForm=document.querySelector('form');findForm.querySelector('[name="query"]').value='Рецепт';
await findForm.onsubmit({preventDefault(){}});await flush();
pass('notes search dispatches to domain search',()=>{assert.equal(actions.at(-1).action,'search_notes');assert.equal(actions.at(-1).query,'Рецепт');});
await click(findButton(document,'Назад'));
await click(findButton(document.querySelector('.tiles'),'Капсулы'));
await click(findButton(document,'Добавить'));
pass('capsule defaults to the other family member',()=>{assert.equal(document.querySelector('form [name="recipientId"]').value,'participant_beta');});
await click(findButton(document,'Отмена'));await click(findButton(document,'Назад'));
await click(findButton(document.querySelector('.tiles'),'Планы'));
await click(findButton(document,'Добавить'));
const planForm=document.querySelector('form');planForm.querySelector('[name="title"]').value='Семейный отпуск';
await planForm.onsubmit({preventDefault(){}});await flush();
pass('new plans include both family members',()=>{assert.deepEqual(Array.from(actions.at(-1).participants),['participant_alpha','participant_beta']);});
await click(findButton(document,'Назад'));
await click(findButton(document.querySelector('.tiles'),'Календарь'));
await click(findButton(document,'Добавить'));
const calForm=document.querySelector('form');calForm.querySelector('[name="title"]').value='Встреча';calForm.querySelector('[name="startAt"]').value='2027-04-03T19:30';
await calForm.onsubmit({preventDefault(){}});await flush();
pass('calendar timestamps retain Moscow offset',()=>{assert.equal(actions.at(-1).startAt,'2027-04-03T19:30:00+03:00');});

await click(findButton(document,'Назад'));
pass('viewed place badge changes from +1 to 1',()=>{assert.equal(document.querySelector('.tile[aria-label="Куда"] .count').textContent,'1');});
await click(findButton(document.querySelector('.tiles'),'Купить'));
await click(findButton(document,'Добавить покупки'));
pass('shopping form has natural language input with focused text area',()=>{assert(document.querySelector('.form textarea'));assert(findButton(document,'Разобрать список'));});
const groceries=document.querySelector('.form textarea');groceries.value='курица яйца творог';
await click(findButton(document,'Разобрать список'));
pass('AI suggests individual editable groceries',()=>{assert.deepEqual([...document.querySelectorAll('.shopping-item-input')].map(x=>x.value),['Курица','Яйца','Творог']);});
document.querySelectorAll('.shopping-item-input')[1].value='Яйца С0';
await click(findButton(document,'Добавить в покупки'));
pass('edited shopping list sent to existing Family Hub operation',()=>{assert.equal(actions.at(-1).action,'add_shopping_items');assert.deepEqual(Array.from(actions.at(-1).items),['Курица','Яйца С0','Творог']);});
await click(findButton(document,'Назад'));
await click(findButton(document.querySelector('.tiles'),'Планы'));
await click(findButton(document,'Добавить'));
pass('plans form supports date and text input autofocus',()=>{const f=document.querySelector('form');assert(f.querySelector('[name="dueAt"]'));assert(f.querySelector('[name="title"]').autofocus);});
pass('new plan form has actual multi-image file input',()=>{
 const f=document.querySelector('form');
 const pick=f.querySelector('.photo-attach-field input[type="file"]');
 assert(pick);assert.equal(pick.accept,'image/*');assert(pick.multiple);assert.equal(typeof pick.onchange,'function');
 assert(findButton(f,'Добавить фото к записи'));
});

const smartForm=document.querySelector('form');smartForm.querySelector('.smart-draft textarea').value='15 октября в парк, встретиться у входа';
await click(findButton(smartForm,'Заполнить с ИИ'));
pass('natural-language draft populates editable plan fields',()=>{
 assert.equal(smartForm.querySelector('[name="title"]').value,'Поездка в парк');
 assert.equal(smartForm.querySelector('[name="dueAt"]').value,'2027-10-15');
 assert.equal(smartForm.querySelector('[name="comment"]').value,'Встретиться у входа');
});

const futurePlan=document.querySelector('form');futurePlan.querySelector('[name="title"]').value='На дачу';futurePlan.querySelector('[name="dueAt"]').value='2027-10-12';
await futurePlan.onsubmit({preventDefault(){}});await flush();
pass('plan date supplied as calendar metadata, not unsupported domain field',()=>{
 const actionReq=[...requests].reverse().find(x=>x.kind==='action'&&x.params.action==='create_plan');
 assert.equal(actionReq.dueAt,'2027-10-12');assert.equal(actionReq.params.dueAt,undefined);
});
await click(findButton(document,'Назад'));
await click(findButton(document.querySelector('.tiles'),'Куда'));
await click(findButton(document,'В архив'));
pass('archive action sends scoped place metadata',()=>{
 const archiveReq=[...requests].reverse().find(x=>x.kind==='meta');assert.equal(archiveReq.section,'places');assert.equal(archiveReq.archive,true);assert.equal(archiveReq.id,'place-1');
});

await click(findButton(document,'Назад'));
fixture.plans=[{id:'sample-plan-photo',title:'Фото поездки',comment:'Семейный план',_photos:[{id:'sample-image',mime:'image/jpeg'}]}];
await click(findButton(document.querySelector('.tiles'),'Планы'));
pass('existing family plan shows photo gallery and attach control',()=>{
 assert(document.querySelector('.place-photos .photo-thumb img'));
 assert(findButton(document,'Прикрепить фото'));
});
fixture.plans=[];
console.log('UI AUDIT:',checks,'passed; simulated Telegram client, no browser and no real data mutation');
