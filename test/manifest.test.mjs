import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

test("manifest config schema matches runtime Family Hub config keys", () => {
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(manifest.configSchema.properties).sort(),
    ["agentId", "buttonText", "calendarAccount", "calendarId", "dataDir", "dbPath", "driveFolderId", "miniAppUrl", "placePhotoDir", "reminderTime", "reminderTimezone", "runtimeId", "surpriseAssetDir", "surpriseAutoMemberId", "surpriseManualLimit", "surpriseMediaDir", "surpriseUnlimitedMemberIds"].sort()
  );
});

test("manifest advertises the optional family tool", () => {
  assert.deepEqual(manifest.contracts?.tools, ["family"]);
  assert.equal(manifest.toolMetadata?.family?.optional, true);
});
