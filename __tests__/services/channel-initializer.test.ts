import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ChannelInitializer } from '../../src/services/channel-initializer.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/services/voice-channel-manager.js');
jest.mock('../../src/utils/logger.js');

describe('ChannelInitializer', () => {
  let service: ChannelInitializer;
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = { 
      guilds: {
        fetch: jest.fn(),
      },
    };
    service = ChannelInitializer.getInstance(mockClient);
  });

  describe('singleton pattern', () => {
    it('should create a singleton instance', () => {
      const instance1 = ChannelInitializer.getInstance(mockClient);
      const instance2 = ChannelInitializer.getInstance(mockClient);
      
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialization', () => {
    it('should create an instance with a client', () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(ChannelInitializer);
    });
  });

  describe('public methods', () => {
    it('should have initialize method', () => {
      expect(typeof service.initialize).toBe('function');
    });

    it('should have initializeChannels method', () => {
      expect(typeof service.initializeChannels).toBe('function');
    });

    it('should have forceReinitialize method', () => {
      expect(typeof service.forceReinitialize).toBe('function');
    });
  });
});
