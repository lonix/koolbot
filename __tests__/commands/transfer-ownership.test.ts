import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/transfer-ownership.js';

describe('Transfer Ownership Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('transfer-ownership');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Transfer ownership of your voice channel to another user');
    });

    it('should be a valid slash command', () => {
      expect(data.toJSON()).toHaveProperty('name', 'transfer-ownership');
      expect(data.toJSON()).toHaveProperty('description');
    });

    it('should have required user parameter', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBeGreaterThan(0);
      expect(json.options?.[0]).toMatchObject({
        name: 'user',
        type: 6, // User type
        required: true,
      });
    });

    it('should have description for user parameter', () => {
      const json = data.toJSON();
      expect(json.options?.[0].description).toBe('The user to transfer ownership to');
    });
  });
});
