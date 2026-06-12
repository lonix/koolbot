import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import crypto from "crypto";
import {
  MIN_SESSION_SECRET_BYTES,
  validateWebUIEnvVars,
} from "../../src/web/index.js";

const ORIGINAL_ENV = { ...process.env };

/**
 * Covers the startup/`/config` validation path for an enabled WebUI
 * (issue #538): required vars must be present AND the session secret must
 * be at least MIN_SESSION_SECRET_BYTES bytes long so it is a usable HMAC key.
 */
describe("validateWebUIEnvVars", () => {
  beforeEach(() => {
    delete process.env.WEBUI_BASE_URL;
    delete process.env.WEBUI_SESSION_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports both required vars as missing when neither is set", () => {
    const errors = validateWebUIEnvVars();
    expect(errors).toEqual(
      expect.arrayContaining([
        "WEBUI_BASE_URL is missing",
        "WEBUI_SESSION_SECRET is missing",
      ]),
    );
  });

  it("flags a short placeholder secret as too weak", () => {
    process.env.WEBUI_BASE_URL = "https://bot.example.com";
    process.env.WEBUI_SESSION_SECRET = "replace-me";

    const errors = validateWebUIEnvVars();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`at least ${MIN_SESSION_SECRET_BYTES} bytes`);
    expect(errors[0]).toContain("openssl rand -base64 32");
  });

  it.each(["abc", "password", "short-secret"])(
    "rejects the weak secret %p",
    (weak) => {
      process.env.WEBUI_BASE_URL = "https://bot.example.com";
      process.env.WEBUI_SESSION_SECRET = weak;

      const errors = validateWebUIEnvVars();
      expect(errors.some((e) => e.includes("at least"))).toBe(true);
    },
  );

  it("accepts a base64-encoded 32-byte secret (openssl rand -base64 32)", () => {
    process.env.WEBUI_BASE_URL = "https://bot.example.com";
    process.env.WEBUI_SESSION_SECRET = crypto
      .randomBytes(32)
      .toString("base64");

    expect(validateWebUIEnvVars()).toEqual([]);
  });

  it("accepts a 64-char hex secret", () => {
    process.env.WEBUI_BASE_URL = "https://bot.example.com";
    process.env.WEBUI_SESSION_SECRET = crypto.randomBytes(32).toString("hex");

    expect(validateWebUIEnvVars()).toEqual([]);
  });

  it("accepts a long arbitrary passphrase of 32+ raw bytes", () => {
    process.env.WEBUI_BASE_URL = "https://bot.example.com";
    // 40 ASCII chars = 40 raw bytes, comfortably over the floor.
    process.env.WEBUI_SESSION_SECRET = "x".repeat(40);

    expect(validateWebUIEnvVars()).toEqual([]);
  });

  it("does not duplicate the strength error when the secret is absent", () => {
    process.env.WEBUI_BASE_URL = "https://bot.example.com";

    const errors = validateWebUIEnvVars();
    expect(errors).toEqual(["WEBUI_SESSION_SECRET is missing"]);
  });
});
