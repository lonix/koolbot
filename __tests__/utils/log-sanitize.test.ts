import { describe, it, expect } from "@jest/globals";
import { sanitizeForLog } from "../../src/utils/log-sanitize.js";

// This suite pins the central log-injection mitigation. CodeQL's
// js/log-injection query is excluded (see .github/codeql/codeql-config.yml)
// on the basis that every user-controlled value interpolated into a log line
// passes through sanitizeForLog. These tests guarantee that helper keeps
// neutralising newline/control-character injection so that assumption holds.
describe("sanitizeForLog", () => {
  it("strips CR and LF so an attacker cannot forge extra log lines", () => {
    expect(sanitizeForLog("alice\nADMIN logged in")).toBe(
      "alice ADMIN logged in",
    );
    expect(sanitizeForLog("a\rb")).toBe("a b");
    // Each CR/LF is replaced individually, so CRLF becomes two spaces.
    expect(sanitizeForLog("a\r\nb")).toBe("a  b");
  });

  it("never returns a string containing CR or LF, whatever the input", () => {
    const hostile = "line1\nline2\r\nline3\rline4";
    const out = sanitizeForLog(hostile);
    expect(out).not.toMatch(/[\r\n]/);
  });

  it("strips other control characters", () => {
    expect(sanitizeForLog("a\x00b\x1fc\x7fd")).toBe("a b c d");
    expect(sanitizeForLog("tab\there")).toBe("tab here");
  });

  it("returns an empty string for null or undefined", () => {
    expect(sanitizeForLog(null)).toBe("");
    expect(sanitizeForLog(undefined)).toBe("");
  });

  it("coerces non-string values to a string", () => {
    expect(sanitizeForLog(42)).toBe("42");
    expect(sanitizeForLog(true)).toBe("true");
  });

  it("truncates overly long values with an ellipsis", () => {
    const long = "x".repeat(200);
    const out = sanitizeForLog(long);
    expect(out).toHaveLength(129); // 128 chars + the ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("respects a custom maxLength", () => {
    expect(sanitizeForLog("abcdef", 3)).toBe("abc…");
  });

  it("leaves a clean value within the limit untouched", () => {
    expect(sanitizeForLog("clean-value_123")).toBe("clean-value_123");
  });
});
