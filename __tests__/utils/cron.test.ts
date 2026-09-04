import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  isValidCronExpression,
  sanitizeCronExpression,
  validateCronExpression,
} from "../../src/utils/cron.js";
import logger from "../../src/utils/logger.js";

// The nine scheduled services each used to carry their own copy of these two
// helpers (#851). These tests pin the shared behaviour they now depend on.
describe("sanitizeCronExpression", () => {
  it("trims surrounding whitespace", () => {
    expect(sanitizeCronExpression("  0 9 * * *  ")).toBe("0 9 * * *");
  });

  it("strips a wrapping pair of quotes left by .env-style values", () => {
    expect(sanitizeCronExpression('"0 9 * * *"')).toBe("0 9 * * *");
    expect(sanitizeCronExpression("'0 9 * * *'")).toBe("0 9 * * *");
  });

  it("leaves an already-clean expression untouched", () => {
    expect(sanitizeCronExpression("0 9 * * *")).toBe("0 9 * * *");
  });
});

describe("validateCronExpression", () => {
  let errorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    errorSpy = jest
      .spyOn(logger, "error")
      .mockImplementation((() => logger) as never);
    errorSpy.mockClear();
  });

  it("accepts a valid expression", () => {
    expect(validateCronExpression("0 9 * * *")).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("accepts a quoted expression, so raw config values can be passed in", () => {
    expect(validateCronExpression('"0 10 30 12 *"')).toBe(true);
  });

  it("rejects an unparseable expression instead of throwing", () => {
    expect(validateCronExpression("not a cron")).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("names the feature in the error log when a context is given", () => {
    validateCronExpression("nonsense", "birthdays");
    expect(String(errorSpy.mock.calls[0][0])).toContain(
      "Invalid cron expression for birthdays",
    );
  });

  it("sanitizes the logged expression so it cannot forge log lines", () => {
    validateCronExpression("bad\nINFO forged", "digest");
    expect(String(errorSpy.mock.calls[0][0])).not.toMatch(/[\r\n]/);
  });
});

// The WebUI form handlers validate admin-typed input, where a rejection is a
// field error rather than a fault, so they use the non-logging variant.
describe("isValidCronExpression", () => {
  let errorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    errorSpy = jest
      .spyOn(logger, "error")
      .mockImplementation((() => logger) as never);
    errorSpy.mockClear();
  });

  it("agrees with validateCronExpression on both valid and invalid input", () => {
    expect(isValidCronExpression("0 9 * * *")).toBe(true);
    expect(isValidCronExpression('"0 9 * * *"')).toBe(true);
    expect(isValidCronExpression("not a cron")).toBe(false);
  });

  it("never logs, however bad the input", () => {
    isValidCronExpression("not a cron");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
