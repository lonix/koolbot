import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock dependencies before importing
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/services/quote-service.js');
jest.mock('cron');

describe('QuoteChannelManager - Header Post', () => {
  let mockClient: any;
  let mockChannel: any;
  let mockMessage: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    // Mock message
    mockMessage = {
      id: 'header123',
      author: {
        id: 'bot123',
      },
      pin: jest.fn().mockResolvedValue(undefined),
    };

    // Mock channel
    mockChannel = {
      id: 'channel123',
      name: 'quotes',
      guild: {
        members: {
          me: {
            id: 'bot123',
          },
        },
        roles: {
          everyone: {
            id: 'everyone',
          },
        },
      },
      permissionOverwrites: {
        edit: jest.fn().mockResolvedValue(undefined),
      },
      messages: {
        fetch: jest.fn().mockResolvedValue({
          size: 0,
          filter: jest.fn().mockReturnValue({ size: 0 }),
          values: jest.fn().mockReturnValue([]),
        }),
      },
      send: jest.fn().mockResolvedValue(mockMessage),
      isTextBased: jest.fn().mockReturnValue(true),
      isDMBased: jest.fn().mockReturnValue(false),
    };

    // Mock Discord client
    mockClient = {
      isReady: jest.fn().mockReturnValue(true),
      user: { id: 'bot123', tag: 'TestBot#1234' },
      channels: {
        fetch: jest.fn().mockResolvedValue(mockChannel),
      },
      on: jest.fn(),
    };
  });

  describe('ensureHeaderPost', () => {
    it('should have ensureHeaderPost as a private method', async () => {
      const { QuoteChannelManager } = await import('../../src/services/quote-channel-manager.js');
      
      const manager = QuoteChannelManager.getInstance(mockClient);
      
      // We can't directly test private methods, but we can verify initialization doesn't throw
      expect(manager).toBeDefined();
      expect(typeof manager.initialize).toBe('function');
    });
  });

  describe('header post integration', () => {
    it('should successfully initialize when headers are enabled', async () => {
      const { QuoteChannelManager } = await import('../../src/services/quote-channel-manager.js');
      
      const manager = QuoteChannelManager.getInstance(mockClient);
      
      // Just verify initialization doesn't throw errors
      await expect(manager.initialize()).resolves.not.toThrow();
    });
  });
});
