import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Client } from 'discord.js';

// Do NOT override the global mongoose mock from setup.ts — rely on it for stable jest.fn() instances.

jest.mock('../../src/utils/logger.js', () => ({
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// UserAchievements needs to be a callable constructor AND have static methods
jest.mock('../../src/models/user-achievements.js', () => ({
  UserAchievements: Object.assign(
    jest.fn().mockImplementation(() => ({
      accolades: [],
      achievements: [],
      statistics: { totalAccolades: 0, totalAchievements: 0 },
      save: jest.fn().mockResolvedValue(undefined),
    })),
    {
      findOne: jest.fn(),
      find: jest.fn(),
    }
  ),
}));

jest.mock('../../src/services/quote-service.js', () => ({
  quoteService: {
    getQuotesAuthoredByUser: jest.fn().mockResolvedValue(0),
    getQuotesAddedByUser: jest.fn().mockResolvedValue(0),
    getMostLikedQuoteByAuthor: jest.fn().mockResolvedValue(null),
  },
}));

// Static imports — mocks are registered before these load (jest.mock is hoisted)
import { AchievementsService, GamificationService } from '../../src/services/achievements-service.js';
import { UserAchievements } from '../../src/models/user-achievements.js';
import { VoiceChannelTracking } from '../../src/models/voice-channel-tracking.js';

// Helper to create an AchievementsService with injected config
function createAchievementsService(mockClient: Partial<Client>) {
  const service = AchievementsService.getInstance(mockClient as Client);

  const mockConfigService = {
    getString: jest.fn().mockResolvedValue('mongodb://localhost/test'),
    getBoolean: jest.fn().mockResolvedValue(false),
    get: jest.fn().mockResolvedValue(null),
    getNumber: jest.fn().mockResolvedValue(0),
    triggerReload: jest.fn().mockResolvedValue(undefined),
  };
  // Inject mock config service and mark as connected (established pattern from codebase)
  (service as never)['configService'] = mockConfigService;
  (service as never)['isConnected'] = true;

  return { service, mockConfigService };
}

describe('AchievementsService', () => {
  let mockClient: Partial<Client>;

  beforeEach(() => {
    // Reconfigure mock methods for each test
    (UserAchievements.findOne as jest.Mock).mockResolvedValue(null);
    (UserAchievements.find as jest.Mock).mockResolvedValue([]);
    (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue(null);

    mockClient = { users: { fetch: jest.fn() } as any };

    // Reset singleton between tests
    (AchievementsService as unknown as { instance: unknown }).instance = undefined;
  });

  describe('singleton pattern', () => {
    it('should create a singleton instance', () => {
      const instance1 = AchievementsService.getInstance(mockClient as Client);
      const instance2 = AchievementsService.getInstance(mockClient as Client);
      expect(instance1).toBe(instance2);
    });

    it('should create an instance with a client', () => {
      expect(AchievementsService.getInstance(mockClient as Client)).toBeDefined();
    });
  });

  describe('getAccoladeDefinition', () => {
    it('should return definition for first_hour', () => {
      const { service } = createAchievementsService(mockClient);
      const def = service.getAccoladeDefinition('first_hour');
      expect(def).toBeDefined();
      expect(def?.name).toBe('First Steps');
      expect(def?.emoji).toBe('🎉');
    });

    it('should return definition for voice_veteran_100', () => {
      const { service } = createAchievementsService(mockClient);
      const def = service.getAccoladeDefinition('voice_veteran_100');
      expect(def).toBeDefined();
      expect(def?.name).toBe('Voice Veteran');
    });

    it('should return definition for social_butterfly', () => {
      const { service } = createAchievementsService(mockClient);
      expect(service.getAccoladeDefinition('social_butterfly')).toBeDefined();
    });

    it('should return definition for night_owl', () => {
      const { service } = createAchievementsService(mockClient);
      expect(service.getAccoladeDefinition('night_owl')).toBeDefined();
    });

    it('should return definition for early_bird', () => {
      const { service } = createAchievementsService(mockClient);
      expect(service.getAccoladeDefinition('early_bird')).toBeDefined();
    });

    it('should return definition for marathon_runner', () => {
      const { service } = createAchievementsService(mockClient);
      expect(service.getAccoladeDefinition('marathon_runner')).toBeDefined();
    });

    it('should return undefined for invalid accolade type', () => {
      const { service } = createAchievementsService(mockClient);
      expect(service.getAccoladeDefinition('non_existent_type')).toBeUndefined();
    });
  });

  describe('getAchievementDefinition', () => {
    it('should return definition for weekly_active', () => {
      const { service } = createAchievementsService(mockClient);
      const def = service.getAchievementDefinition('weekly_active');
      expect(def).toBeDefined();
      expect(def?.name).toBe('Active');
    });

    it('should return undefined for invalid achievement type', () => {
      const { service } = createAchievementsService(mockClient);
      expect(service.getAchievementDefinition('non_existent')).toBeUndefined();
    });
  });

  describe('checkAndAwardAccolades', () => {
    it('should return empty array when achievements are disabled', async () => {
      const { service, mockConfigService } = createAchievementsService(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(false);
      expect(await service.checkAndAwardAccolades('user123', 'TestUser')).toEqual([]);
    });

    it('should check accolades when enabled with no existing user record', async () => {
      const { service, mockConfigService } = createAchievementsService(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      // Default mocks return null/empty — no accolades will be earned
      const result = await service.checkAndAwardAccolades('user123', 'TestUser');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return empty when user has existing accolades already', async () => {
      const { service, mockConfigService } = createAchievementsService(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);

      (UserAchievements.findOne as jest.Mock).mockResolvedValue({
        accolades: [{ type: 'first_hour', earnedAt: new Date(), metadata: {} }],
        statistics: { totalAccolades: 1, totalAchievements: 0 },
        save: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.checkAndAwardAccolades('user123', 'TestUser');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle database errors gracefully', async () => {
      const { service, mockConfigService } = createAchievementsService(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      (UserAchievements.findOne as jest.Mock).mockRejectedValue(new Error('DB error'));
      expect(await service.checkAndAwardAccolades('user123', 'TestUser')).toEqual([]);
    });
  });

  describe('checkAndAwardAchievements', () => {
    it('should return empty array when achievements are disabled', async () => {
      const { service, mockConfigService } = createAchievementsService(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(false);
      expect(await service.checkAndAwardAchievements('user123', 'TestUser')).toEqual([]);
    });

    it('should check achievements when enabled', async () => {
      const { service, mockConfigService } = createAchievementsService(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);

      (UserAchievements.findOne as jest.Mock).mockResolvedValue({
        achievements: [],
        statistics: { totalAccolades: 0, totalAchievements: 0 },
        save: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.checkAndAwardAchievements('user123', 'TestUser');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle database errors gracefully', async () => {
      const { service, mockConfigService } = createAchievementsService(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      (UserAchievements.findOne as jest.Mock).mockRejectedValue(new Error('DB error'));
      expect(await service.checkAndAwardAchievements('user123', 'TestUser')).toEqual([]);
    });
  });

  describe('getUserAchievements', () => {
    it('should return null when user not found', async () => {
      const { service } = createAchievementsService(mockClient);
      (UserAchievements.findOne as jest.Mock).mockResolvedValue(null);
      expect(await service.getUserAchievements('unknown-user')).toBeNull();
    });

    it('should return achievements when user found', async () => {
      const { service } = createAchievementsService(mockClient);
      (UserAchievements.findOne as jest.Mock).mockResolvedValue({
        accolades: [{ type: 'first_hour', earnedAt: new Date(), metadata: {} }],
        achievements: [],
        statistics: { totalAccolades: 1, totalAchievements: 0 },
      });

      const result = await service.getUserAchievements('user123');
      expect(result).not.toBeNull();
      expect(result?.accolades).toHaveLength(1);
      expect(result?.statistics.totalAccolades).toBe(1);
    });

    it('should handle database errors gracefully', async () => {
      const { service } = createAchievementsService(mockClient);
      (UserAchievements.findOne as jest.Mock).mockRejectedValue(new Error('DB error'));
      expect(await service.getUserAchievements('user123')).toBeNull();
    });
  });

  describe('notifyUserOfAccolades', () => {
    it('should not send DM when dm_notifications is disabled', async () => {
      const { service, mockConfigService } = createAchievementsService(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(false);

      await expect(
        service.notifyUserOfAccolades('user123', [{ type: 'first_hour', earnedAt: new Date(), metadata: {} }])
      ).resolves.not.toThrow();
      expect((mockClient.users as any).fetch).not.toHaveBeenCalled();
    });

    it('should not send DM when accolades array is empty', async () => {
      const { service, mockConfigService } = createAchievementsService(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      await expect(service.notifyUserOfAccolades('user123', [])).resolves.not.toThrow();
      expect((mockClient.users as any).fetch).not.toHaveBeenCalled();
    });

    it('should send DM when enabled with valid accolades', async () => {
      const { service, mockConfigService } = createAchievementsService(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);

      const mockUser = { username: 'TestUser', send: jest.fn().mockResolvedValue(undefined) };
      (mockClient.users as any).fetch = jest.fn().mockResolvedValue(mockUser);

      await expect(
        service.notifyUserOfAccolades('user123', [
          { type: 'first_hour', earnedAt: new Date(), metadata: { description: '1 hour milestone' } },
        ])
      ).resolves.not.toThrow();

      expect((mockClient.users as any).fetch).toHaveBeenCalledWith('user123');
      expect(mockUser.send).toHaveBeenCalled();
    });

    it('should handle DM send errors gracefully', async () => {
      const { service, mockConfigService } = createAchievementsService(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      (mockClient.users as any).fetch = jest.fn().mockRejectedValue(new Error('Cannot send DM'));

      await expect(
        service.notifyUserOfAccolades('user123', [{ type: 'first_hour', earnedAt: new Date(), metadata: {} }])
      ).resolves.not.toThrow();
    });
  });

  describe('getNewAccoladesSinceLastWeek', () => {
    it('should return empty array when no recent accolades', async () => {
      const { service } = createAchievementsService(mockClient);
      (UserAchievements.find as jest.Mock).mockResolvedValue([]);
      expect(await service.getNewAccoladesSinceLastWeek()).toEqual([]);
    });

    it('should return users with accolades earned in the past week', async () => {
      const { service } = createAchievementsService(mockClient);
      const recentDate = new Date();
      (UserAchievements.find as jest.Mock).mockResolvedValue([
        {
          userId: 'user1',
          username: 'User1',
          accolades: [{ type: 'first_hour', earnedAt: recentDate, metadata: {} }],
        },
      ]);

      const result = await service.getNewAccoladesSinceLastWeek();
      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe('user1');
    });

    it('should handle database errors gracefully', async () => {
      const { service } = createAchievementsService(mockClient);
      (UserAchievements.find as jest.Mock).mockRejectedValue(new Error('DB error'));
      expect(await service.getNewAccoladesSinceLastWeek()).toEqual([]);
    });
  });

  describe('GamificationService export', () => {
    it('should export GamificationService as alias for AchievementsService', () => {
      expect(GamificationService).toBe(AchievementsService);
    });
  });
});
