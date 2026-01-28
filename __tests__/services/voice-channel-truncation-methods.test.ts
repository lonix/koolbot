import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Client } from 'discord.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/models/voice-channel-tracking.js', () => ({
  VoiceChannelTracking: {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  },
}));

describe('VoiceChannelTruncationService Methods', () => {
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
    const { VoiceChannelTruncationService } = await import('../../src/services/voice-channel-truncation.js');
    
    expect(typeof VoiceChannelTruncationService.getInstance).toBe('function');
  });

  it('should return singleton instance', async () => {
    const { VoiceChannelTruncationService } = await import('../../src/services/voice-channel-truncation.js');
    
    const instance1 = VoiceChannelTruncationService.getInstance(mockClient as Client);
    const instance2 = VoiceChannelTruncationService.getInstance(mockClient as Client);

    expect(instance1).toBe(instance2);
  });

  it('should have runCleanup method', async () => {
    const { VoiceChannelTruncationService } = await import('../../src/services/voice-channel-truncation.js');
    
    const instance = VoiceChannelTruncationService.getInstance(mockClient as Client);

    expect(typeof instance.runCleanup).toBe('function');
  });

  it('should have getStatus method', async () => {
    const { VoiceChannelTruncationService } = await import('../../src/services/voice-channel-truncation.js');
    
    const instance = VoiceChannelTruncationService.getInstance(mockClient as Client);

    expect(typeof instance.getStatus).toBe('function');
  });
});
