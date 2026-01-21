import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { FriendshipListener } from '../../src/services/friendship-listener.js';

// Mock logger
jest.mock('../../src/utils/logger.js');

describe('FriendshipListener', () => {
  let listener: FriendshipListener;
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = { 
      on: jest.fn(),
    };
    listener = FriendshipListener.getInstance(mockClient);
  });

  describe('singleton pattern', () => {
    it('should create a singleton instance', () => {
      const instance1 = FriendshipListener.getInstance(mockClient);
      const instance2 = FriendshipListener.getInstance(mockClient);
      
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialization', () => {
    it('should create an instance with a client', () => {
      expect(listener).toBeDefined();
      expect(listener).toBeInstanceOf(FriendshipListener);
    });

    it('should have initialize method', () => {
      expect(typeof listener.initialize).toBe('function');
    });
  });
});
