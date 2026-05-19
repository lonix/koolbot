import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { shouldUseSecureCookies } from "../../src/web/csrf.js";

const ORIGINAL_ENV = { ...process.env };

describe("shouldUseSecureCookies", () => {
  beforeEach(() => {
    delete process.env.WEBUI_BASE_URL;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns true when WEBUI_BASE_URL is https", () => {
    process.env.WEBUI_BASE_URL = "https://admin.example.com";
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it("returns false when WEBUI_BASE_URL is http (even in production)", () => {
    process.env.WEBUI_BASE_URL = "http://192.168.1.10:3000";
    process.env.NODE_ENV = "production";
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it("falls back to NODE_ENV=production when WEBUI_BASE_URL is missing", () => {
    process.env.NODE_ENV = "production";
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it("falls back to false when WEBUI_BASE_URL is missing and NODE_ENV is not production", () => {
    process.env.NODE_ENV = "development";
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it("falls back to NODE_ENV check on malformed WEBUI_BASE_URL", () => {
    process.env.WEBUI_BASE_URL = "ws://not-a-real-scheme";
    process.env.NODE_ENV = "production";
    expect(shouldUseSecureCookies()).toBe(true);
  });
});
