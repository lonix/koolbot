/**
 * `checkCommandPermission({ fresh: true })` (#1151): web sessions must see a
 * kicked, banned or demoted member even when the bot never receives member
 * events (GuildMembers intent off), without a REST call on every request.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { GatewayIntentBits } from "discord.js";
import {
  PermissionsService,
  PermissionCheckError,
} from "../../src/services/permissions-service.js";
import { CommandPermission } from "../../src/models/command-permissions.js";

jest.mock("../../src/services/config-service.js");
jest.mock("../../src/models/command-permissions.js");
jest.mock("../../src/utils/logger.js");

function memberStub(): unknown {
  return {
    id: "user1",
    permissions: { has: jest.fn().mockReturnValue(false) },
    roles: { cache: new Map() },
  };
}

function build(opts: { membersIntent: boolean; fetch: jest.Mock }): {
  service: PermissionsService;
  fetch: jest.Mock;
} {
  const client = {
    options: {
      intents: {
        has: (bit: number): boolean =>
          opts.membersIntent && bit === GatewayIntentBits.GuildMembers,
      },
    },
    guilds: {
      fetch: jest.fn().mockResolvedValue({ members: { fetch: opts.fetch } }),
    },
  };
  (PermissionsService as unknown as { instance: unknown }).instance = undefined;
  const service = PermissionsService.getInstance(client as never);
  (service as never)["configService"] = {
    getString: jest.fn().mockResolvedValue("guild1"),
  };
  (CommandPermission.find as jest.Mock) = jest.fn().mockResolvedValue([]);
  return { service, fetch: opts.fetch };
}

describe("checkCommandPermission fresh option (#1151)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps the cached lookup by default", async () => {
    const { service, fetch } = build({
      membersIntent: false,
      fetch: jest.fn().mockResolvedValue(memberStub()),
    });
    await service.checkCommandPermission("user1", "guild1", "me");
    expect(fetch).toHaveBeenCalledWith("user1");
  });

  it("forces a live member read when the GuildMembers intent is off", async () => {
    const { service, fetch } = build({
      membersIntent: false,
      fetch: jest.fn().mockResolvedValue(memberStub()),
    });
    await expect(
      service.checkCommandPermission("user1", "guild1", "me", { fresh: true }),
    ).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith({ user: "user1", force: true });
  });

  it("reuses the live read for a short window instead of hitting Discord every request", async () => {
    const { service, fetch } = build({
      membersIntent: false,
      fetch: jest.fn().mockResolvedValue(memberStub()),
    });
    for (let i = 0; i < 5; i += 1) {
      await service.checkCommandPermission("user1", "guild1", "me", {
        fresh: true,
      });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("denies a member Discord no longer knows (kicked or banned)", async () => {
    const { service } = build({
      membersIntent: false,
      fetch: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Unknown Member"), { code: 10007 }),
        ),
    });
    await expect(
      service.checkCommandPermission("user1", "guild1", "me", {
        fresh: true,
        onUnavailable: "throw",
      }),
    ).resolves.toBe(false);
  });

  it("fails safe, not open, when the live read fails", async () => {
    const { service } = build({
      membersIntent: false,
      fetch: jest.fn().mockRejectedValue(new Error("503 from Discord")),
    });
    await expect(
      service.checkCommandPermission("user1", "guild1", "me", {
        fresh: true,
        onUnavailable: "throw",
      }),
    ).rejects.toBeInstanceOf(PermissionCheckError);
    await expect(
      service.checkCommandPermission("user1", "guild1", "me", { fresh: true }),
    ).resolves.toBe(false);
  });

  it("does not force a REST read when the gateway keeps the cache current", async () => {
    const { service, fetch } = build({
      membersIntent: true,
      fetch: jest.fn().mockResolvedValue(memberStub()),
    });
    await service.checkCommandPermission("user1", "guild1", "me", {
      fresh: true,
    });
    expect(fetch).toHaveBeenCalledWith("user1");
  });
});
