import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FAMILY_CONFIG_JSON_SCHEMA } from "../dist/plugin-config.js";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const manifest = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

test("package uses thin official plugin entry", () => {
  assert.deepEqual(pkg.openclaw.extensions, ["./dist/plugin.js"]);
});

test("runtime and manifest share the same Family Hub config schema", () => {
  assert.deepEqual(manifest.configSchema, FAMILY_CONFIG_JSON_SCHEMA);
});
test("thin entry uses public Telegram account facade for persistent Family keyboard", () => {
  const source = fs.readFileSync(new URL("../dist/plugin.js", import.meta.url), "utf8");
  assert.match(source, /openclaw\/plugin-sdk\/telegram-account/);
  assert.match(source, /createTelegramPersistentKeyboardInstaller/);
  assert.match(source, /installPersistentKeyboard/);
});