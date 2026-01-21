import { describe, it, expect } from '@jest/globals';

describe('Wizard Button Handler Helpers', () => {
  describe('basic structure tests', () => {
    it('should import without errors', async () => {
      const module = await import('../../src/handlers/wizard-button-handler-helpers.js');
      expect(module).toBeDefined();
      expect(typeof module.moveToNextFeature).toBe('function');
    });
  });
});
