import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { COMMAND_CONFIGS } from "../../src/services/command-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const commandManagerSource = fs.readFileSync(
  path.join(__dirname, "../../src/services/command-manager.ts"),
  "utf-8",
);

describe("CommandManager Methods", () => {
  it("should drive both loadCommandsDynamically and populateClientCommands from the shared registry", () => {
    // Extract the methods
    const loadCommandsMethod = commandManagerSource.match(
      /private async loadCommandsDynamically[\s\S]*?^\s{2}\}/m,
    );
    const populateCommandsMethod = commandManagerSource.match(
      /public async populateClientCommands[\s\S]*?^\s{2}\}/m,
    );

    expect(loadCommandsMethod).toBeTruthy();
    expect(populateCommandsMethod).toBeTruthy();

    // Both iterate the single COMMAND_CONFIGS list, so the Discord
    // registration and the execute handlers can never drift apart.
    expect(loadCommandsMethod?.[0]).toMatch(
      /for \(const \w+ of COMMAND_CONFIGS\)/,
    );
    expect(populateCommandsMethod?.[0]).toMatch(
      /for \(const \w+ of COMMAND_CONFIGS\)/,
    );

    // No method keeps its own local copy of the command list.
    expect(commandManagerSource).not.toMatch(/const commandConfigs\s*=/);
  });

  it("should have a unique name and a matching command module for every registry entry", () => {
    const names = COMMAND_CONFIGS.map((config) => config.name);
    expect(new Set(names).size).toBe(names.length);

    for (const config of COMMAND_CONFIGS) {
      const modulePath = path.join(
        __dirname,
        `../../src/commands/${config.file}.ts`,
      );
      expect(fs.existsSync(modulePath)).toBe(true);
    }
  });

  it("should register /config as the collapsed WebUI launcher", () => {
    // /config maps to src/commands/config.ts and is always enabled
    expect(COMMAND_CONFIGS).toContainEqual({
      name: "config",
      configKey: null,
      file: "config",
    });
  });

  it("should have help command without help.enabled gate", () => {
    expect(COMMAND_CONFIGS).toContainEqual({
      name: "help",
      configKey: null,
      file: "help",
    });
  });

  it("should not register any of the deprecated admin slash commands", () => {
    const removedCommands = [
      "permissions",
      "setup",
      "announce",
      "announce-vc-stats",
      "poll",
      "reactrole",
      "notice",
      "dbtrunk",
      "vc",
      "botstats",
    ];

    const registered = COMMAND_CONFIGS.map((config) => config.name);
    for (const name of removedCommands) {
      expect(registered).not.toContain(name);
    }
  });

  it("should use getBoolean() for config checks in both loadCommandsDynamically and populateClientCommands", () => {
    // Extract the methods
    const loadCommandsMethod = commandManagerSource.match(
      /private async loadCommandsDynamically[\s\S]*?^\s{2}\}/m,
    );
    const populateCommandsMethod = commandManagerSource.match(
      /public async populateClientCommands[\s\S]*?^\s{2}\}/m,
    );

    expect(loadCommandsMethod).toBeTruthy();
    expect(populateCommandsMethod).toBeTruthy();

    if (loadCommandsMethod && populateCommandsMethod) {
      const loadCommandsCode = loadCommandsMethod[0];
      const populateCommandsCode = populateCommandsMethod[0];

      // Both should use getBoolean() for consistency
      expect(loadCommandsCode).toMatch(/getBoolean\s*\(/);
      expect(populateCommandsCode).toMatch(/getBoolean\s*\(/);

      // Neither should use the problematic pattern: get() with strict equality
      const problematicPattern =
        /configService\.get\([^)]+\)[\s\S]*?===\s*true/;
      expect(populateCommandsCode).not.toMatch(problematicPattern);
    }
  });
});
