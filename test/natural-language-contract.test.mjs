import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_PARAMETERS } from "../dist/tool.js";

const here=path.dirname(fileURLToPath(import.meta.url));
const skillPath=path.resolve(here,"../skills/family-youme/SKILL.md");
const skill=fs.readFileSync(skillPath,"utf8");

const expectedActions=[
  "list_members","list","search_notes","get_poll","list_shopping","get_cashback","set_cashback",
  "create_note","update_note","delete_note",
  "create_wish","update_wish","remove_wish","reserve_wish",
  "create_place","update_place","delete_place",
  "create_plan","update_plan","archive_plan",
  "create_poll","vote_poll","close_poll",
  "create_goal","update_goal","complete_goal",
  "create_action","update_action","complete_action","cancel_action",
  "get_capsule","create_capsule","cancel_capsule",
  "get_calendar_event","create_calendar_event","update_calendar_event","delete_calendar_event",
  "add_shopping_items","toggle_shopping_item","clear_bought_shopping"
].sort();

test("family tool action contract is explicit and complete",()=>{
  assert.deepEqual([...TOOL_PARAMETERS.properties.action.enum].sort(),expectedActions);
});

test("Family YouMe skill documents all writable API paths",()=>{
  for(const action of expectedActions.filter(x=>!['list_members','list','search_notes','get_poll','get_capsule','get_calendar_event','list_shopping'].includes(x))){
    assert.match(skill,new RegExp(`\\b${action}\\b`),`skill missing ${action}`);
  }
  assert.doesNotMatch(skill,/capsule creation.*not supported|creation\/unlock scheduling is not supported/iu);
  assert.match(skill,/семейн.{0,20}календар/iu);
  assert.match(skill,/событи/iu);
});

test("Family YouMe skill keeps GWS-only and no direct storage bypass",()=>{
  assert.match(skill,/Use the OpenClaw tool `family` as the only operational API/i);
  assert.doesNotMatch(skill,/\bgog\b/iu);
  assert.match(skill,/do not create a second event yourself/i);
});
