import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Client } from 'discord.js';

// Rely on the global mongoose mock from setup.ts.
jest.mock('../../src/utils/logger.js', () => ({
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/services/quote-service.js', () => ({
  quoteService: {
    getQuotesAuthoredByUser: jest.fn().mockResolvedValue(0),
    getQuotesAddedByUser: jest.fn().mockResolvedValue(0),
    getMostLikedQuoteByAuthor: jest.fn().mockResolvedValue(null),
  },
}));

import { AchievementsService } from '../../src/services/achievements-service.js';
import { UserNotificationPrefsService } from '../../src/services/user-notification-prefs-service.js';
import type { IVoiceChannelTracking } from '../../src/models/voice-channel-tracking.js';

// Closure shapes — the accolade logic now takes a trailing `timeZone` arg (#658).
type CheckFn = (
  userId: string,
  userData: IVoiceChannelTracking | null,
  timeZone: string,
) => Promise<boolean>;
type MetaFn = (
  userId: string,
  userData: IVoiceChannelTracking | null,
  timeZone: string,
) => Promise<{ value?: number }>;

function makeService(): {
  service: AchievementsService;
  mockConfigService: { getString: jest.Mock };
} {
  const mockClient = { users: { fetch: jest.fn() } } as unknown as Client;
  const service = AchievementsService.getInstance(mockClient);
  const mockConfigService = {
    getString: jest.fn().mockResolvedValue('guild-1'),
    getBoolean: jest.fn().mockResolvedValue(true),
    getNumber: jest.fn().mockResolvedValue(0),
  };
  (service as never)['configService'] = mockConfigService;
  (service as never)['isConnected'] = true;
  return { service, mockConfigService };
}

function trackingWith(
  sessions: Array<{ startTime: Date; endTime?: Date; duration?: number }>,
): IVoiceChannelTracking {
  return {
    userId: 'user123',
    username: 'TestUser',
    totalTime: 0,
    sessions,
  } as unknown as IVoiceChannelTracking;
}

function accoladeLogic(
  service: AchievementsService,
): Record<string, { checkFunction: CheckFn; metadataFunction?: MetaFn }> {
  return (service as never)['accoladeLogic'];
}

