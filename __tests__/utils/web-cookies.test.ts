import { describe, it, expect } from "@jest/globals";
import { Request } from "express";
import {
  parseCookies,
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

describe("parseCookies", () => {
  function fakeReq(header?: string): Request {
    return { headers: { cookie: header } } as unknown as Request;
  }

  it("returns an empty Map when no cookie header is set", () => {
    const out = parseCookies(fakeReq());
    expect(out.size).toBe(0);
  });

  it("parses simple name=value pairs and decodes URI components", () => {
    const out = parseCookies(fakeReq("a=1; b=hello%20world"));
    expect(out.get("a")).toBe("1");
    expect(out.get("b")).toBe("hello world");
  });

  it("does not mutate Object.prototype on a malicious cookie name", () => {
    const before = (Object.prototype as unknown as { polluted?: string })
      .polluted;
    parseCookies(fakeReq("__proto__=polluted; constructor=evil"));
    const after = (Object.prototype as unknown as { polluted?: string })
      .polluted;
    expect(after).toBe(before);
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });
});
