import { describe, it, expect } from "@jest/globals";
import { data } from "../../src/commands/config.js";

describe("Config Command (WebUI launcher)", () => {
  it("should have correct command name", () => {
    expect(data.name).toBe("config");
  });

  it("should have a description", () => {
    expect(data.description).toBeDefined();
    expect(typeof data.description).toBe("string");
  });

  it("should be a valid slash command", () => {
    const json = data.toJSON();
    expect(json).toHaveProperty("name", "config");
    expect(json).toHaveProperty("description");
  });

  it("should require administrator permissions", () => {
    const json = data.toJSON();
    expect(json.default_member_permissions).toBeDefined();
  });

  it("should expose only the web subcommand", () => {
    const json = data.toJSON();
    expect(json.options).toBeDefined();
    expect(json.options?.length).toBe(1);
    const sub = json.options?.[0];
    expect(sub?.name).toBe("web");
    expect((sub as { type?: number })?.type).toBe(1);
  });

  it("should not have any legacy subcommands (list/set/import/export/reset/reload)", () => {
    const json = data.toJSON();
    const removed = ["list", "set", "import", "export", "reset", "reload"];
    const names = (json.options ?? []).map((opt: { name: string }) => opt.name);
    for (const name of removed) {
      expect(names).not.toContain(name);
    }
  });
});