describe('AchievementsService timezone-aware accolades (#658)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    (AchievementsService as unknown as { instance: unknown }).instance = undefined;
    (UserNotificationPrefsService as unknown as { instance: unknown }).instance = null;
  });

  describe('time-of-day windows (Night Owl / Early Bird)', () => {
    // 12:00–16:00 UTC: daytime in UTC, but 00:00–04:00 in Auckland (+12),
    // which lands entirely in the late-night window (22:00–06:00).
    const session = {
      startTime: new Date('2026-06-22T12:00:00Z'),
      endTime: new Date('2026-06-22T16:00:00Z'),
      duration: 4 * 3600,
    };

    it('counts no late-night hours under the UTC default', async () => {
      const { service } = makeService();
      const meta = await accoladeLogic(service).night_owl.metadataFunction!(
        'user123',
        trackingWith([session]),
        'UTC',
      );
      expect(meta.value).toBe(0);
    });

    it('counts the session as late-night in the user timezone', async () => {
      const { service } = makeService();
      const meta = await accoladeLogic(service).night_owl.metadataFunction!(
        'user123',
        trackingWith([session]),
        'Pacific/Auckland',
      );
      expect(meta.value).toBe(4);
    });

    it('buckets early-morning hours in the user timezone', async () => {
      const { service } = makeService();
      // 18:00–22:00 UTC → 06:00–10:00 in Auckland (early-morning window).
      const early = {
        startTime: new Date('2026-06-22T18:00:00Z'),
        endTime: new Date('2026-06-22T22:00:00Z'),
        duration: 4 * 3600,
      };
      const utc = await accoladeLogic(service).early_bird.metadataFunction!(
        'user123',
        trackingWith([early]),
        'UTC',
      );
      const akl = await accoladeLogic(service).early_bird.metadataFunction!(
        'user123',
        trackingWith([early]),
        'Pacific/Auckland',
      );
      expect(utc.value).toBe(0);
      expect(akl.value).toBe(4);
    });
  });

  describe('day-of-week (Weekend / Weekday Warrior)', () => {
    // Friday 23:00 UTC is still Friday in UTC, but Saturday in Auckland (+12).
    const session = {
      startTime: new Date('2026-06-19T23:00:00Z'),
      duration: 3600,
    };

    it('treats the session as a weekday under the UTC default', async () => {
      const { service } = makeService();
      const weekend = await accoladeLogic(service).weekend_warrior.metadataFunction!(
        'user123',
        trackingWith([session]),
        'UTC',
      );
      const weekday = await accoladeLogic(service).weekday_warrior.metadataFunction!(
        'user123',
        trackingWith([session]),
        'UTC',
      );
      expect(weekend.value).toBe(0);
      expect(weekday.value).toBe(1);
    });

    it('treats the session as a weekend day in the user timezone', async () => {
      const { service } = makeService();
      const weekend = await accoladeLogic(service).weekend_warrior.metadataFunction!(
        'user123',
        trackingWith([session]),
        'Pacific/Auckland',
      );
      const weekday = await accoladeLogic(service).weekday_warrior.metadataFunction!(
        'user123',
        trackingWith([session]),
        'Pacific/Auckland',
      );
      expect(weekend.value).toBe(1);
      expect(weekday.value).toBe(0);
    });
  });

  describe('consistency streaks', () => {
    // Two sessions on the same UTC calendar day, but split across two
    // consecutive days in Los Angeles (UTC-7): 18:00 on the 21st and
    // 06:00 on the 22nd.
    const sessions = [
      { startTime: new Date('2026-06-22T01:00:00Z'), duration: 600 },
      { startTime: new Date('2026-06-22T13:00:00Z'), duration: 600 },
    ];

    it('buckets both sessions into one day under the UTC default', async () => {
      const { service } = makeService();
      const meta = await accoladeLogic(service).consistent_week.metadataFunction!(
        'user123',
        trackingWith(sessions),
        'UTC',
      );
      expect(meta.value).toBe(1);
    });

    it('splits the sessions across two local days, forming a 2-day streak', async () => {
      const { service } = makeService();
      const meta = await accoladeLogic(service).consistent_week.metadataFunction!(
        'user123',
        trackingWith(sessions),
        'America/Los_Angeles',
      );
      expect(meta.value).toBe(2);
    });
  });

  describe('resolveUserTimezone', () => {
    const resolve = (service: AchievementsService): ((userId: string) => Promise<string>) =>
      (service as never)['resolveUserTimezone'].bind(service);

    it('returns the stored valid timezone when set', async () => {
      const { service } = makeService();
      jest
        .spyOn(UserNotificationPrefsService.prototype, 'getTimezone')
        .mockResolvedValue('Pacific/Auckland');
      expect(await resolve(service)('user123')).toBe('Pacific/Auckland');
    });

    it('falls back to UTC when no timezone is set', async () => {
      const { service } = makeService();
      jest
        .spyOn(UserNotificationPrefsService.prototype, 'getTimezone')
        .mockResolvedValue(null);
      expect(await resolve(service)('user123')).toBe('UTC');
    });

    it('falls back to UTC when an invalid timezone is stored', async () => {
      const { service } = makeService();
      jest
        .spyOn(UserNotificationPrefsService.prototype, 'getTimezone')
        .mockResolvedValue('Not/AZone');
      expect(await resolve(service)('user123')).toBe('UTC');
    });

    it('falls back to UTC when no guild id is configured', async () => {
      const { service, mockConfigService } = makeService();
      mockConfigService.getString.mockResolvedValue('');
      const spy = jest
        .spyOn(UserNotificationPrefsService.prototype, 'getTimezone')
        .mockResolvedValue('Pacific/Auckland');
      expect(await resolve(service)('user123')).toBe('UTC');
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
