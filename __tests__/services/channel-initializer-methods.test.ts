import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Client } from 'discord.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/services/discord-logger.js');
jest.mock('../../src/utils/logger.js');

describe('ChannelInitializer Methods', () => {
  let mockClient: Partial<Client>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      guilds: {
        cache: new Map(),
      } as any,
      channels: {
        cache: new Map(),
      } as any,
    } as Client;
  });

  it('should have getInstance method', async () => {
    const { ChannelInitializer } = await import('../../src/services/channel-initializer.js');
    
    expect(typeof ChannelInitializer.getInstance).toBe('function');
  });

  it('should return singleton instance', async () => {
    const { ChannelInitializer } = await import('../../src/services/channel-initializer.js');
    
    const instance1 = ChannelInitializer.getInstance(mockClient as Client);
    const instance2 = ChannelInitializer.getInstance(mockClient as Client);

    expect(instance1).toBe(instance2);
  });

  it('should have initialize method', async () => {
    const { ChannelInitializer } = await import('../../src/services/channel-initializer.js');
    
    const instance = ChannelInitializer.getInstance(mockClient as Client);

    expect(typeof instance.initialize).toBe('function');
  });

  it('should have forceReinitialize method', async () => {
    const { ChannelInitializer } = await import('../../src/services/channel-initializer.js');
    
    const instance = ChannelInitializer.getInstance(mockClient as Client);

    expect(typeof instance.forceReinitialize).toBe('function');
  });
});
