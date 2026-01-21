import { describe, it, expect, jest } from '@jest/globals';

// Mock dependencies before importing
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/services/wizard-service.js');

describe('Wizard Select Handler', () => {
  describe('module structure', () => {
    it('should export handleWizardSelectInteraction function', async () => {
      const module = await import('../../src/handlers/wizard-select-handler.js');
      expect(typeof module.handleWizardSelectInteraction).toBe('function');
    });
  });
});
