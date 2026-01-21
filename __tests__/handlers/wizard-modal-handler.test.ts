import { describe, it, expect, jest } from '@jest/globals';

// Mock dependencies before importing
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/services/wizard-service.js');

describe('WizardModalHandler', () => {
  describe('module structure', () => {
    it('should export handleWizardModal function', async () => {
      const module = await import('../../src/handlers/wizard-modal-handler.js');
      expect(typeof module.handleWizardModal).toBe('function');
    });
  });
});
