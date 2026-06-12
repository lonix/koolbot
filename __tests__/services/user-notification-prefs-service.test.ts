/**
 * Unit tests for UserNotificationPrefsService (#482).
 *
 * Covers:
 *  - missing row → all defaults true
 *  - DB error → all defaults true (so a transient outage cannot
 *    silence every DM by misreporting "user opted out")
 *  - setPrefs writes a row via findOneAndUpdate + upsert and returns
 *    the merged result
 *  - setPrefs ignores non-boolean keys in the patch
 *  - get/set both refuse empty userId / guildId without throwing on the
 *    read path
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../src/utils/logger.js', () => ({
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Mock the model so we can control find/upsert outcomes per test.
jest.mock('../../src/models/user-notification-prefs.js', () => ({
  UserNotificationPrefs: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  },
}));

import { UserNotificationPrefs } from '../../src/models/user-notification-prefs.js';
import {
  DEFAULT_PREFS,
  NOTIFICATION_PREF_KEYS,
  UserNotificationPrefsService,
} from '../../src/services/user-notification-prefs-service.js';

const findOne = UserNotificationPrefs.findOne as jest.Mock;
const findOneAndUpdate = UserNotificationPrefs.findOneAndUpdate as jest.Mock;

describe('UserNotificationPrefsService', () => {
  beforeEach(() => {
    findOne.mockReset();
    findOneAndUpdate.mockReset();
    (UserNotificationPrefsService as unknown as { instance: unknown }).instance = null;
  });

  describe('getPrefs', () => {
    it('returns all defaults when no row exists', async () => {
      findOne.mockResolvedValueOnce(null);
      const prefs = await UserNotificationPrefsService.getInstance().getPrefs('u1', 'g1');
      expect(prefs).toEqual(DEFAULT_PREFS);
      expect(findOne).toHaveBeenCalledWith({ userId: 'u1', guildId: 'g1' });
    });

    it('returns the stored row when present', async () => {
      findOne.mockResolvedValueOnce({
        userId: 'u1',
        guildId: 'g1',
        achievements: false,
        digest: true,
        rewind: false,
        updatedAt: new Date(),
      });
      const prefs = await UserNotificationPrefsService.getInstance().getPrefs('u1', 'g1');
      expect(prefs).toEqual({ achievements: false, digest: true, rewind: false });
    });

    it('collapses to defaults on DB error so a transient outage cannot silence DMs', async () => {
      findOne.mockRejectedValueOnce(new Error('mongo down'));
      const prefs = await UserNotificationPrefsService.getInstance().getPrefs('u1', 'g1');
      expect(prefs).toEqual(DEFAULT_PREFS);
    });

    it('returns defaults for empty userId/guildId without touching the DB', async () => {
      const svc = UserNotificationPrefsService.getInstance();
      expect(await svc.getPrefs('', 'g1')).toEqual(DEFAULT_PREFS);
      expect(await svc.getPrefs('u1', '')).toEqual(DEFAULT_PREFS);
      expect(findOne).not.toHaveBeenCalled();
    });
  });

  describe('setPrefs', () => {
    it('writes only the keys present in the patch and returns the merged row', async () => {
      findOneAndUpdate.mockResolvedValueOnce({
        userId: 'u1',
        guildId: 'g1',
        achievements: false,
        digest: true,
        rewind: true,
        updatedAt: new Date(),
      });
      const result = await UserNotificationPrefsService.getInstance().setPrefs(
        'u1',
        'g1',
        { achievements: false },
      );
      expect(result).toEqual({ achievements: false, digest: true, rewind: true });
      const [filter, update, opts] = findOneAndUpdate.mock.calls[0] as [
        Record<string, unknown>,
        { $set: Record<string, unknown> },
        Record<string, unknown>,
      ];
      expect(filter).toEqual({ userId: 'u1', guildId: 'g1' });
      expect(update.$set).toHaveProperty('achievements', false);
      expect(update.$set).not.toHaveProperty('digest');
      expect(update.$set).not.toHaveProperty('rewind');
      expect(opts).toMatchObject({ upsert: true, new: true });
    });

    it('drops non-boolean values silently rather than coercing', async () => {
      findOneAndUpdate.mockResolvedValueOnce({
        userId: 'u1',
        guildId: 'g1',
        achievements: true,
        digest: true,
        rewind: true,
        updatedAt: new Date(),
      });
      await UserNotificationPrefsService.getInstance().setPrefs('u1', 'g1', {
        // @ts-expect-error - test bad input on purpose
        achievements: 'true',
        // @ts-expect-error - test bad input on purpose
        digest: 1,
        rewind: true,
      });
      const update = findOneAndUpdate.mock.calls[0][1] as { $set: Record<string, unknown> };
      expect(update.$set).not.toHaveProperty('achievements');
      expect(update.$set).not.toHaveProperty('digest');
      expect(update.$set).toHaveProperty('rewind', true);
    });

    it('throws on empty userId/guildId — write path must not silently no-op', async () => {
      const svc = UserNotificationPrefsService.getInstance();
      await expect(svc.setPrefs('', 'g1', { achievements: false })).rejects.toThrow();
      await expect(svc.setPrefs('u1', '', { achievements: false })).rejects.toThrow();
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('getPrefsWithTimezone', () => {
    it('returns prefs and timezone from a single read', async () => {
      findOne.mockResolvedValueOnce({
        achievements: false,
        digest: true,
        rewind: true,
        timezone: 'Europe/Berlin',
      });
      const out = await UserNotificationPrefsService.getInstance().getPrefsWithTimezone('u1', 'g1');
      expect(out).toEqual({
        prefs: { achievements: false, digest: true, rewind: true },
        timezone: 'Europe/Berlin',
      });
      expect(findOne).toHaveBeenCalledTimes(1);
    });

    it('returns defaults + null timezone when no row exists', async () => {
      findOne.mockResolvedValueOnce(null);
      const out = await UserNotificationPrefsService.getInstance().getPrefsWithTimezone('u1', 'g1');
      expect(out).toEqual({ prefs: DEFAULT_PREFS, timezone: null });
    });

    it('collapses to defaults + null timezone on DB error', async () => {
      findOne.mockRejectedValueOnce(new Error('mongo down'));
      const out = await UserNotificationPrefsService.getInstance().getPrefsWithTimezone('u1', 'g1');
      expect(out).toEqual({ prefs: DEFAULT_PREFS, timezone: null });
    });
  });

  describe('getTimezone', () => {
    it('returns the stored zone when present', async () => {
      findOne.mockResolvedValueOnce({ timezone: 'Europe/Berlin' });
      const tz = await UserNotificationPrefsService.getInstance().getTimezone('u1', 'g1');
      expect(tz).toBe('Europe/Berlin');
    });

    it('returns null when unset or row missing', async () => {
      findOne.mockResolvedValueOnce(null);
      expect(await UserNotificationPrefsService.getInstance().getTimezone('u1', 'g1')).toBeNull();
      findOne.mockResolvedValueOnce({ timezone: '' });
      expect(await UserNotificationPrefsService.getInstance().getTimezone('u1', 'g1')).toBeNull();
    });

    it('returns null on DB error', async () => {
      findOne.mockRejectedValueOnce(new Error('mongo down'));
      expect(await UserNotificationPrefsService.getInstance().getTimezone('u1', 'g1')).toBeNull();
    });

    it('returns null for empty userId/guildId without touching the DB', async () => {
      const svc = UserNotificationPrefsService.getInstance();
      expect(await svc.getTimezone('', 'g1')).toBeNull();
      expect(await svc.getTimezone('u1', '')).toBeNull();
      expect(findOne).not.toHaveBeenCalled();
    });
  });

  describe('setTimezone', () => {
    it('validates and stores a recognized zone', async () => {
      findOneAndUpdate.mockResolvedValueOnce({ timezone: 'America/New_York' });
      const result = await UserNotificationPrefsService.getInstance().setTimezone(
        'u1',
        'g1',
        'America/New_York',
      );
      expect(result).toBe('America/New_York');
      const [filter, update] = findOneAndUpdate.mock.calls[0] as [
        Record<string, unknown>,
        { $set: Record<string, unknown> },
      ];
      expect(filter).toEqual({ userId: 'u1', guildId: 'g1' });
      expect(update.$set).toHaveProperty('timezone', 'America/New_York');
    });

    it('rejects an invalid zone before hitting the DB', async () => {
      await expect(
        UserNotificationPrefsService.getInstance().setTimezone('u1', 'g1', 'Mars/Phobos'),
      ).rejects.toThrow(/not a recognized IANA timezone/);
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('clears the preference with $unset when passed null', async () => {
      findOneAndUpdate.mockResolvedValueOnce({});
      const result = await UserNotificationPrefsService.getInstance().setTimezone(
        'u1',
        'g1',
        null,
      );
      expect(result).toBeNull();
      const update = findOneAndUpdate.mock.calls[0][1] as {
        $unset?: Record<string, unknown>;
      };
      expect(update.$unset).toHaveProperty('timezone');
    });

    it('throws on empty userId/guildId', async () => {
      const svc = UserNotificationPrefsService.getInstance();
      await expect(svc.setTimezone('', 'g1', 'UTC')).rejects.toThrow();
      await expect(svc.setTimezone('u1', '', 'UTC')).rejects.toThrow();
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  it('exposes a stable list of known pref keys', () => {
    expect(NOTIFICATION_PREF_KEYS).toEqual(['achievements', 'digest', 'rewind']);
  });
});
