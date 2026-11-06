import {
  buildJsonPluginConfigSchema,
  definePluginEntry
} from "openclaw/plugin-sdk/plugin-entry";
import { FAMILY_CONFIG_JSON_SCHEMA } from "./plugin-config.js";
import { FAMILY_PLUGIN_METADATA } from "./plugin-metadata.js";
import { registerConfiguredFamilyHub } from "./index.js";
import { resolveTelegramAccount } from "openclaw/plugin-sdk/telegram-account";
import { createTelegramPersistentKeyboardInstaller } from "./telegram-keyboard.js";

const entry = definePluginEntry({
  id: FAMILY_PLUGIN_METADATA.id,
  name: FAMILY_PLUGIN_METADATA.name,
  description: FAMILY_PLUGIN_METADATA.description,
  configSchema: buildJsonPluginConfigSchema(FAMILY_CONFIG_JSON_SCHEMA),
  register(api) {
    const installPersistentKeyboard = createTelegramPersistentKeyboardInstaller({
      resolveAccount: ({ cfg, accountId }) => resolveTelegramAccount({ cfg, accountId })
    });
    registerConfiguredFamilyHub(api, { installPersistentKeyboard, resolveTelegramAccount });
  }
});

Object.defineProperty(entry, Symbol.for("openclaw.plugin-sdk.tool-plugin.metadata"), {
  value: FAMILY_PLUGIN_METADATA,
  enumerable: false
});

export default entry;
