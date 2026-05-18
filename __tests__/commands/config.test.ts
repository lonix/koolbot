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

  it("should expose no subcommands (bare /config launches the WebUI)", () => {
    const json = data.toJSON();
    const subcommands = (json.options ?? []).filter(
      (opt: { type?: number }) => opt.type === 1,
    );
    expect(subcommands.length).toBe(0);
  });

  it("should not register any legacy subcommands", () => {
    const json = data.toJSON();
    const removed = [
      "list",
      "set",
      "import",
      "export",
      "reset",
      "reload",
      "web",
    ];
    const names = (json.options ?? []).map((opt: { name: string }) => opt.name);
    for (const name of removed) {
      expect(names).not.toContain(name);
    }
  });
});
