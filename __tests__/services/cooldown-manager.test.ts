import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { CooldownManager } from '../../src/services/cooldown-manager.js';

describe('CooldownManager', () => {
  let cooldownManager: CooldownManager;

  beforeEach(() => {
    cooldownManager = new CooldownManager();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('isOnCooldown', () => {
    it('should return false when user has no cooldown set', () => {
      const result = cooldownManager.isOnCooldown('user1', 'command1', 60);
      expect(result).toBe(false);
    });

    it('should return true when user is on cooldown', () => {
      cooldownManager.setCooldown('user1', 'command1');
      const result = cooldownManager.isOnCooldown('user1', 'command1', 60);
      expect(result).toBe(true);
    });

    it('should return false when cooldown has expired', () => {
      cooldownManager.setCooldown('user1', 'command1');
      
      // Advance time by 61 seconds
      jest.advanceTimersByTime(61000);
      
      const result = cooldownManager.isOnCooldown('user1', 'command1', 60);
      expect(result).toBe(false);
    });

    it('should handle different commands independently', () => {
      cooldownManager.setCooldown('user1', 'command1');
      
      const result1 = cooldownManager.isOnCooldown('user1', 'command1', 60);
      const result2 = cooldownManager.isOnCooldown('user1', 'command2', 60);
      
      expect(result1).toBe(true);
      expect(result2).toBe(false);
    });

    it('should handle different users independently', () => {
      cooldownManager.setCooldown('user1', 'command1');
      
      const result1 = cooldownManager.isOnCooldown('user1', 'command1', 60);
      const result2 = cooldownManager.isOnCooldown('user2', 'command1', 60);
      
      expect(result1).toBe(true);
      expect(result2).toBe(false);
    });

    it('should handle zero cooldown duration', () => {
      cooldownManager.setCooldown('user1', 'command1');
      const result = cooldownManager.isOnCooldown('user1', 'command1', 0);
      expect(result).toBe(false);
    });

    it('should handle very long cooldown durations', () => {
      cooldownManager.setCooldown('user1', 'command1');
      const result = cooldownManager.isOnCooldown('user1', 'command1', 86400); // 24 hours
      expect(result).toBe(true);
    });
  });

  describe('setCooldown', () => {
    it('should set cooldown for user and command', () => {
      cooldownManager.setCooldown('user1', 'command1');
      const result = cooldownManager.isOnCooldown('user1', 'command1', 60);
      expect(result).toBe(true);
    });

    it('should update existing cooldown', () => {
      cooldownManager.setCooldown('user1', 'command1');
      jest.advanceTimersByTime(30000); // 30 seconds
      cooldownManager.setCooldown('user1', 'command1');
      
      // Should still be on cooldown for another 60 seconds from the reset
      jest.advanceTimersByTime(30000); // Total 60 seconds from initial
      const result = cooldownManager.isOnCooldown('user1', 'command1', 60);
      expect(result).toBe(true);
    });

    it('should handle multiple commands for same user', () => {
      cooldownManager.setCooldown('user1', 'command1');
      cooldownManager.setCooldown('user1', 'command2');
      
      expect(cooldownManager.isOnCooldown('user1', 'command1', 60)).toBe(true);
      expect(cooldownManager.isOnCooldown('user1', 'command2', 60)).toBe(true);
    });

    it('should handle special characters in user IDs', () => {
      cooldownManager.setCooldown('user-123!@#', 'command1');
      expect(cooldownManager.isOnCooldown('user-123!@#', 'command1', 60)).toBe(true);
    });

    it('should handle special characters in command names', () => {
      cooldownManager.setCooldown('user1', 'command-test_1');
      expect(cooldownManager.isOnCooldown('user1', 'command-test_1', 60)).toBe(true);
    });
  });

  describe('getRemainingCooldown', () => {
    it('should return 0 when no cooldown is set', () => {
      const result = cooldownManager.getRemainingCooldown('user1', 'command1', 60);
      expect(result).toBe(0);
    });

    it('should return remaining seconds when on cooldown', () => {
      cooldownManager.setCooldown('user1', 'command1');
      const result = cooldownManager.getRemainingCooldown('user1', 'command1', 60);
      expect(result).toBe(60);
    });

    it('should decrease remaining time as time passes', () => {
      cooldownManager.setCooldown('user1', 'command1');
      jest.advanceTimersByTime(30000); // 30 seconds
      
      const result = cooldownManager.getRemainingCooldown('user1', 'command1', 60);
      expect(result).toBe(30);
    });

    it('should return 0 when cooldown has expired', () => {
      cooldownManager.setCooldown('user1', 'command1');
      jest.advanceTimersByTime(61000); // 61 seconds
      
      const result = cooldownManager.getRemainingCooldown('user1', 'command1', 60);
      expect(result).toBe(0);
    });

    it('should round up partial seconds', () => {
      cooldownManager.setCooldown('user1', 'command1');
      jest.advanceTimersByTime(59100); // 59.1 seconds
      
      const result = cooldownManager.getRemainingCooldown('user1', 'command1', 60);
      expect(result).toBe(1);
    });

    it('should handle exactly at cooldown boundary', () => {
      cooldownManager.setCooldown('user1', 'command1');
      jest.advanceTimersByTime(60000); // Exactly 60 seconds
      
      const result = cooldownManager.getRemainingCooldown('user1', 'command1', 60);
      expect(result).toBe(0);
    });

    it('should return 0 for zero cooldown duration', () => {
      cooldownManager.setCooldown('user1', 'command1');
      const result = cooldownManager.getRemainingCooldown('user1', 'command1', 0);
      expect(result).toBe(0);
    });
  });

  describe('clearCooldown', () => {
    it('should clear specific cooldown', () => {
      cooldownManager.setCooldown('user1', 'command1');
      cooldownManager.clearCooldown('user1', 'command1');
      
      const result = cooldownManager.isOnCooldown('user1', 'command1', 60);
      expect(result).toBe(false);
    });

    it('should not affect other commands', () => {
      cooldownManager.setCooldown('user1', 'command1');
      cooldownManager.setCooldown('user1', 'command2');
      cooldownManager.clearCooldown('user1', 'command1');
      
      expect(cooldownManager.isOnCooldown('user1', 'command1', 60)).toBe(false);
      expect(cooldownManager.isOnCooldown('user1', 'command2', 60)).toBe(true);
    });

    it('should not affect other users', () => {
      cooldownManager.setCooldown('user1', 'command1');
      cooldownManager.setCooldown('user2', 'command1');
      cooldownManager.clearCooldown('user1', 'command1');
      
      expect(cooldownManager.isOnCooldown('user1', 'command1', 60)).toBe(false);
      expect(cooldownManager.isOnCooldown('user2', 'command1', 60)).toBe(true);
    });

    it('should handle clearing non-existent cooldown gracefully', () => {
      expect(() => {
        cooldownManager.clearCooldown('user1', 'command1');
      }).not.toThrow();
    });

    it('should allow setting cooldown after clearing', () => {
      cooldownManager.setCooldown('user1', 'command1');
      cooldownManager.clearCooldown('user1', 'command1');
      cooldownManager.setCooldown('user1', 'command1');
      
      expect(cooldownManager.isOnCooldown('user1', 'command1', 60)).toBe(true);
    });
  });

  describe('clearAllCooldowns', () => {
    it('should clear all cooldowns', () => {
      cooldownManager.setCooldown('user1', 'command1');
      cooldownManager.setCooldown('user1', 'command2');
      cooldownManager.setCooldown('user2', 'command1');
      
      cooldownManager.clearAllCooldowns();
      
      expect(cooldownManager.isOnCooldown('user1', 'command1', 60)).toBe(false);
      expect(cooldownManager.isOnCooldown('user1', 'command2', 60)).toBe(false);
      expect(cooldownManager.isOnCooldown('user2', 'command1', 60)).toBe(false);
    });

    it('should work on empty cooldown manager', () => {
      expect(() => {
        cooldownManager.clearAllCooldowns();
      }).not.toThrow();
    });

    it('should allow setting new cooldowns after clearing all', () => {
      cooldownManager.setCooldown('user1', 'command1');
      cooldownManager.clearAllCooldowns();
      cooldownManager.setCooldown('user1', 'command1');
      
      expect(cooldownManager.isOnCooldown('user1', 'command1', 60)).toBe(true);
    });

    it('should clear many cooldowns efficiently', () => {
      // Set cooldowns for many users and commands
      for (let i = 0; i < 100; i++) {
        cooldownManager.setCooldown(`user${i}`, `command${i}`);
      }
      
      cooldownManager.clearAllCooldowns();
      
      // Verify all are cleared
      for (let i = 0; i < 100; i++) {
        expect(cooldownManager.isOnCooldown(`user${i}`, `command${i}`, 60)).toBe(false);
      }
    });
  });

  describe('edge cases', () => {
    it('should handle rapid consecutive setCooldown calls', () => {
      cooldownManager.setCooldown('user1', 'command1');
      cooldownManager.setCooldown('user1', 'command1');
      cooldownManager.setCooldown('user1', 'command1');
      
      expect(cooldownManager.isOnCooldown('user1', 'command1', 60)).toBe(true);
    });

    it('should handle empty user ID', () => {
      cooldownManager.setCooldown('', 'command1');
      expect(cooldownManager.isOnCooldown('', 'command1', 60)).toBe(true);
    });

    it('should handle empty command name', () => {
      cooldownManager.setCooldown('user1', '');
      expect(cooldownManager.isOnCooldown('user1', '', 60)).toBe(true);
    });

    it('should handle very short time intervals', () => {
      cooldownManager.setCooldown('user1', 'command1');
      jest.advanceTimersByTime(1); // 1ms
      
      const result = cooldownManager.getRemainingCooldown('user1', 'command1', 1);
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });
});
