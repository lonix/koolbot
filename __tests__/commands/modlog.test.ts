import { describe, it, expect } from "@jest/globals";
import { data, actionLabel } from "../../src/commands/modlog.js";

describe("Modlog Command", () => {
  it("has the correct command name", () => {
    expect(data.name).toBe("modlog");
  });

  it("has a description", () => {
    expect(data.description.length).toBeGreaterThan(0);
  });

  it("requires a user option and an optional page option", () => {
    const json = data.toJSON();
    expect(json.options?.[0]).toMatchObject({
      name: "user",
      type: 6, // User
      required: true,
    });
    expect(json.options?.[1]).toMatchObject({
      name: "page",
      type: 4, // Integer
    });
    expect(json.options?.[1]?.required ?? false).toBe(false);
  });

  it("defaults to the Moderate Members permission", () => {
    const json = data.toJSON();
    expect(json.default_member_permissions).toBe((1n << 40n).toString());
  });

  describe("actionLabel", () => {
    it("renders a label for every action", () => {
      expect(actionLabel("warn")).toContain("Warn");
      expect(actionLabel("kick")).toContain("Kick");
      expect(actionLabel("ban")).toContain("Ban");
      expect(actionLabel("unban")).toContain("Unban");
      expect(actionLabel("timeout")).toContain("Timeout");
      expect(actionLabel("untimeout")).toContain("lifted");
    });
  });
});
