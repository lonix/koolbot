import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("CommandManager Methods", () => {
  it("should have matching command arrays in loadCommandsDynamically and populateClientCommands", () => {
    // Read the command-manager.ts file
    const filePath = path.join(
      __dirname,
      "../../src/services/command-manager.ts",
    );
    const fileContent = fs.readFileSync(filePath, "utf-8");

    // Extract command names from both arrays
    const loadCommandsMatch = fileContent.match(
      /private async loadCommandsDynamically[\s\S]*?const commandConfigs = \[([\s\S]*?)\];/,
    );
    const populateCommandsMatch = fileContent.match(
      /public async populateClientCommands[\s\S]*?const commandConfigs = \[([\s\S]*?)\];/,
    );

    expect(loadCommandsMatch).toBeTruthy();
    expect(populateCommandsMatch).toBeTruthy();

    if (loadCommandsMatch && populateCommandsMatch) {
      const loadCommands = loadCommandsMatch[1];
      const populateCommands = populateCommandsMatch[1];

      // Extract command names using regex
      const extractNames = (text: string): string[] => {
        const nameRegex = /name:\s*"([^"]+)"/g;
        const names: string[] = [];
        let match;
        while ((match = nameRegex.exec(text)) !== null) {
          names.push(match[1]);
        }
        return names.sort();
      };

      const loadCommandNames = extractNames(loadCommands);
      const populateCommandNames = extractNames(populateCommands);

      // Both arrays should have the same commands
      expect(loadCommandNames).toEqual(populateCommandNames);

      // /config is the sole admin slash command after the v1.0 cut
      expect(loadCommandNames).toContain("config");
      expect(populateCommandNames).toContain("config");
    }
  });

  it("should register /config as the collapsed WebUI launcher", () => {
    const filePath = path.join(
      __dirname,
      "../../src/services/command-manager.ts",
    );
    const fileContent = fs.readFileSync(filePath, "utf-8");

    // /config maps to src/commands/config.ts and is always enabled
    const configCommandPattern =
      /{\s*name:\s*"config",\s*configKey:\s*null,\s*file:\s*"config"\s*}/g;
    const matches = fileContent.match(configCommandPattern);
    expect(matches).not.toBeNull();
    // Once in loadCommandsDynamically and once in populateClientCommands
    expect(matches?.length).toBe(2);
  });

  it("should have help command without help.enabled gate", () => {
    const filePath = path.join(
      __dirname,
      "../../src/services/command-manager.ts",
    );
    const fileContent = fs.readFileSync(filePath, "utf-8");

    // Check that help command has configKey: null (always enabled)
    const helpCommandPatterns = [
      /{\s*name:\s*"help",\s*configKey:\s*null,\s*file:\s*"help"\s*}/,
    ];

    let foundHelpWithNull = false;
    for (const pattern of helpCommandPatterns) {
      if (pattern.test(fileContent)) {
        foundHelpWithNull = true;
        break;
      }
    }

    expect(foundHelpWithNull).toBe(true);
  });

  it("should not register any of the deprecated admin slash commands", () => {
    const filePath = path.join(
      __dirname,
      "../../src/services/command-manager.ts",
    );
    const fileContent = fs.readFileSync(filePath, "utf-8");

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

    for (const name of removedCommands) {
      const pattern = new RegExp(`name:\\s*"${name}"`);
      expect(fileContent).not.toMatch(pattern);
    }
  });

  it("should use getBoolean() for config checks in both loadCommandsDynamically and populateClientCommands", () => {
    const filePath = path.join(
      __dirname,
      "../../src/services/command-manager.ts",
    );
    const fileContent = fs.readFileSync(filePath, "utf-8");

    // Extract the methods
    const loadCommandsMethod = fileContent.match(
      /private async loadCommandsDynamically[\s\S]*?^\s{2}\}/m,
    );
    const populateCommandsMethod = fileContent.match(
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
