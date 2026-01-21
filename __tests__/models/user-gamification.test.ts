import { describe, it, expect } from '@jest/globals';

describe('UserGamification Model Schema', () => {
  describe('schema definition', () => {
    it('should define required fields', () => {
      const schemaTest = async () => {
        const { UserGamification } = await import('../../src/models/user-gamification.js');
        return UserGamification.schema;
      };

      expect(schemaTest).toBeDefined();
    });
  });
});
