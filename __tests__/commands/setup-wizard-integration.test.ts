import { describe, it, expect } from '@jest/globals';

/**
 * Integration test for setup wizard quotes configuration
 * This test validates the fix for the issue where running `/setup wizard quotes`
 * would show "Feature configuration for quotes is being set up..." but then nothing happened.
 */
describe('Setup Wizard Integration', () => {
  describe('startFeatureConfiguration export', () => {
    it('should export startFeatureConfiguration from setup-wizard-helpers', async () => {
      // This validates that the function is properly exported and can be imported
      const helpers = await import('../../src/commands/setup-wizard-helpers.js');
      expect(helpers.startFeatureConfiguration).toBeDefined();
      expect(typeof helpers.startFeatureConfiguration).toBe('function');
    });
  });

  describe('module imports', () => {
    it('should successfully import setup-wizard module with helper dependency', async () => {
      // This validates that setup-wizard.ts properly imports from setup-wizard-helpers.ts
      // and doesn't have circular dependencies or missing imports
      const setupWizard = await import('../../src/commands/setup-wizard.js');
      expect(setupWizard.data).toBeDefined();
      expect(setupWizard.execute).toBeDefined();
    });

    it('should have setup command with wizard subcommand', async () => {
      const setupWizard = await import('../../src/commands/setup-wizard.js');
      const json = setupWizard.data.toJSON();
      
      expect(json.name).toBe('setup');
      expect(json.options).toBeDefined();
      
      const wizardSubcommand = json.options?.find((opt: any) => opt.name === 'wizard');
      expect(wizardSubcommand).toBeDefined();
      expect(wizardSubcommand?.type).toBe(1); // Type 1 is SUB_COMMAND
    });

    it('should have quotes feature option in wizard subcommand', async () => {
      const setupWizard = await import('../../src/commands/setup-wizard.js');
      const json = setupWizard.data.toJSON();
      
      const wizardSubcommand = json.options?.find((opt: any) => opt.name === 'wizard');
      const featureOption = wizardSubcommand?.options?.find((opt: any) => opt.name === 'feature');
      
      expect(featureOption).toBeDefined();
      expect(featureOption?.choices).toBeDefined();
      
      const quotesChoice = featureOption?.choices?.find((choice: any) => choice.value === 'quotes');
      expect(quotesChoice).toBeDefined();
      expect(quotesChoice?.name).toBe('Quote System');
    });
  });
});
