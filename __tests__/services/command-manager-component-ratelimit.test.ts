import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { CommandManager } from "../../src/services/command-manager.js";
import { PermissionsService } from "../../src/services/permissions-service.js";
import { resetMemberCooldowns } from "../../src/utils/member-cooldown.js";

jest.mock("../../src/services/config-service.js");
jest.mock("../../src/services/monitoring-service.js");
jest.mock("../../src/services/permissions-service.js");
jest.mock("../../src/utils/logger.js");

const settings: Record<string, boolean | number> = {};

function manager(): CommandManager {
  CommandManager.reset();
  PermissionsService.reset();
  const instance = CommandManager.getInstance({
    user: { id: "bot" },
    application: { id: "app" },
  } as never);
  (instance as never)["configService"] = {
    getBoolean: jest.fn(async (key: string) => settings[key] as boolean),
    getNumber: jest.fn(async (key: string) => settings[key] as number),
  };
  return instance;
}

const member = (id: string, admin = false) => ({
  user: { id },
  memberPermissions: { has: () => admin },
});

describe("CommandManager.componentRateLimitWait (#1147)", () => {
  beforeEach(() => {
    resetMemberCooldowns();
    Object.assign(settings, {
      "ratelimit.enabled": true,
      "ratelimit.bypass_admin": true,
      "ratelimit.max_components": 3,
      "ratelimit.window_seconds": 10,
    });
  });

  it("never limits while rate limiting is off (the default)", async () => {
    settings["ratelimit.enabled"] = false;
    const m = manager();
    for (let i = 0; i < 50; i++) {
      expect(await m.componentRateLimitWait(member("u1"))).toBe(0);
    }
  });

  it("limits a member's clicks per window once enabled", async () => {
    const m = manager();
    for (let i = 0; i < 3; i++) {
      expect(await m.componentRateLimitWait(member("u1"))).toBe(0);
    }
    expect(await m.componentRateLimitWait(member("u1"))).toBeGreaterThan(0);
    // Another member is unaffected.
    expect(await m.componentRateLimitWait(member("u2"))).toBe(0);
  });

  it("lets administrators bypass, unless bypass is off", async () => {
    const m = manager();
    for (let i = 0; i < 10; i++) {
      expect(await m.componentRateLimitWait(member("boss", true))).toBe(0);
    }
    settings["ratelimit.bypass_admin"] = false;
    for (let i = 0; i < 3; i++) {
      await m.componentRateLimitWait(member("boss", true));
    }
    expect(
      await m.componentRateLimitWait(member("boss", true)),
    ).toBeGreaterThan(0);
  });

  describe("refuseIfComponentRateLimited", () => {
    const interactionFor = (id: string, reply: jest.Mock) => ({
      ...member(id),
      reply,
    });

    it("lets an in-limit interaction through without replying", async () => {
      const reply = jest.fn(async () => undefined);
      const m = manager();
      expect(
        await m.refuseIfComponentRateLimited(interactionFor("u1", reply)),
      ).toBe(false);
      expect(reply).not.toHaveBeenCalled();
    });

    it("refuses an over-limit interaction with an ephemeral notice", async () => {
      const reply = jest.fn(async () => undefined);
      const m = manager();
      for (let i = 0; i < 3; i++) {
        await m.componentRateLimitWait(member("u1"));
      }
      expect(
        await m.refuseIfComponentRateLimited(interactionFor("u1", reply)),
      ).toBe(true);
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("too quickly"),
        }),
      );
    });

    it("still refuses when the notice cannot be delivered, so the handler never runs", async () => {
      const reply = jest.fn(async () => {
        throw new Error("Unknown interaction");
      });
      const m = manager();
      for (let i = 0; i < 3; i++) {
        await m.componentRateLimitWait(member("u1"));
      }
      await expect(
        m.refuseIfComponentRateLimited(interactionFor("u1", reply)),
      ).resolves.toBe(true);
    });

    it("fails open only when the limiter itself breaks", async () => {
      const m = manager();
      (m as never)["configService"] = {
        getBoolean: jest.fn(async () => {
          throw new Error("config down");
        }),
        getNumber: jest.fn(),
      };
      const reply = jest.fn(async () => undefined);
      expect(
        await m.refuseIfComponentRateLimited(interactionFor("u1", reply)),
      ).toBe(false);
    });
  });
});
