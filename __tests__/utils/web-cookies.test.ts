import { describe, it, expect } from "@jest/globals";
import {
  signValue,
  verifySignedValue,
} from "../../src/web/cookies.js";

describe("web cookies signing", () => {
  const secret = "test-cookie-secret-32-bytes-of-x";

  it("round-trips a value through signValue/verifySignedValue", () => {
    const signed = signValue("hello.world", secret);
    expect(signed.startsWith("hello.world.")).toBe(true);
    expect(verifySignedValue(signed, secret)).toBe("hello.world");
  });

  it("rejects values with a tampered signature", () => {
    const signed = signValue("payload", secret);
    const tampered = signed.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect(verifySignedValue(tampered, secret)).toBeNull();
  });

  it("rejects values signed with a different secret", () => {
    const signed = signValue("payload", secret);
    expect(verifySignedValue(signed, "other-secret")).toBeNull();
  });

  it("returns null on malformed input", () => {
    expect(verifySignedValue("", secret)).toBeNull();
    expect(verifySignedValue("nodot", secret)).toBeNull();
    expect(verifySignedValue(".justsig", secret)).toBeNull();
    expect(verifySignedValue("noval.", secret)).toBeNull();
  });
});
