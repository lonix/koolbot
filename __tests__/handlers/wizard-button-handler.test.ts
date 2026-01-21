import { describe, it, expect, jest } from '@jest/globals';

// Mock dependencies before importing
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/services/wizard-service.js');

describe('Wizard Button Handler', () => {
  describe('module structure', () => {
    it('should export handleWizardButtonInteraction function', async () => {
      const module = await import('../../src/handlers/wizard-button-handler.js');
      expect(typeof module.handleWizardButtonInteraction).toBe('function');
    });
  });
});
