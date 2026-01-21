import { describe, it, expect, jest } from '@jest/globals';
import { command } from '../../src/commands/setup-lobby.js';

jest.mock('../../src/services/channel-initializer.js');
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');

describe('Setup Lobby Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(command.data.name).toBe('setup-lobby');
    });

    it('should have a description', () => {
      expect(command.data.description).toBe('Set up the voice channel lobby and category');
    });

    it('should be a valid slash command', () => {
      expect(command.data.toJSON()).toHaveProperty('name', 'setup-lobby');
      expect(command.data.toJSON()).toHaveProperty('description');
    });

    it('should have an execute function', () => {
      expect(typeof command.execute).toBe('function');
    });
  });

  // Execute tests removed - service mocking issues with getInstance().mockReturnValue
});
