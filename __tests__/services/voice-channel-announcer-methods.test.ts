import { describe, it, expect, jest } from '@jest/globals';
import type { Client } from 'discord.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/services/voice-channel-tracker.js');
jest.mock('../../src/services/discord-logger.js');
jest.mock('../../src/utils/logger.js');

describe('VoiceChannelAnnouncer Methods', () => {
  let mockClient: Partial<Client>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      guilds: {
        cache: new Map(),
      } as any,
    } as Client;
  });

  it('should have getInstance method', async () => {
    const { VoiceChannelAnnouncer } = await import('../../src/services/voice-channel-announcer.js');
    
    expect(typeof VoiceChannelAnnouncer.getInstance).toBe('function');
  });

  it('should return singleton instance', async () => {
    const { VoiceChannelAnnouncer } = await import('../../src/services/voice-channel-announcer.js');
    
    const instance1 = VoiceChannelAnnouncer.getInstance(mockClient as Client);
    const instance2 = VoiceChannelAnnouncer.getInstance(mockClient as Client);

    expect(instance1).toBe(instance2);
  });

  it('should have announceWeeklyStats method', async () => {
    const { VoiceChannelAnnouncer } = await import('../../src/services/voice-channel-announcer.js');
    
    const instance = VoiceChannelAnnouncer.getInstance(mockClient as Client);

    expect(typeof instance.announceWeeklyStats).toBe('function');
  });
});
