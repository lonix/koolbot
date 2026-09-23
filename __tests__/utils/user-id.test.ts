import { describe, it, expect } from "@jest/globals";
import {
  isSameUserId,
  normalizeUserId,
  userIdMatchForms,
} from "../../src/utils/user-id.js";

/**
 * The legacy-id helpers shared by every path that looks a member up in the
 * quote collection (#775, #958). Quotes imported before ids were normalised
 * store `<@123>`, `<@!123>` or `@123`, so readers, counters and the purge all
 * have to agree on which stored strings are the same person.
 */
describe("normalizeUserId", () => {
  it("strips every mention wrapper down to the snowflake", () => {
    expect(normalizeUserId("<@123>")).toBe("123");
    expect(normalizeUserId("<@!123>")).toBe("123");
    expect(normalizeUserId("@123")).toBe("123");
    expect(normalizeUserId("123")).toBe("123");
  });

  it("leaves an unparseable value alone", () => {
    expect(normalizeUserId("@someone")).toBe("@someone");
    expect(normalizeUserId("member-1")).toBe("member-1");
  });
});

describe("userIdMatchForms", () => {
  it("lists all four stored forms whichever one it is given", () => {
    const expected = ["123", "<@123>", "<@!123>", "@123"];
    expect(userIdMatchForms("123")).toEqual(expected);
    expect(userIdMatchForms("<@123>")).toEqual(expected);
    expect(userIdMatchForms("<@!123>")).toEqual(expected);
  });
});

describe("isSameUserId", () => {
  it("matches a stored legacy form against a bare snowflake", () => {
    expect(isSameUserId("<@123>", "123")).toBe(true);
    expect(isSameUserId("<@!123>", "123")).toBe(true);
    expect(isSameUserId("@123", "123")).toBe(true);
    expect(isSameUserId("123", "<@123>")).toBe(true);
  });

  it("rejects a different user and a non-string field", () => {
    expect(isSameUserId("<@456>", "123")).toBe(false);
    expect(isSameUserId(undefined, "123")).toBe(false);
    expect(isSameUserId(123, "123")).toBe(false);
  });
});
