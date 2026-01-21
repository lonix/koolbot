import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { VoiceChannelAnnouncer } from '../../src/services/voice-channel-announcer.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/services/voice-channel-tracker.js');
jest.mock('../../src/utils/logger.js');

describe('VoiceChannelAnnouncer', () => {
  let service: VoiceChannelAnnouncer;
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = { 
      user: { id: '123' },
      channels: { fetch: jest.fn() },
    };
    service = VoiceChannelAnnouncer.getInstance(mockClient);
  });

  describe('singleton pattern', () => {
    it('should create a singleton instance', () => {
      const instance1 = VoiceChannelAnnouncer.getInstance(mockClient);
      const instance2 = VoiceChannelAnnouncer.getInstance(mockClient);
      
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialization', () => {
    it('should create an instance with a client', () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(VoiceChannelAnnouncer);
    });
  });

  describe('public methods', () => {
    it('should have start method', () => {
      expect(typeof service.start).toBe('function');
    });

    it('should have makeAnnouncement method', () => {
      expect(typeof service.makeAnnouncement).toBe('function');
    });

    it('should have destroy method', () => {
      expect(typeof service.destroy).toBe('function');
    });
  });
});
