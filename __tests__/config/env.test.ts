import { describe, it, expect, afterEach } from "@jest/globals";

const ORIGINAL_ENV = { ...process.env };

const {
  env,
  getEnv,
  hasEnv,
  requireEnv,
  getMissingRequiredEnv,
} = await import("../../src/config/env.js");

describe("config/env", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe("getEnv / hasEnv", () => {
    it("reads arbitrary keys lazily from process.env", () => {
      process.env.SOME_DYNAMIC_KEY = "value-1";
      expect(getEnv("SOME_DYNAMIC_KEY")).toBe("value-1");

      process.env.SOME_DYNAMIC_KEY = "value-2";
      expect(getEnv("SOME_DYNAMIC_KEY")).toBe("value-2");
    });

    it("returns undefined for an unset key", () => {
      delete process.env.UNSET_KEY;
      expect(getEnv("UNSET_KEY")).toBeUndefined();
    });

    it("hasEnv distinguishes defined (even empty) from unset", () => {
      process.env.DEFINED_EMPTY = "";
      expect(hasEnv("DEFINED_EMPTY")).toBe(true);

      delete process.env.NOT_DEFINED;
      expect(hasEnv("NOT_DEFINED")).toBe(false);
    });
  });

  describe("requireEnv", () => {
    it("returns the value when present", () => {
      process.env.NEEDED = "here";
      expect(requireEnv("NEEDED")).toBe("here");
    });

    it("throws an informative error when missing", () => {
      delete process.env.NEEDED;
      expect(() => requireEnv("NEEDED")).toThrow(
        "Missing required environment variable: NEEDED",
      );
    });

    it("treats an empty string as missing", () => {
      process.env.NEEDED = "";
      expect(() => requireEnv("NEEDED")).toThrow();
    });
  });

  describe("getMissingRequiredEnv", () => {
    it("reports every required var that is absent", () => {
      delete process.env.DISCORD_TOKEN;
      delete process.env.CLIENT_ID;
      delete process.env.GUILD_ID;
      delete process.env.MONGODB_URI;
      expect(getMissingRequiredEnv()).toEqual([
        "DISCORD_TOKEN",
        "CLIENT_ID",
        "GUILD_ID",
        "MONGODB_URI",
      ]);
    });

    it("returns an empty list when all required vars are present", () => {
      process.env.DISCORD_TOKEN = "t";
      process.env.CLIENT_ID = "c";
      process.env.GUILD_ID = "g";
      process.env.MONGODB_URI = "m";
      expect(getMissingRequiredEnv()).toEqual([]);
    });
  });

  describe("typed env view", () => {
    it("exposes raw discord values lazily", () => {
      process.env.DISCORD_TOKEN = "tok";
      process.env.CLIENT_ID = "cid";
      process.env.GUILD_ID = "gid";
      expect(env.discordToken).toBe("tok");
      expect(env.clientId).toBe("cid");
      expect(env.guildId).toBe("gid");
    });

    it("defaults mongoUri when unset", () => {
      delete process.env.MONGODB_URI;
      expect(env.mongoUri).toBe("mongodb://mongodb:27017/koolbot");

      process.env.MONGODB_URI = "mongodb://custom:27017/db";
      expect(env.mongoUri).toBe("mongodb://custom:27017/db");
    });

    it("defaults nodeEnv to development and derives isProduction", () => {
      delete process.env.NODE_ENV;
      expect(env.nodeEnv).toBe("development");
      expect(env.isProduction).toBe(false);

      process.env.NODE_ENV = "production";
      expect(env.nodeEnv).toBe("production");
      expect(env.isProduction).toBe(true);
    });

    it("parses DEBUG strictly as the string 'true'", () => {
      process.env.DEBUG = "true";
      expect(env.debug).toBe(true);

      process.env.DEBUG = "1";
      expect(env.debug).toBe(false);

      delete process.env.DEBUG;
      expect(env.debug).toBe(false);
    });

    it("normalises WEBUI_ENABLED case-insensitively", () => {
      process.env.WEBUI_ENABLED = "TRUE";
      expect(env.webui.enabled).toBe(true);

      process.env.WEBUI_ENABLED = "false";
      expect(env.webui.enabled).toBe(false);

      delete process.env.WEBUI_ENABLED;
      expect(env.webui.enabled).toBe(false);
    });

    it("defaults webui.baseUrl to an empty string", () => {
      delete process.env.WEBUI_BASE_URL;
      expect(env.webui.baseUrl).toBe("");

      process.env.WEBUI_BASE_URL = "https://example.test";
      expect(env.webui.baseUrl).toBe("https://example.test");
    });
  });
});
