import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Client } from 'discord.js';
import { VoiceChannelManager } from '../../src/services/voice-channel-manager.js';
import { ConfigService } from '../../src/services/config-service.js';

jest.mock('../../src/services/config-service.js');
jest.mock('../../src/services/voice-channel-tracker.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/models/user-voice-preferences.js');

describe('VoiceChannelManager', () => {
  let mockClient: Partial<Client>;
  let mockConfigService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockClient = {
      guilds: {
        fetch: jest.fn(),
      } as any,
      channels: {
        fetch: jest.fn(),
      } as any,
    } as Client;

    mockConfigService = {
      getBoolean: jest.fn().mockResolvedValue(false),
      getString: jest.fn().mockResolvedValue(null),
      registerReloadCallback: jest.fn(),
      getInstance: jest.fn(),
    };

    (ConfigService.getInstance as jest.Mock).mockReturnValue(mockConfigService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = VoiceChannelManager.getInstance(mockClient as Client);
      const instance2 = VoiceChannelManager.getInstance(mockClient as Client);

      expect(instance1).toBe(instance2);
    });

    it('should start periodic cleanup on creation', () => {
      const instance = VoiceChannelManager.getInstance(mockClient as Client);

      expect(instance).toBeDefined();
      // Timers should be set up
      expect(jest.getTimerCount()).toBeGreaterThan(0);
    });
  });
});
