import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { listSection } from "../dist/domain.js";
import { createFamilyRuntime } from "../dist/index.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-youme-create-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Семья" },
    members: [
      { id: "participant_alpha", name: "Иван", role: "parent" },
      { id: "participant_beta", name: "Мария", role: "parent" }
    ],
    bindings: [
      { runtimeId: "agent_core", agentId: "main", memberId: "participant_alpha" },
      { runtimeId: "agent_core", agentId: "agent_second", memberId: "participant_beta" }
    ]
  });
  return { dir, db };
}

function ctx() { return { sessionKey: "agent:main:main", conversationId: "123", accountId: "default" }; }
async function click(runtime, payload) {
  const edits=[]; const replies=[];
  await runtime.interactive.handler({
    sessionKey: "agent:main:telegram:direct:123",
    auth: { isAuthorizedSender: true }, callback: { payload },
    respond: { async editMessage(v){edits.push(v)}, async reply(v){replies.push(v)} }
  });
  return { edits, replies };
}
async function say(runtime, text) {
  return runtime.beforeDispatch({ content: text, channel: "telegram" }, ctx());
}

const cases = [
  { section:"notes", inputs:["Wi-Fi", "Пароль у роутера"], assertRow:r=>r.title==="Wi-Fi" && r.body==="Пароль у роутера" },
  { section:"wishes", inputs:["Новый рюкзак", "-"] , assertRow:r=>r.title==="Новый рюкзак" },
  { section:"places", inputs:["Парк Горького", "https://maps.google.com/?q=gorky"] , assertRow:r=>r.name==="Парк Горького" && /maps/.test(r.mapsUrl) },
  { section:"plans", inputs:["Выходные в Питере", "Поездка на два дня"] , assertRow:r=>r.title==="Выходные в Питере" },
  { section:"polls", inputs:["Куда пойдём?", "Кино, Театр, Парк"] , assertRow:r=>r.question==="Куда пойдём?" },
  { section:"goals", inputs:["Отпуск", "150000", "30.12.2026"] , assertRow:r=>r.title==="Отпуск" && r.amount===150000 },
];

for (const c of cases) {
  test(`button wizard creates ${c.section}`, async () => {
    const fx=fixture();
    try {
      const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",now:()=>Date.parse("2026-09-17T09:00:00Z")});
      const start=await click(runtime,`create:${c.section}`);
      assert.equal(start.edits.length,1);
      assert.match(start.edits[0].text,/Введите|Название|Вопрос|Что/i);
      let response;
      for (const input of c.inputs) response=await say(runtime,input);
      assert.equal(response.handled,true);
      const rows=listSection(fx.db,c.section,"participant_alpha",20);
      assert.equal(rows.length,1);
      assert(c.assertRow(rows[0]));
    } finally { fx.db.close(); fs.rmSync(fx.dir,{recursive:true,force:true}); }
  });
}

test("action wizard requires a date and creates dated action with calendar outbox", async () => {
  const fx=fixture();
  try {
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main",now:()=>Date.parse("2026-09-17T09:00:00Z")});
    await click(runtime,"create:actions");
    assert.match((await say(runtime,"Купить торт")).text,/Кому/i);
    assert.match((await say(runtime,"Мария")).text,/Когда\?/);
    const done=await say(runtime,"19.09 14:00");
    assert.equal(done.handled,true);
    const rows=listSection(fx.db,"actions","participant_alpha",20);
    assert.equal(rows.length,1);
    assert.equal(rows[0].assigneeId,"participant_beta");
    assert.equal(rows[0].dueAt,"2026-09-19T14:00:00+03:00");
    const outbox=fx.db.prepare("SELECT kind,payload_json AS payload FROM outbox ORDER BY id").all();
    assert(outbox.some(row=>row.kind==="calendar_action_upsert"));
    assert(outbox.some(row=>row.kind==="text"));
  } finally { fx.db.close(); fs.rmSync(fx.dir,{recursive:true,force:true}); }
});

test("notes search button runs a one-message search wizard", async () => {
  const fx=fixture();
  try {
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main"});
    await click(runtime,"create:notes"); await say(runtime,"Wi-Fi"); await say(runtime,"Пароль у роутера");
    const start=await click(runtime,"search:notes");
    assert.match(start.edits[0].text,/поиск/i);
    const found=await say(runtime,"роутер");
    assert.match(found.text,/Wi-Fi/);
  } finally { fx.db.close(); fs.rmSync(fx.dir,{recursive:true,force:true}); }
});

test("wizard state follows the trusted member across OpenClaw session-key normalization", async () => {
  const fx=fixture();
  try {
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main"});
    const edits=[];
    await runtime.interactive.handler({
      sessionKey:"agent:main:telegram:direct:123",
      auth:{isAuthorizedSender:true},callback:{payload:"create:notes"},
      respond:{async editMessage(v){edits.push(v)},async reply(){}}
    });
    const otherMember=await runtime.beforeDispatch(
      {content:"Чужой заголовок",channel:"telegram"},
      {sessionKey:"agent:agent_second:telegram:direct:999",conversationId:"999",accountId:"agent_second"}
    );
    assert.equal(otherMember,undefined);
    const normalized=await runtime.beforeDispatch(
      {content:"Мой заголовок",channel:"telegram"},
      {sessionKey:"agent:main:main",conversationId:"123",accountId:"default"}
    );
    assert.equal(normalized.handled,true);
    assert.match(normalized.text,/текст/i);
  } finally { fx.db.close(); fs.rmSync(fx.dir,{recursive:true,force:true}); }
});
