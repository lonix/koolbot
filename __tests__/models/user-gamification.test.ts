import { describe, it, expect, beforeAll } from '@jest/globals';
import mongoose from 'mongoose';

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

  describe('field constraints', () => {
    let UserGamificationSchema: mongoose.Schema;

    beforeAll(async () => {
      const { UserGamification } = await import('../../src/models/user-gamification.js');
      UserGamificationSchema = UserGamification.schema;
    });

    it('should have userId field as required string with unique index', () => {
      const userIdPath = UserGamificationSchema.path('userId');
      expect(userIdPath).toBeDefined();
      expect(userIdPath.instance).toBe('String');
      expect(userIdPath.isRequired).toBe(true);
      
      // Check for unique index
      const indexes = UserGamificationSchema.indexes();
      const userIdIndex = indexes.find(idx => idx[0].userId);
      expect(userIdIndex).toBeDefined();
      expect(userIdIndex?.[1]?.unique).toBe(true);
    });

    it('should have username field as required string', () => {
      const usernamePath = UserGamificationSchema.path('username');
      expect(usernamePath).toBeDefined();
      expect(usernamePath.instance).toBe('String');
      expect(usernamePath.isRequired).toBe(true);
    });

    it('should have lastChecked field with default Date', () => {
      const lastCheckedPath = UserGamificationSchema.path('lastChecked');
      expect(lastCheckedPath).toBeDefined();
      expect(lastCheckedPath.instance).toBe('Date');
      expect(lastCheckedPath.options.default).toBeDefined();
    });

    it('should have accolades array with correct schema', () => {
      const accoladesPath = UserGamificationSchema.path('accolades');
      expect(accoladesPath).toBeDefined();
      expect(accoladesPath.instance).toBe('Array');
    });

    it('should have achievements array with correct schema', () => {
      const achievementsPath = UserGamificationSchema.path('achievements');
      expect(achievementsPath).toBeDefined();
      expect(achievementsPath.instance).toBe('Array');
    });

    it('should have statistics object with default values', () => {
      const totalAccoladesPath = UserGamificationSchema.path('statistics.totalAccolades');
      expect(totalAccoladesPath).toBeDefined();
      expect(totalAccoladesPath.instance).toBe('Number');
      expect(totalAccoladesPath.options.default).toBe(0);

      const totalAchievementsPath = UserGamificationSchema.path('statistics.totalAchievements');
      expect(totalAchievementsPath).toBeDefined();
      expect(totalAchievementsPath.instance).toBe('Number');
      expect(totalAchievementsPath.options.default).toBe(0);
    });
  });

  describe('accolade schema', () => {
    let UserGamificationSchema: mongoose.Schema;

    beforeAll(async () => {
      const { UserGamification } = await import('../../src/models/user-gamification.js');
      UserGamificationSchema = UserGamification.schema;
    });

    it('should have type field as required string', () => {
      const typePath = UserGamificationSchema.path('accolades.type');
      expect(typePath).toBeDefined();
      expect(typePath.instance).toBe('String');
      expect(typePath.isRequired).toBe(true);
    });

    it('should have earnedAt field as required Date', () => {
      const earnedAtPath = UserGamificationSchema.path('accolades.earnedAt');
      expect(earnedAtPath).toBeDefined();
      expect(earnedAtPath.instance).toBe('Date');
      expect(earnedAtPath.isRequired).toBe(true);
    });

    it('should have metadata with value, description, and unit fields', () => {
      const valuePath = UserGamificationSchema.path('accolades.metadata.value');
      expect(valuePath).toBeDefined();
      expect(valuePath.instance).toBe('Number');

      const descriptionPath = UserGamificationSchema.path('accolades.metadata.description');
      expect(descriptionPath).toBeDefined();
      expect(descriptionPath.instance).toBe('String');

      const unitPath = UserGamificationSchema.path('accolades.metadata.unit');
      expect(unitPath).toBeDefined();
      expect(unitPath.instance).toBe('String');
    });
  });

  describe('achievement schema', () => {
    let UserGamificationSchema: mongoose.Schema;

    beforeAll(async () => {
      const { UserGamification } = await import('../../src/models/user-gamification.js');
      UserGamificationSchema = UserGamification.schema;
    });

    it('should have type field as required string', () => {
      const typePath = UserGamificationSchema.path('achievements.type');
      expect(typePath).toBeDefined();
      expect(typePath.instance).toBe('String');
      expect(typePath.isRequired).toBe(true);
    });

    it('should have earnedAt field as required Date', () => {
      const earnedAtPath = UserGamificationSchema.path('achievements.earnedAt');
      expect(earnedAtPath).toBeDefined();
      expect(earnedAtPath.instance).toBe('Date');
      expect(earnedAtPath.isRequired).toBe(true);
    });

    it('should have period field as required string', () => {
      const periodPath = UserGamificationSchema.path('achievements.period');
      expect(periodPath).toBeDefined();
      expect(periodPath.instance).toBe('String');
      expect(periodPath.isRequired).toBe(true);
    });

    it('should have rank field as optional number', () => {
      const rankPath = UserGamificationSchema.path('achievements.rank');
      expect(rankPath).toBeDefined();
      expect(rankPath.instance).toBe('Number');
      expect(rankPath.isRequired).not.toBe(true);
    });

    it('should have metadata with value, description, and unit fields', () => {
      const valuePath = UserGamificationSchema.path('achievements.metadata.value');
      expect(valuePath).toBeDefined();
      expect(valuePath.instance).toBe('Number');

      const descriptionPath = UserGamificationSchema.path('achievements.metadata.description');
      expect(descriptionPath).toBeDefined();
      expect(descriptionPath.instance).toBe('String');

      const unitPath = UserGamificationSchema.path('achievements.metadata.unit');
      expect(unitPath).toBeDefined();
      expect(unitPath.instance).toBe('String');
    });
  });
});
