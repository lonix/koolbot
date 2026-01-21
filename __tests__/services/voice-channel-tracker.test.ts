import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { VoiceChannelTracker } from '../../src/services/voice-channel-tracker.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/models/voice-channel-tracking.js');

describe('VoiceChannelTracker', () => {
  let service: VoiceChannelTracker;
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = { 
      user: { id: '123' },
    };
    service = VoiceChannelTracker.getInstance(mockClient);
  });

  describe('singleton pattern', () => {
    it('should create a singleton instance', () => {
      const instance1 = VoiceChannelTracker.getInstance(mockClient);
      const instance2 = VoiceChannelTracker.getInstance(mockClient);
      
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialization', () => {
    it('should create an instance with a client', () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(VoiceChannelTracker);
    });
  });

  describe('public methods', () => {
    it('should have handleVoiceStateUpdate method', () => {
      expect(typeof service.handleVoiceStateUpdate).toBe('function');
    });

    it('should have getActiveSession method', () => {
      expect(typeof service.getActiveSession).toBe('function');
    });

    it('should have getUserStats method', () => {
      expect(typeof service.getUserStats).toBe('function');
    });

    it('should have getTopUsers method', () => {
      expect(typeof service.getTopUsers).toBe('function');
    });

    it('should have getUserLastSeen method', () => {
      expect(typeof service.getUserLastSeen).toBe('function');
    });
  });
});
