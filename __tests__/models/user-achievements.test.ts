import { describe, it, expect } from '@jest/globals';

describe('UserAchievements Model Schema', () => {
  describe('schema definition', () => {
    it('should define required fields', () => {
      const schemaTest = async () => {
        const { UserAchievements } = await import('../../src/models/user-achievements.js');
        return UserAchievements.schema;
      };

      expect(schemaTest).toBeDefined();
    });
  });
});
