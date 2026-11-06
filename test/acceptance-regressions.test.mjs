import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import {
  createPlan, archivePlan, createMoneyGoal, completeMoneyGoal, listSection,
  createPoll, votePoll, closePoll, createCapsule, cancelCapsule, getCapsuleForViewer,
  createNote
} from "../dist/domain.js";
import { createFamilyRuntime } from "../dist/index.js";

function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"family-accept-reg-"));
  const db=openFamilyDb(path.join(dir,"family.sqlite"));
  bootstrapFamily(db,{
    household:{id:"home",name:"Семья"},
    members:[
      {id:"participant_alpha",name:"Иван",role:"parent"},
      {id:"participant_beta",name:"Мария",role:"parent"}
    ],
    bindings:[
      {runtimeId:"agent_core",agentId:"main",memberId:"participant_alpha"},
      {runtimeId:"agent_core",agentId:"agent_second",memberId:"participant_beta"}
    ]
  });
  return {dir,db};
}
function cleanup(fx){fx.db.close();fs.rmSync(fx.dir,{recursive:true,force:true});}

test("archived plans and completed goals leave the active planning view",()=>{
  const fx=fixture();
  try{
    const plan=createPlan(fx.db,{householdId:"home",createdBy:"participant_alpha",title:"Trip",participants:["participant_alpha","participant_beta"]});
    const goal=createMoneyGoal(fx.db,{householdId:"home",createdBy:"participant_alpha",assigneeId:"participant_alpha",title:"Goal",amount:100,dueAt:"2027-01-01"});
    archivePlan(fx.db,plan.id,"participant_alpha");
    completeMoneyGoal(fx.db,goal.id,"participant_alpha");
    assert.equal(listSection(fx.db,"plans","participant_alpha",100).some(x=>x.id===plan.id),false);
    assert.equal(listSection(fx.db,"goals","participant_alpha",100).some(x=>x.id===goal.id),false);
  } finally { cleanup(fx); }
});

test("closed polls reject new or changed votes",()=>{
  const fx=fixture();
  try{
    const poll=createPoll(fx.db,{householdId:"home",createdBy:"participant_alpha",question:"Where?",options:["A","B"],participants:["participant_alpha","participant_beta"]});
    votePoll(fx.db,poll.id,"participant_alpha",0);
    closePoll(fx.db,poll.id,"participant_alpha");
    assert.throws(()=>votePoll(fx.db,poll.id,"participant_beta",1),/closed/i);
    assert.throws(()=>votePoll(fx.db,poll.id,"participant_alpha",1),/closed/i);
  } finally { cleanup(fx); }
});

test("cancelled capsules disappear and cannot leak payload to recipient",()=>{
  const fx=fixture();
  try{
    const capsule=createCapsule(fx.db,{
      householdId:"home",authorId:"participant_alpha",recipientId:"participant_beta",
      unlockAt:"2027-01-01T12:00:00Z",payload:"secret"
    });
    cancelCapsule(fx.db,capsule.id,"participant_alpha");
    assert.equal(getCapsuleForViewer(fx.db,capsule.id,"participant_beta",new Date("2028-01-01T00:00:00Z")),null);
    assert.equal(getCapsuleForViewer(fx.db,capsule.id,"participant_alpha",new Date("2028-01-01T00:00:00Z")),null);
    assert.equal(listSection(fx.db,"capsules","participant_beta",100).some(x=>x?.id===capsule.id),false);
    assert.equal(listSection(fx.db,"capsules","participant_alpha",100).some(x=>x?.id===capsule.id),false);
  } finally { cleanup(fx); }
});

test("item and confirmation close controls use the friendly close label",async()=>{
  const fx=fixture();
  try{
    const note=createNote(fx.db,{householdId:"home",createdBy:"participant_alpha",title:"N",body:"B"});
    const runtime=createFamilyRuntime({db:fx.db,runtimeId:"agent_core",agentId:"main"});
    const click=async payload=>{
      const edits=[];
      await runtime.interactive.handler({
        sessionKey:"agent:main:telegram:direct:123",
        auth:{isAuthorizedSender:true},callback:{payload},
        respond:{async editMessage(v){edits.push(v)},async reply(){}}
      });
      return edits.at(-1);
    };
    let view=await click(`item:notes:${note.id}`);
    assert(view.buttons.flat().some(b=>b.callback_data==="family:close"&&b.text==="👋 Закрыть"));
    view=await click(`do:delete:notes:${note.id}`);
    assert(view.buttons.flat().some(b=>b.callback_data==="family:close"&&b.text==="👋 Закрыть"));
  } finally { cleanup(fx); }
});
