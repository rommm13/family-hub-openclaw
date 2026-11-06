import test from "node:test";
import assert from "node:assert/strict";
import { createGwsCliRunner } from "../dist/calendar.js";

test("gws runner uses execFile argv without shell and parses JSON", async () => {
  const calls = [];
  const run = createGwsCliRunner({
    command: "/opt/gws",
    env: { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: "/state/gws" },
    execFile: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '{"items":[]}', stderr: "" };
    }
  });
  const result = await run(["calendar", "events", "list", "--params", '{"calendarId":"family"}']);
  assert.deepEqual(result, { items: [] });
  assert.equal(calls[0].command, "/opt/gws");
  assert.notEqual(calls[0].options.shell, true);
  assert.equal(calls[0].options.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR, "/state/gws");
});

test("gws runner fails closed on malformed JSON", async () => {
  const run = createGwsCliRunner({ execFile: async () => ({ stdout: "not-json", stderr: "" }) });
  await assert.rejects(() => run(["calendar", "calendarList", "list"]), /invalid gws JSON/i);
});
