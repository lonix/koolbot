import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { CooldownManager } from "../../src/services/cooldown-manager.js";

describe("Rate Limiting", () => {
  let cooldownManager: CooldownManager;

  beforeEach(() => {
    cooldownManager = new CooldownManager();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("isRateLimited", () => {
    it("should return false when user has not exceeded limit", () => {
      cooldownManager.trackCommandExecution("user1", 10);
      cooldownManager.trackCommandExecution("user1", 10);

      const result = cooldownManager.isRateLimited("user1", 5, 10);
      expect(result).toBe(false);
    });

    it("should return true when user has reached limit", () => {
      // Execute 5 commands (the limit)
      for (let i = 0; i < 5; i++) {
        cooldownManager.trackCommandExecution("user1", 10);
      }

      const result = cooldownManager.isRateLimited("user1", 5, 10);
      expect(result).toBe(true);
    });

    it("should return false when commands are outside the time window", () => {
      // Execute 5 commands
      for (let i = 0; i < 5; i++) {
        cooldownManager.trackCommandExecution("user1", 10);
      }

      // Advance time beyond the window
      jest.advanceTimersByTime(11000); // 11 seconds

      const result = cooldownManager.isRateLimited("user1", 5, 10);
      expect(result).toBe(false);
    });

    it("should track different users independently", () => {
      // User1 executes 5 commands
      for (let i = 0; i < 5; i++) {
        cooldownManager.trackCommandExecution("user1", 10);
      }

      // User2 executes 2 commands
      cooldownManager.trackCommandExecution("user2", 10);
      cooldownManager.trackCommandExecution("user2", 10);

      expect(cooldownManager.isRateLimited("user1", 5, 10)).toBe(true);
      expect(cooldownManager.isRateLimited("user2", 5, 10)).toBe(false);
    });

    it("should handle sliding window correctly", () => {
      // Execute 5 commands
      for (let i = 0; i < 5; i++) {
        cooldownManager.trackCommandExecution("user1", 10);
        if (i < 4) {
          jest.advanceTimersByTime(2000); // 2 seconds between each
        }
      }

      // Total time elapsed: 8 seconds
      // Should be rate limited
      expect(cooldownManager.isRateLimited("user1", 5, 10)).toBe(true);

      // Advance 3 more seconds (total 11 seconds from first command)
      jest.advanceTimersByTime(3000);

      // First command should be outside the window now
      // Only 4 commands remain in the window
      expect(cooldownManager.isRateLimited("user1", 5, 10)).toBe(false);
    });
  });

  describe("trackCommandExecution", () => {
    it("should track command execution", () => {
      cooldownManager.trackCommandExecution("user1", 10);

      const count = cooldownManager.getCommandCount("user1", 10);
      expect(count).toBe(1);
    });

    it("should clean up old entries automatically", () => {
      cooldownManager.trackCommandExecution("user1", 10);
      jest.advanceTimersByTime(11000); // 11 seconds

      cooldownManager.trackCommandExecution("user1", 10); // This should clean up old entry

      const count = cooldownManager.getCommandCount("user1", 10);
      expect(count).toBe(1);
    });

    it("should handle multiple executions", () => {
      for (let i = 0; i < 3; i++) {
        cooldownManager.trackCommandExecution("user1", 10);
      }

      const count = cooldownManager.getCommandCount("user1", 10);
      expect(count).toBe(3);
    });
  });

  describe("getCommandCount", () => {
    it("should return 0 when no commands executed", () => {
      const count = cooldownManager.getCommandCount("user1", 10);
      expect(count).toBe(0);
    });

    it("should return correct count within window", () => {
      cooldownManager.trackCommandExecution("user1", 10);
      cooldownManager.trackCommandExecution("user1", 10);
      cooldownManager.trackCommandExecution("user1", 10);

      const count = cooldownManager.getCommandCount("user1", 10);
      expect(count).toBe(3);
    });

    it("should exclude commands outside the window", () => {
      cooldownManager.trackCommandExecution("user1", 10);
      cooldownManager.trackCommandExecution("user1", 10);

      jest.advanceTimersByTime(11000); // 11 seconds

      cooldownManager.trackCommandExecution("user1", 10);

      const count = cooldownManager.getCommandCount("user1", 10);
      expect(count).toBe(1); // Only the last command
    });

    it("should handle different time windows", () => {
      cooldownManager.trackCommandExecution("user1", 10);
      jest.advanceTimersByTime(6000); // 6 seconds
      cooldownManager.trackCommandExecution("user1", 10);

      // Both should be in 10-second window
      expect(cooldownManager.getCommandCount("user1", 10)).toBe(2);

      // Only the second should be in 5-second window
      expect(cooldownManager.getCommandCount("user1", 5)).toBe(1);
    });
  });

  describe("getRateLimitReset", () => {
    it("should return 0 when not rate limited", () => {
      cooldownManager.trackCommandExecution("user1", 10);

      const reset = cooldownManager.getRateLimitReset("user1", 5, 10);
      expect(reset).toBe(0);
    });

    it("should return time until oldest command expires", () => {
      // Execute 5 commands
      for (let i = 0; i < 5; i++) {
        cooldownManager.trackCommandExecution("user1", 10);
      }

      const reset = cooldownManager.getRateLimitReset("user1", 5, 10);
      expect(reset).toBe(10);
    });

    it("should update as time passes", () => {
      // Execute 5 commands
      for (let i = 0; i < 5; i++) {
        cooldownManager.trackCommandExecution("user1", 10);
      }

      jest.advanceTimersByTime(4000); // 4 seconds

      const reset = cooldownManager.getRateLimitReset("user1", 5, 10);
      expect(reset).toBe(6); // 10 - 4 = 6
    });

    it("should return 0 when rate limit expires", () => {
      // Execute 5 commands
      for (let i = 0; i < 5; i++) {
        cooldownManager.trackCommandExecution("user1", 10);
      }

      jest.advanceTimersByTime(11000); // 11 seconds

      const reset = cooldownManager.getRateLimitReset("user1", 5, 10);
      expect(reset).toBe(0);
    });

    it("should handle sliding window reset correctly", () => {
      cooldownManager.trackCommandExecution("user1", 10);
      jest.advanceTimersByTime(2000); // 2 seconds

      for (let i = 0; i < 4; i++) {
        cooldownManager.trackCommandExecution("user1", 10);
      }

      // Now rate limited, reset should be based on oldest command (2 seconds ago)
      const reset = cooldownManager.getRateLimitReset("user1", 5, 10);
      expect(reset).toBe(8); // 10 - 2 = 8
    });
  });

  describe("clearRateLimit", () => {
    it("should clear rate limit for specific user", () => {
      cooldownManager.trackCommandExecution("user1", 10);
      cooldownManager.trackCommandExecution("user1", 10);

      cooldownManager.clearRateLimit("user1");

      const count = cooldownManager.getCommandCount("user1", 10);
      expect(count).toBe(0);
    });

    it("should not affect other users", () => {
      cooldownManager.trackCommandExecution("user1", 10);
      cooldownManager.trackCommandExecution("user2", 10);

      cooldownManager.clearRateLimit("user1");

      expect(cooldownManager.getCommandCount("user1", 10)).toBe(0);
      expect(cooldownManager.getCommandCount("user2", 10)).toBe(1);
    });

    it("should handle clearing non-existent rate limit gracefully", () => {
      expect(() => {
        cooldownManager.clearRateLimit("user1");
      }).not.toThrow();
    });
  });

  describe("clearAllRateLimits", () => {
    it("should clear all rate limits", () => {
      cooldownManager.trackCommandExecution("user1", 10);
      cooldownManager.trackCommandExecution("user2", 10);
      cooldownManager.trackCommandExecution("user3", 10);

      cooldownManager.clearAllRateLimits();

      expect(cooldownManager.getCommandCount("user1", 10)).toBe(0);
      expect(cooldownManager.getCommandCount("user2", 10)).toBe(0);
      expect(cooldownManager.getCommandCount("user3", 10)).toBe(0);
    });

    it("should work on empty rate limit manager", () => {
      expect(() => {
        cooldownManager.clearAllRateLimits();
      }).not.toThrow();
    });
  });

  describe("integration with existing cooldown functionality", () => {
    it("should not affect existing cooldown methods", () => {
      // Use rate limiting
      cooldownManager.trackCommandExecution("user1", 10);

      // Use regular cooldown
      cooldownManager.setCooldown("user1", "testcommand");

      // Both should work independently
      expect(cooldownManager.getCommandCount("user1", 10)).toBe(1);
      expect(cooldownManager.isOnCooldown("user1", "testcommand", 60)).toBe(
        true,
      );
    });

    it("should clear independently", () => {
      cooldownManager.trackCommandExecution("user1", 10);
      cooldownManager.setCooldown("user1", "testcommand");

      cooldownManager.clearRateLimit("user1");

      expect(cooldownManager.getCommandCount("user1", 10)).toBe(0);
      expect(cooldownManager.isOnCooldown("user1", "testcommand", 60)).toBe(
        true,
      );

      cooldownManager.clearCooldown("user1", "testcommand");

      expect(cooldownManager.isOnCooldown("user1", "testcommand", 60)).toBe(
        false,
      );
    });
  });
});
