import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Client } from 'discord.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/models/voice-channel-tracking.js', () => ({
  VoiceChannelTracking: {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
  },
}));

import { VoiceChannelTracking } from '../../src/models/voice-channel-tracking.js';

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

  it('streams the tracking collection via a cursor, not an unbounded find', async () => {
    const { VoiceChannelTruncationService } = await import('../../src/services/voice-channel-truncation.js');
    const instance = VoiceChannelTruncationService.getInstance(mockClient as Client);

    const cursor = jest.fn(() => ({
      async *[Symbol.asyncIterator]() {},
    }));
    const lean = jest.fn(() => ({ cursor }));
    const find = VoiceChannelTracking.find as jest.Mock;
    find.mockReturnValue({ lean });

    // performCleanup is the private worker that the cron tick invokes.
    await (instance as unknown as { performCleanup: () => Promise<unknown> }).performCleanup();

    expect(find).toHaveBeenCalledTimes(1);
    expect(cursor).toHaveBeenCalledTimes(1);
    // The unbounded materialisation path (.exec()) must never be used.
    expect(find.mock.results[0].value).not.toHaveProperty('exec');
  });
});
