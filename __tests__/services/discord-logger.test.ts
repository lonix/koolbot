import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Client, TextChannel } from 'discord.js';
import { DiscordLogger } from '../../src/services/discord-logger.js';
import { ConfigService } from '../../src/services/config-service.js';

jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');

describe('DiscordLogger', () => {
  let mockClient: Partial<Client>;
  let mockConfigService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      channels: {
        fetch: jest.fn(),
      } as any,
    } as Client;

    mockConfigService = {
      getAll: jest.fn().mockResolvedValue([]),
      getBoolean: jest.fn().mockResolvedValue(false),
      getString: jest.fn().mockResolvedValue(null),
      registerReloadCallback: jest.fn(),
    };

    (ConfigService.getInstance as jest.Mock).mockReturnValue(mockConfigService);
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = DiscordLogger.getInstance(mockClient as Client);
      const instance2 = DiscordLogger.getInstance(mockClient as Client);

      expect(instance1).toBe(instance2);
    });
  });

  describe('isReady', () => {
    it('should return false initially', () => {
      const logger = DiscordLogger.getInstance(mockClient as Client);

      expect(logger.isReady()).toBe(false);
    });
  });

  describe('initialize', () => {
    it('should initialize without errors', async () => {
      mockConfigService.getAll.mockResolvedValue([
        { key: 'core.errors.enabled', value: 'true' },
        { key: 'core.errors.channelId', value: 'channel123' },
      ]);

      const logger = DiscordLogger.getInstance(mockClient as Client);
      await logger.initialize();

      expect(mockConfigService.getAll).toHaveBeenCalled();
    });

    it('should handle initialization errors', async () => {
      mockConfigService.getAll.mockRejectedValue(new Error('Config error'));

      const logger = DiscordLogger.getInstance(mockClient as Client);
      await logger.initialize();

      // Should not throw
      expect(logger).toBeDefined();
    });

    it('should load log channels', async () => {
      mockConfigService.getAll.mockResolvedValue([
        { key: 'core.startup.enabled', value: 'true' },
        { key: 'core.startup.channelId', value: 'channel456' },
      ]);

      const logger = DiscordLogger.getInstance(mockClient as Client);
      await logger.initialize();

      expect(mockConfigService.getAll).toHaveBeenCalled();
    });
  });
});
