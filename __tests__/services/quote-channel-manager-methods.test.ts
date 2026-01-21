import { describe, it, expect, jest } from '@jest/globals';
import type { Client } from 'discord.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');

describe('QuoteChannelManager Methods', () => {
  let mockClient: Partial<Client>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      guilds: {
        cache: new Map(),
      } as any,
      channels: {
        fetch: jest.fn(),
      } as any,
    } as Client;
  });

  it('should have getInstance method', async () => {
    const { QuoteChannelManager } = await import('../../src/services/quote-channel-manager.js');
    
    expect(typeof QuoteChannelManager.getInstance).toBe('function');
  });

  it('should return singleton instance', async () => {
    const { QuoteChannelManager } = await import('../../src/services/quote-channel-manager.js');
    
    const instance1 = QuoteChannelManager.getInstance(mockClient as Client);
    const instance2 = QuoteChannelManager.getInstance(mockClient as Client);

    expect(instance1).toBe(instance2);
  });

  it('should have postQuote method', async () => {
    const { QuoteChannelManager } = await import('../../src/services/quote-channel-manager.js');
    
    const instance = QuoteChannelManager.getInstance(mockClient as Client);

    expect(typeof instance.postQuote).toBe('function');
  });
});
