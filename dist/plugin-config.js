export const FAMILY_CONFIG_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    dataDir: { type: "string" },
    dbPath: { type: "string" },
    runtimeId: { type: "string" },
    agentId: { type: "string" },
    buttonText: { type: "string" },
    calendarId: { type: "string" },
    calendarAccount: { type: "string" },
    miniAppUrl: { type: "string" },
    driveFolderId: { type: "string" },
    placePhotoDir: { type: "string" },
    reminderTime: { type: "string" },
    reminderTimezone: { type: "string" },
    surpriseAssetDir: { type: "string" },
    surpriseMediaDir: { type: "string" },
    surpriseAutoMemberId: { type: "string" },
    surpriseManualLimit: { type: "number" },
    surpriseUnlimitedMemberIds: { type: "array", items: { type: "string" } }
  }
};
