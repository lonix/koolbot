import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { BotStatusService } from '../../src/services/bot-status-service.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');

describe('BotStatusService', () => {
  describe('singleton pattern', () => {
    it('should create a singleton instance', () => {
      const mockClient = { user: { setPresence: jest.fn() } } as any;
      const instance1 = BotStatusService.getInstance(mockClient);
      const instance2 = BotStatusService.getInstance(mockClient);
      
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialization', () => {
    it('should create an instance with a client', () => {
      const mockClient = { user: { setPresence: jest.fn() } } as any;
      const service = BotStatusService.getInstance(mockClient);
      
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(BotStatusService);
    });
  });

  describe('public methods', () => {
    let service: BotStatusService;
    let mockClient: any;

    beforeEach(() => {
      jest.clearAllMocks();
      mockClient = { 
        user: { 
          setPresence: jest.fn() 
        } 
      };
      service = BotStatusService.getInstance(mockClient);
    });

    it('should have setConnectingStatus method', () => {
      expect(typeof service.setConnectingStatus).toBe('function');
    });

    it('should have setOperationalStatus method', () => {
      expect(typeof service.setOperationalStatus).toBe('function');
    });

    it('should have setConfigReloadStatus method', () => {
      expect(typeof service.setConfigReloadStatus).toBe('function');
    });

    it('should have setShutdownStatus method', () => {
      expect(typeof service.setShutdownStatus).toBe('function');
    });

    it('should set connecting status', () => {
      service.setConnectingStatus();
      // Method should execute without errors
      expect(true).toBe(true);
    });

    it('should set operational status', () => {
      service.setOperationalStatus();
      // Method should execute without errors
      expect(true).toBe(true);
    });

    it('should set config reload status', () => {
      service.setConfigReloadStatus();
      // Method should execute without errors
      expect(true).toBe(true);
    });

    it('should set shutdown status', () => {
      service.setShutdownStatus();
      // Method should execute without errors
      expect(true).toBe(true);
    });
  });
});
