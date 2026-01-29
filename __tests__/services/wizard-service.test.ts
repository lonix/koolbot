import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { WizardService } from '../../src/services/wizard-service.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');

describe('WizardService', () => {
  let service: WizardService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = WizardService.getInstance();
  });

  describe('singleton pattern', () => {
    it('should create a singleton instance', () => {
      const instance1 = WizardService.getInstance();
      const instance2 = WizardService.getInstance();
      
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialization', () => {
    it('should create an instance', () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(WizardService);
    });
  });

  describe('public methods', () => {
    it('should have createSession method', () => {
      expect(typeof service.createSession).toBe('function');
    });

    it('should have getSession method', () => {
      expect(typeof service.getSession).toBe('function');
    });

    it('should have updateSession method', () => {
      expect(typeof service.updateSession).toBe('function');
    });

    it('should have endSession method', () => {
      expect(typeof service.endSession).toBe('function');
    });

    it('should have addConfiguration method', () => {
      expect(typeof service.addConfiguration).toBe('function');
    });

    it('should have nextStep method', () => {
      expect(typeof service.nextStep).toBe('function');
    });

    it('should have previousStep method', () => {
      expect(typeof service.previousStep).toBe('function');
    });

    it('should have shutdown method', () => {
      expect(typeof service.shutdown).toBe('function');
    });
  });

  describe('session management', () => {
    const mockUserId = 'user-123';
    const mockGuildId = 'guild-456';

    it('should create a new session', () => {
      const state = service.createSession(mockUserId, mockGuildId);
      
      expect(state).toBeDefined();
      expect(state.userId).toBe(mockUserId);
      expect(state.guildId).toBe(mockGuildId);
      expect(state.currentStep).toBe(0);
      expect(Array.isArray(state.selectedFeatures)).toBe(true);
      expect(state.startTime).toBeInstanceOf(Date);
    });

    it('should retrieve an existing session', () => {
      service.createSession(mockUserId, mockGuildId);
      const state = service.getSession(mockUserId, mockGuildId);
      
      expect(state).toBeDefined();
      expect(state?.userId).toBe(mockUserId);
    });

    it('should return null for non-existent session', () => {
      const state = service.getSession('non-existent', 'non-existent');
      
      expect(state).toBeNull();
    });

    it('should update an existing session', () => {
      service.createSession(mockUserId, mockGuildId);
      const updated = service.updateSession(mockUserId, mockGuildId, {
        currentStep: 2,
      });
      
      expect(updated).toBe(true);
      const state = service.getSession(mockUserId, mockGuildId);
      expect(state?.currentStep).toBe(2);
    });

    it('should return false when updating non-existent session', () => {
      const updated = service.updateSession('non-existent', 'non-existent', {
        currentStep: 2,
      });
      
      expect(updated).toBe(false);
    });

    it('should end a session', () => {
      service.createSession(mockUserId, mockGuildId);
      const result = service.endSession(mockUserId, mockGuildId);
      
      expect(result).toBe(true);
      const state = service.getSession(mockUserId, mockGuildId);
      expect(state).toBeNull();
    });

    it('should return false when ending non-existent session', () => {
      const result = service.endSession('non-existent', 'non-existent');
      
      expect(result).toBe(false);
    });

    it('should add configuration to session', () => {
      service.createSession(mockUserId, mockGuildId);
      service.addConfiguration(mockUserId, mockGuildId, 'test.key', 'test-value');
      const state = service.getSession(mockUserId, mockGuildId);
      
      expect(state?.configuration['test.key']).toBe('test-value');
    });

    it('should navigate to next step', () => {
      service.createSession(mockUserId, mockGuildId);
      const result = service.nextStep(mockUserId, mockGuildId);
      
      expect(result).toBe(true);
      const state = service.getSession(mockUserId, mockGuildId);
      expect(state?.currentStep).toBe(1);
    });

    it('should navigate to previous step', () => {
      service.createSession(mockUserId, mockGuildId);
      service.nextStep(mockUserId, mockGuildId);
      const result = service.previousStep(mockUserId, mockGuildId);
      
      expect(result).toBe(true);
      const state = service.getSession(mockUserId, mockGuildId);
      expect(state?.currentStep).toBe(0);
    });

    it('should initialize channelPage to 0 when creating session', () => {
      const state = service.createSession(mockUserId, mockGuildId);
      
      expect(state.channelPage).toBe(0);
    });

    it('should update channelPage in session', () => {
      service.createSession(mockUserId, mockGuildId);
      const updated = service.updateSession(mockUserId, mockGuildId, {
        channelPage: 2,
      });
      
      expect(updated).toBe(true);
      const state = service.getSession(mockUserId, mockGuildId);
      expect(state?.channelPage).toBe(2);
    });
  });

  describe('shutdown', () => {
    it('should shutdown without errors', () => {
      service.shutdown();
      
      // Method should execute without errors
      expect(true).toBe(true);
    });
  });
});
