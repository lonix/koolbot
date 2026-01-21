import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Client } from 'discord.js';
import { ScheduledAnnouncementService } from '../../src/services/scheduled-announcement-service.js';
import { ConfigService } from '../../src/services/config-service.js';

jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/models/scheduled-announcement.js');

describe('ScheduledAnnouncementService', () => {
  let mockClient: Partial<Client>;
  let mockConfigService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      isReady: jest.fn().mockReturnValue(true),
      channels: {
        fetch: jest.fn(),
      } as any,
    } as Client;

    mockConfigService = {
      getBoolean: jest.fn().mockResolvedValue(false),
      getString: jest.fn().mockResolvedValue(null),
      registerReloadCallback: jest.fn(),
    };

    (ConfigService.getInstance as jest.Mock).mockReturnValue(mockConfigService);
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = ScheduledAnnouncementService.getInstance(mockClient as Client);
      const instance2 = ScheduledAnnouncementService.getInstance(mockClient as Client);

      expect(instance1).toBe(instance2);
    });

    it('should register reload callback', () => {
      ScheduledAnnouncementService.getInstance(mockClient as Client);

      expect(mockConfigService.registerReloadCallback).toHaveBeenCalled();
    });
  });
});
