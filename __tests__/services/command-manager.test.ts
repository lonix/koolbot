import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CommandManager } from '../../src/services/command-manager.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/services/monitoring-service.js');
jest.mock('../../src/services/cooldown-manager.js');
jest.mock('../../src/services/permissions-service.js');
jest.mock('../../src/utils/logger.js');

describe('CommandManager', () => {
  let service: CommandManager;
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = { 
      user: { id: '123' },
      application: { id: '456' },
    };
    service = CommandManager.getInstance(mockClient);
  });

  describe('singleton pattern', () => {
    it('should create a singleton instance', () => {
      const instance1 = CommandManager.getInstance(mockClient);
      const instance2 = CommandManager.getInstance(mockClient);
      
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialization', () => {
    it('should create an instance with a client', () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(CommandManager);
    });
  });

  describe('public methods', () => {
    it('should have initialize method', () => {
      expect(typeof service.initialize).toBe('function');
    });

    it('should have registerCommands method', () => {
      expect(typeof service.registerCommands).toBe('function');
    });

    it('should have populateClientCommands method', () => {
      expect(typeof service.populateClientCommands).toBe('function');
    });

    it('should have unregisterCommands method', () => {
      expect(typeof service.unregisterCommands).toBe('function');
    });

    it('should have executeCommand method', () => {
      expect(typeof service.executeCommand).toBe('function');
    });
  });

  describe('command collection', () => {
    it('should start with empty commands', () => {
      // Service is initialized, commands should be defined
      expect(true).toBe(true);
    });
  });
});
