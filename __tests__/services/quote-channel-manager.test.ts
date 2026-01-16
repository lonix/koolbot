import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { QuoteChannelManager } from '../../src/services/quote-channel-manager.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/services/quote-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('cron');

describe('QuoteChannelManager', () => {
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock Discord client
    mockClient = {
      isReady: jest.fn().mockReturnValue(true),
      user: { id: 'bot123', tag: 'TestBot#1234' },
      channels: {
        fetch: jest.fn(),
      },
      on: jest.fn(),
    };
  });

  describe('initialization', () => {
    it('should create a singleton instance', () => {
      const instance1 = QuoteChannelManager.getInstance(mockClient);
      const instance2 = QuoteChannelManager.getInstance(mockClient);
      
      expect(instance1).toBeDefined();
      expect(instance1).toBe(instance2);
    });

    it('should have required methods', () => {
      const manager = QuoteChannelManager.getInstance(mockClient);
      
      expect(typeof manager.initialize).toBe('function');
      expect(typeof manager.postQuote).toBe('function');
      expect(typeof manager.deleteQuoteMessage).toBe('function');
      expect(typeof manager.updateQuoteReactions).toBe('function');
      expect(typeof manager.syncExistingQuotes).toBe('function');
      expect(typeof manager.stop).toBe('function');
    });
  });

  describe('method signatures', () => {
    let manager: QuoteChannelManager;

    beforeEach(() => {
      manager = QuoteChannelManager.getInstance(mockClient);
    });

    it('initialize should accept no parameters', () => {
      expect(manager.initialize.length).toBe(0);
    });

    it('postQuote should accept 4 parameters', () => {
      expect(manager.postQuote.length).toBe(4);
    });

    it('deleteQuoteMessage should accept message ID', () => {
      expect(manager.deleteQuoteMessage.length).toBe(1);
    });

    it('updateQuoteReactions should accept message ID', () => {
      expect(manager.updateQuoteReactions.length).toBe(1);
    });

    it('syncExistingQuotes should accept no parameters', () => {
      expect(manager.syncExistingQuotes.length).toBe(0);
    });

    it('stop should accept no parameters', () => {
      expect(manager.stop.length).toBe(0);
    });
  });
});
