import { FAMILY_CONFIG_JSON_SCHEMA } from "./plugin-config.js";
import { TOOL_PARAMETERS } from "./tool.js";

export const FAMILY_PLUGIN_METADATA = {
  id: "family-hub",
  name: "Family Hub",
  description: "Shared family state, Telegram Mini App and trusted family workflows.",
  activation: { onStartup: true },
  configSchema: FAMILY_CONFIG_JSON_SCHEMA,
  tools: [{
    name: "family",
    label: "Family Hub",
    description: "Read and update trusted Family Hub records for the current human member.",
    parameters: TOOL_PARAMETERS,
    optional: true
  }]
};
