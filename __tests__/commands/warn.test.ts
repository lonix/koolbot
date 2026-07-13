import { describe, it, expect } from "@jest/globals";
import { data } from "../../src/commands/warn.js";

describe("Warn Command", () => {
  it("has the correct command name", () => {
    expect(data.name).toBe("warn");
  });

  it("has a description", () => {
    expect(data.description.length).toBeGreaterThan(0);
  });

  it("requires a user and a reason option", () => {
    const json = data.toJSON();
    expect(json.options?.[0]).toMatchObject({
      name: "user",
      type: 6, // User
      required: true,
    });
    expect(json.options?.[1]).toMatchObject({
      name: "reason",
      type: 3, // String
      required: true,
    });
  });

  it("defaults to the Moderate Members permission", () => {
    const json = data.toJSON();
    // ModerateMembers = 1 << 40. default_member_permissions is the decimal
    // string of the permission bitfield.
    expect(json.default_member_permissions).toBe((1n << 40n).toString());
  });
});
