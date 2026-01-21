import { describe, it, expect, jest } from '@jest/globals';
import type { Client } from 'discord.js';

// Mock all dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/services/voice-channel-tracker.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/models/user-voice-preferences.js');

describe('VoiceChannelManager Initialization', () => {
  let mockClient: Partial<Client>;

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
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should have getInstance method', async () => {
    const { VoiceChannelManager } = await import('../../src/services/voice-channel-manager.js');
    
    expect(typeof VoiceChannelManager.getInstance).toBe('function');
  });

  it('should return singleton instance', async () => {
    const { VoiceChannelManager } = await import('../../src/services/voice-channel-manager.js');
    
    const instance1 = VoiceChannelManager.getInstance(mockClient as Client);
    const instance2 = VoiceChannelManager.getInstance(mockClient as Client);

    expect(instance1).toBe(instance2);
  });
});
