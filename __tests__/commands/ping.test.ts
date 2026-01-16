import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/ping.js';

describe('Ping Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('ping');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Replies with Pong!');
    });

    it('should be a valid slash command', () => {
      expect(data.toJSON()).toHaveProperty('name', 'ping');
      expect(data.toJSON()).toHaveProperty('description', 'Replies with Pong!');
    });
  });
});
