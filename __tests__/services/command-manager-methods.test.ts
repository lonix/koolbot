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

      // Specifically check for critical commands that must be in sync
      expect(loadCommandNames).toContain("setup");
      expect(populateCommandNames).toContain("setup");
    }
  });

  it("should have setup command without wizard.enabled gate", () => {
    const filePath = path.join(
      __dirname,
      "../../src/services/command-manager.ts",
    );
    const fileContent = fs.readFileSync(filePath, "utf-8");

    // Check that setup command has configKey: null (always enabled)
    const setupCommandPatterns = [
      /{\s*name:\s*"setup",\s*configKey:\s*null,\s*file:\s*"setup-wizard"\s*}/g,
    ];

    let foundSetupWithNull = false;
    for (const pattern of setupCommandPatterns) {
      if (pattern.test(fileContent)) {
        foundSetupWithNull = true;
        break;
      }
    }

    expect(foundSetupWithNull).toBe(true);
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
