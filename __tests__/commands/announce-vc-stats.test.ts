import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/announce-vc-stats.js';

describe('Announce VC Stats Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('announce-vc-stats');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Manually trigger the voice channel activity announcement');
    });

    it('should be a valid slash command', () => {
      expect(data.toJSON()).toHaveProperty('name', 'announce-vc-stats');
      expect(data.toJSON()).toHaveProperty('description');
    });

    it('should require administrator permissions', () => {
      const json = data.toJSON();
      expect(json.default_member_permissions).toBe('8'); // Administrator = 0x8
    });
  });
});
