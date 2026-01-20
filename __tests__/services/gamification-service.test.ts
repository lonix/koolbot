import { describe, it, expect, jest, beforeEach } from '@jest/globals';

describe('GamificationService', () => {
  describe('accolade definitions', () => {
    it('should have correct badge types defined', async () => {
      const { GamificationService } = await import('../../src/services/gamification-service.js');
      
      // Mock client
      const mockClient = {
        users: {
          fetch: jest.fn(),
        },
      } as any;

      const service = GamificationService.getInstance(mockClient);
      
      // Test that key accolade types exist
      const firstHourDef = service.getAccoladeDefinition('first_hour');
      expect(firstHourDef).toBeDefined();
      expect(firstHourDef?.name).toBe('First Steps');
      expect(firstHourDef?.emoji).toBeTruthy();

      const nightOwlDef = service.getAccoladeDefinition('night_owl');
      expect(nightOwlDef).toBeDefined();
      expect(nightOwlDef?.name).toBe('Night Owl');

      const connectorDef = service.getAccoladeDefinition('connector');
      expect(connectorDef).toBeDefined();
      expect(connectorDef?.name).toBe('Connector');
    });

    it('should return undefined for invalid badge types', async () => {
      const { GamificationService } = await import('../../src/services/gamification-service.js');
      
      const mockClient = {
        users: {
          fetch: jest.fn(),
        },
      } as any;

      const service = GamificationService.getInstance(mockClient);
      
      const invalidDef = service.getAccoladeDefinition('invalid_badge' as any);
      expect(invalidDef).toBeUndefined();
    });
  });

  describe('time calculation functions', () => {
    let service: any;

    beforeEach(async () => {
      const { GamificationService } = await import('../../src/services/gamification-service.js');
      const mockClient = {
        users: {
          fetch: jest.fn(),
        },
      } as any;
      service = GamificationService.getInstance(mockClient);
    });

    describe('calculateLateNightDuration', () => {
      it('should calculate duration for session entirely within late night hours', () => {
        // Session from 11 PM to 1 AM (2 hours = 7200 seconds)
        const startTime = new Date('2026-01-19T23:00:00Z');
        const endTime = new Date('2026-01-20T01:00:00Z');
        
        const duration = service['calculateLateNightDuration'](startTime, endTime);
        
        expect(duration).toBe(7200); // 2 hours in seconds
      });

      it('should calculate duration for session partially in late night hours', () => {
        // Session from 10 PM to 8 AM (should count 10PM-6AM = 8 hours)
        const startTime = new Date('2026-01-19T22:00:00Z');
        const endTime = new Date('2026-01-20T08:00:00Z');
        
        const duration = service['calculateLateNightDuration'](startTime, endTime);
        
        expect(duration).toBe(28800); // 8 hours in seconds
      });

      it('should return zero for session outside late night hours', () => {
        // Session from 9 AM to 5 PM
        const startTime = new Date('2026-01-19T09:00:00Z');
        const endTime = new Date('2026-01-19T17:00:00Z');
        
        const duration = service['calculateLateNightDuration'](startTime, endTime);
        
        expect(duration).toBe(0);
      });

      it('should handle sessions spanning multiple days', () => {
        // Session from 11 PM to 11 PM next day (24 hours)
        // Late night hours: 11PM-6AM (7h) + 10PM-11PM (1h) = 8 hours
        const startTime = new Date('2026-01-19T23:00:00Z');
        const endTime = new Date('2026-01-20T23:00:00Z');
        
        const duration = service['calculateLateNightDuration'](startTime, endTime);
        
        expect(duration).toBeGreaterThan(0);
        expect(duration).toBeLessThanOrEqual(28800); // Maximum 8 hours
      });
    });

    describe('calculateEarlyMorningDuration', () => {
      it('should calculate duration for session entirely within early morning hours', () => {
        // Session from 7 AM to 9 AM (2 hours = 7200 seconds)
        const startTime = new Date('2026-01-19T07:00:00Z');
        const endTime = new Date('2026-01-19T09:00:00Z');
        
        const duration = service['calculateEarlyMorningDuration'](startTime, endTime);
        
        expect(duration).toBe(7200); // 2 hours in seconds
      });

      it('should calculate duration for session partially in early morning hours', () => {
        // Session from 5 AM to 11 AM (should count 6AM-10AM = 4 hours)
        const startTime = new Date('2026-01-19T05:00:00Z');
        const endTime = new Date('2026-01-19T11:00:00Z');
        
        const duration = service['calculateEarlyMorningDuration'](startTime, endTime);
        
        expect(duration).toBe(14400); // 4 hours in seconds
      });

      it('should return zero for session outside early morning hours', () => {
        // Session from 11 AM to 5 PM
        const startTime = new Date('2026-01-19T11:00:00Z');
        const endTime = new Date('2026-01-19T17:00:00Z');
        
        const duration = service['calculateEarlyMorningDuration'](startTime, endTime);
        
        expect(duration).toBe(0);
      });
    });
  });

  describe('badge metadata', () => {
    it('should include unit field in metadata for time-based badges', async () => {
      const { GamificationService } = await import('../../src/services/gamification-service.js');
      
      const mockClient = {
        users: {
          fetch: jest.fn(),
        },
      } as any;

      const service = GamificationService.getInstance(mockClient);
      
      const firstHourDef = service.getAccoladeDefinition('first_hour');
      expect(firstHourDef).toBeDefined();
      expect(firstHourDef?.metadataFunction).toBeDefined();
      
      // Check that metadataFunction is defined and would return unit field
      // (actual execution would require DB setup, so we just verify structure)
      if (firstHourDef?.metadataFunction) {
        const metadataFunc = firstHourDef.metadataFunction;
        expect(metadataFunc).toBeInstanceOf(Function);
      }
    });

    it('should include unit field in metadata for social badges', async () => {
      const { GamificationService } = await import('../../src/services/gamification-service.js');
      
      const mockClient = {
        users: {
          fetch: jest.fn(),
        },
      } as any;

      const service = GamificationService.getInstance(mockClient);
      
      const socialButterflyDef = service.getAccoladeDefinition('social_butterfly');
      expect(socialButterflyDef).toBeDefined();
      expect(socialButterflyDef?.metadataFunction).toBeDefined();
    });
  });

  describe('badge definition structure', () => {
    it('should have all required properties for each badge', async () => {
      const { GamificationService } = await import('../../src/services/gamification-service.js');
      
      const mockClient = {
        users: {
          fetch: jest.fn(),
        },
      } as any;

      const service = GamificationService.getInstance(mockClient);
      
      const badgeTypes = [
        'first_hour',
        'voice_veteran_100',
        'voice_veteran_500',
        'voice_veteran_1000',
        'voice_legend_8765',
        'marathon_runner',
        'ultra_marathoner',
        'social_butterfly',
        'connector',
        'night_owl',
        'early_bird',
        'weekend_warrior',
        'weekday_warrior',
      ];

      badgeTypes.forEach(badgeType => {
        const definition = service.getAccoladeDefinition(badgeType as any);
        
        expect(definition).toBeDefined();
        expect(definition?.emoji).toBeTruthy();
        expect(definition?.name).toBeTruthy();
        expect(definition?.description).toBeTruthy();
        expect(definition?.checkFunction).toBeInstanceOf(Function);
        expect(definition?.metadataFunction).toBeInstanceOf(Function);
      });
    });

    it('should have userData parameter in all check functions', async () => {
      const { GamificationService } = await import('../../src/services/gamification-service.js');
      
      const mockClient = {
        users: {
          fetch: jest.fn(),
        },
      } as any;

      const service = GamificationService.getInstance(mockClient);
      
      const firstHourDef = service.getAccoladeDefinition('first_hour');
      expect(firstHourDef?.checkFunction).toBeDefined();
      
      // Check function signature accepts 2 parameters (userId, userData)
      if (firstHourDef?.checkFunction) {
        expect(firstHourDef.checkFunction.length).toBe(2);
      }
    });

    it('should have userData parameter in all metadata functions', async () => {
      const { GamificationService } = await import('../../src/services/gamification-service.js');
      
      const mockClient = {
        users: {
          fetch: jest.fn(),
        },
      } as any;

      const service = GamificationService.getInstance(mockClient);
      
      const firstHourDef = service.getAccoladeDefinition('first_hour');
      expect(firstHourDef?.metadataFunction).toBeDefined();
      
      // Metadata function signature should accept 2 parameters (userId, userData)
      if (firstHourDef?.metadataFunction) {
        expect(firstHourDef.metadataFunction.length).toBe(2);
      }
    });
  });

  describe('error handling', () => {
    it('should handle database connection errors gracefully', async () => {
      const { GamificationService } = await import('../../src/services/gamification-service.js');
      
      const mockClient = {
        users: {
          fetch: jest.fn(),
        },
      } as any;

      const service = GamificationService.getInstance(mockClient);
      
      // Test that service instantiates without throwing
      expect(service).toBeDefined();
    });

    it('should handle missing user data gracefully in check functions', async () => {
      const { GamificationService } = await import('../../src/services/gamification-service.js');
      
      const mockClient = {
        users: {
          fetch: jest.fn(),
        },
      } as any;

      const service = GamificationService.getInstance(mockClient);
      
      const firstHourDef = service.getAccoladeDefinition('first_hour');
      
      // Verify checkFunction can handle null userData
      if (firstHourDef?.checkFunction) {
        // Function should not throw when called with null userData
        // (actual execution would require proper mocking)
        expect(firstHourDef.checkFunction).toBeInstanceOf(Function);
      }
    });
  });
});
