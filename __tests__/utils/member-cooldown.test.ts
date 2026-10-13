import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import {
  clearMemberCooldown,
  consumeBurst,
  cooldownRemaining,
  reserveBurst,
  resetMemberCooldowns,
  startCooldown,
  waitText,
} from "../../src/utils/member-cooldown.js";

describe("member cooldown helper", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetMemberCooldowns();
  });
  afterEach(() => {
    resetMemberCooldowns();
    jest.useRealTimers();
  });

  describe("cooldownRemaining / startCooldown", () => {
    it("is 0 until a cooldown starts, then counts down and expires", () => {
      expect(cooldownRemaining("a", "u1", 60)).toBe(0);
      startCooldown("a", "u1", 60);
      expect(cooldownRemaining("a", "u1", 60)).toBe(60);
      jest.advanceTimersByTime(45_000);
      expect(cooldownRemaining("a", "u1", 60)).toBe(15);
      jest.advanceTimersByTime(15_000);
      expect(cooldownRemaining("a", "u1", 60)).toBe(0);
    });

    it("keeps scopes and members apart", () => {
      startCooldown("a", "u1", 60);
      expect(cooldownRemaining("b", "u1", 60)).toBe(0);
      expect(cooldownRemaining("a", "u2", 60)).toBe(0);
    });

    it("ignores the cooldown when the setting is 0 or negative", () => {
      startCooldown("a", "u1", 60);
      expect(cooldownRemaining("a", "u1", 0)).toBe(0);
      expect(cooldownRemaining("a", "u1", -5)).toBe(0);
    });

    it("records nothing when the configured duration is 0 or negative", () => {
      startCooldown("a", "u1", 0);
      startCooldown("a", "u2", -1);
      // Enabling the limit afterwards must not limit what happened while off.
      expect(cooldownRemaining("a", "u1", 60)).toBe(0);
      expect(cooldownRemaining("a", "u2", 60)).toBe(0);
    });

    it("can be cleared", () => {
      startCooldown("a", "u1", 60);
      clearMemberCooldown("a", "u1");
      expect(cooldownRemaining("a", "u1", 60)).toBe(0);
    });
  });

  describe("consumeBurst", () => {
    it("allows max actions per window, then reports the wait", () => {
      expect(consumeBurst("s", "u1", 3, 30)).toBe(0);
      expect(consumeBurst("s", "u1", 3, 30)).toBe(0);
      expect(consumeBurst("s", "u1", 3, 30)).toBe(0);
      expect(consumeBurst("s", "u1", 3, 30)).toBe(30);
      jest.advanceTimersByTime(10_000);
      expect(consumeBurst("s", "u1", 3, 30)).toBe(20);
    });

    it("frees the budget once the window has passed", () => {
      for (let i = 0; i < 3; i++) consumeBurst("s", "u1", 3, 30);
      jest.advanceTimersByTime(30_001);
      expect(consumeBurst("s", "u1", 3, 30)).toBe(0);
    });

    it("does not count refused attempts against the member", () => {
      for (let i = 0; i < 3; i++) consumeBurst("s", "u1", 3, 30);
      for (let i = 0; i < 50; i++) consumeBurst("s", "u1", 3, 30);
      jest.advanceTimersByTime(30_001);
      expect(consumeBurst("s", "u1", 3, 30)).toBe(0);
    });

    it("keeps scopes and members apart", () => {
      for (let i = 0; i < 3; i++) consumeBurst("s", "u1", 3, 30);
      expect(consumeBurst("other", "u1", 3, 30)).toBe(0);
      expect(consumeBurst("s", "u2", 3, 30)).toBe(0);
    });

    it("is off when max or window is 0", () => {
      for (let i = 0; i < 100; i++) {
        expect(consumeBurst("s", "u1", 0, 30)).toBe(0);
        expect(consumeBurst("s", "u1", 3, 0)).toBe(0);
      }
    });
  });

  describe("reserveBurst", () => {
    it("takes the slot up front so concurrent attempts see it", () => {
      expect(reserveBurst("s", "u1", 1, 30).wait).toBe(0);
      expect(reserveBurst("s", "u1", 1, 30).wait).toBe(30);
    });

    it("gives back exactly the released slot, once", () => {
      const first = reserveBurst("s", "u1", 2, 30);
      const second = reserveBurst("s", "u1", 2, 30);
      expect(reserveBurst("s", "u1", 2, 30).wait).toBeGreaterThan(0);
      first.release();
      first.release(); // a second release must not free another slot
      expect(reserveBurst("s", "u1", 2, 30).wait).toBe(0);
      expect(reserveBurst("s", "u1", 2, 30).wait).toBeGreaterThan(0);
      second.release();
    });

    it("is off when max or window is 0", () => {
      expect(reserveBurst("s", "u1", 0, 30).wait).toBe(0);
      expect(reserveBurst("s", "u1", 3, 0).wait).toBe(0);
    });
  });

  describe("waitText", () => {
    it("reads naturally in seconds and minutes", () => {
      expect(waitText(1)).toBe("1 second");
      expect(waitText(45)).toBe("45 seconds");
      expect(waitText(119)).toBe("119 seconds");
      expect(waitText(300)).toBe("5 minutes");
      expect(waitText(121)).toBe("3 minutes");
    });
  });
});
