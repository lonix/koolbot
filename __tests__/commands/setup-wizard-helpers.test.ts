import { describe, it, expect, jest } from '@jest/globals';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');

describe('Setup Wizard Helpers', () => {
  describe('module structure', () => {
    it('should export helper functions', async () => {
      const module = await import('../../src/commands/setup-wizard-helpers.js');
      
      expect(typeof module.createFeatureEmbed).toBe('function');
      expect(typeof module.createSummaryEmbed).toBe('function');
      expect(typeof module.validateWizardInputs).toBe('function');
    });
  });

  describe('createFeatureEmbed', () => {
    it('should be a function', async () => {
      const { createFeatureEmbed } = await import('../../src/commands/setup-wizard-helpers.js');
      expect(typeof createFeatureEmbed).toBe('function');
    });
  });

  describe('createSummaryEmbed', () => {
    it('should be a function', async () => {
      const { createSummaryEmbed } = await import('../../src/commands/setup-wizard-helpers.js');
      expect(typeof createSummaryEmbed).toBe('function');
    });
  });

  describe('validateWizardInputs', () => {
    it('should be a function', async () => {
      const { validateWizardInputs } = await import('../../src/commands/setup-wizard-helpers.js');
      expect(typeof validateWizardInputs).toBe('function');
    });
  });
});
