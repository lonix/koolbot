/**
 * Unit tests for write-routes helpers and exported constants.
 * These tests do not require a Discord client or MongoDB connection.
 */
import { describe, it, expect } from "@jest/globals";
import { PROTECTED_KEYS } from "../../src/web/write-routes.js";

describe("PROTECTED_KEYS", () => {
  it("includes all known bootstrap / env keys", () => {
    const required = [
      "DISCORD_TOKEN",
      "CLIENT_ID",
      "GUILD_ID",
      "MONGODB_URI",
      "NODE_ENV",
      "DEBUG",
      "WEBUI_ENABLED",
      "WEBUI_BASE_URL",
      "WEBUI_SESSION_SECRET",
      "WEBUI_SESSION_TTL_MINUTES",
      "WEBUI_INACTIVITY_TIMEOUT_MINUTES",
    ];
    for (const key of required) {
      expect(PROTECTED_KEYS.has(key)).toBe(true);
    }
  });

  it("does not include regular DB-backed settings", () => {
    expect(PROTECTED_KEYS.has("voicechannels.enabled")).toBe(false);
    expect(PROTECTED_KEYS.has("quotes.max_length")).toBe(false);
    expect(PROTECTED_KEYS.has("polls.enabled")).toBe(false);
  });
});
