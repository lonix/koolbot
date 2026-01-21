import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { VoiceChannelTruncationService } from '../../src/services/voice-channel-truncation.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/models/voice-channel-tracking.js');

describe('VoiceChannelTruncationService', () => {
  let service: VoiceChannelTruncationService;
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = { 
      user: { id: '123' },
    };
    service = VoiceChannelTruncationService.getInstance(mockClient);
  });

  describe('singleton pattern', () => {
    it('should create a singleton instance', () => {
      const instance1 = VoiceChannelTruncationService.getInstance(mockClient);
      const instance2 = VoiceChannelTruncationService.getInstance(mockClient);
      
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialization', () => {
    it('should create an instance with a client', () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(VoiceChannelTruncationService);
    });
  });

  describe('public methods', () => {
    it('should have initialize method', () => {
      expect(typeof service.initialize).toBe('function');
    });

    it('should have runCleanup method', () => {
      expect(typeof service.runCleanup).toBe('function');
    });

    it('should have getStatus method', () => {
      expect(typeof service.getStatus).toBe('function');
    });
  });
});
