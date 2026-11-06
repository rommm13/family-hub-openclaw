import test from "node:test";
import assert from "node:assert/strict";
import { FAMILY_PLUGIN_METADATA } from "../dist/plugin-metadata.js";

test("plugin exposes OpenClaw authoring metadata for optional family tool", () => {
  assert.equal(FAMILY_PLUGIN_METADATA.id, "family-hub");
  assert.equal(FAMILY_PLUGIN_METADATA.name, "Family Hub");
  assert.deepEqual(FAMILY_PLUGIN_METADATA.activation, { onStartup: true });
  assert.equal(FAMILY_PLUGIN_METADATA.tools.length, 1);
  assert.equal(FAMILY_PLUGIN_METADATA.tools[0].name, "family");
  assert.equal(FAMILY_PLUGIN_METADATA.tools[0].optional, true);
  assert.deepEqual(
    Object.keys(FAMILY_PLUGIN_METADATA.configSchema.properties).sort(),
    ["agentId", "buttonText", "calendarAccount", "calendarId", "dataDir", "dbPath", "driveFolderId", "miniAppUrl", "placePhotoDir", "reminderTime", "reminderTimezone", "runtimeId", "surpriseAssetDir", "surpriseAutoMemberId", "surpriseManualLimit", "surpriseMediaDir", "surpriseUnlimitedMemberIds"].sort()
  );
});
