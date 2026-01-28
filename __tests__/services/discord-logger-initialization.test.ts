import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Client } from 'discord.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');

describe('DiscordLogger Initialization', () => {
  let mockClient: Partial<Client>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      channels: {
        fetch: jest.fn(),
      } as any,
    } as Client;
  });

  it('should have getInstance method', async () => {
    const { DiscordLogger } = await import('../../src/services/discord-logger.js');
    
    expect(typeof DiscordLogger.getInstance).toBe('function');
  });

  it('should create singleton instance', async () => {
    const { DiscordLogger } = await import('../../src/services/discord-logger.js');
    
    const instance1 = DiscordLogger.getInstance(mockClient as Client);
    const instance2 = DiscordLogger.getInstance(mockClient as Client);

    expect(instance1).toBe(instance2);
  });

  it('should have isReady method', async () => {
    const { DiscordLogger } = await import('../../src/services/discord-logger.js');
    
    const instance = DiscordLogger.getInstance(mockClient as Client);

    expect(typeof instance.isReady).toBe('function');
    expect(instance.isReady()).toBe(false);
  });

  it('should have initialize method', async () => {
    const { DiscordLogger } = await import('../../src/services/discord-logger.js');
    
    const instance = DiscordLogger.getInstance(mockClient as Client);

    expect(typeof instance.initialize).toBe('function');
  });
});
