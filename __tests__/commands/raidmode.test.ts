import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { PermissionFlagsBits } from "discord.js";

const mockGetStatus = jest.fn<() => Promise<unknown>>();
const mockSetLockdown =
  jest.fn<(g: unknown, on: boolean, id: string) => Promise<unknown>>();

jest.unstable_mockModule(
  "../../src/services/raid-protection-service.js",
  () => ({
    RaidProtectionService: {
      getInstance: jest.fn(() => ({
        getStatus: mockGetStatus,
        setLockdown: mockSetLockdown,
      })),
    },
  }),
);
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const { data, execute, buildStatusEmbed } =
  await import("../../src/commands/raidmode.js");

function interaction(
  mode: string,
  opts: { perms?: boolean; guild?: boolean } = {},
) {
  return {
    guildId: opts.guild === false ? null : "guild-1",
    guild: opts.guild === false ? null : { id: "guild-1" },
    client: {},
    user: { id: "mod-1" },
    memberPermissions: {
      has: (flag: bigint) =>
        (opts.perms ?? true) && flag === PermissionFlagsBits.ModerateMembers,
    },
    options: { getString: () => mode },
    deferReply: jest.fn(async () => undefined),
    reply: jest.fn(async () => undefined),
    editReply: jest.fn(async () => undefined),
  };
}

const status = {
  inactiveReason: null,
  lockdown: true,
  since: Date.now(),
  startedBy: null,
  dryRun: false,
  joinsInWindow: 4,
  joinThreshold: 3,
  windowSeconds: 30,
  lockdownAction: "timeout",
  minAccountAgeHours: 24,
  newAccountAction: "kick",
  actioned: 2,
  wouldAction: 0,
  skipped: 1,
  failed: 0,
};

describe("/raidmode", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("is hidden from members without Moderate Members", () => {
    expect(data.toJSON().default_member_permissions).toBe(
      PermissionFlagsBits.ModerateMembers.toString(),
    );
    expect(
      data.toJSON().options?.[0] &&
        "choices" in data.toJSON().options![0] &&
        (
          data.toJSON().options![0] as { choices: Array<{ value: string }> }
        ).choices.map((c) => c.value),
    ).toEqual(["on", "off", "status"]);
  });

  it("re-checks the permission itself and does nothing without it", async () => {
    const i = interaction("on", { perms: false });
    await execute(i as never);
    expect(i.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/Moderate Members/),
      }),
    );
    expect(mockSetLockdown).not.toHaveBeenCalled();
    expect(i.deferReply).not.toHaveBeenCalled();
  });

  it("refuses outside a server", async () => {
    const i = interaction("on", { guild: false });
    await execute(i as never);
    expect(mockSetLockdown).not.toHaveBeenCalled();
  });

  it.each([
    ["on", true],
    ["off", false],
  ])("passes %s to the service with the moderator id", async (mode, on) => {
    mockSetLockdown.mockResolvedValue({ changed: true, message: "done" });
    const i = interaction(mode);
    await execute(i as never);
    expect(i.deferReply).toHaveBeenCalled();
    expect(mockSetLockdown).toHaveBeenCalledWith(
      { id: "guild-1" },
      on,
      "mod-1",
    );
    expect(i.editReply).toHaveBeenCalledWith({ content: "done" });
  });

  it("shows status without changing anything", async () => {
    mockGetStatus.mockResolvedValue(status);
    const i = interaction("status");
    await execute(i as never);
    expect(mockSetLockdown).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith({
      embeds: [expect.anything()],
    });
  });

  it("explains why it is inactive in the status", () => {
    const text = JSON.stringify(
      buildStatusEmbed({
        ...status,
        lockdown: false,
        inactiveReason: "The Server Members Intent is off.",
      } as never).toJSON(),
    );
    expect(text).toContain("Inactive");
    expect(text).toContain("Server Members Intent");
  });

  it("reports a dry run clearly", () => {
    const text = JSON.stringify(
      buildStatusEmbed({ ...status, dryRun: true } as never).toJSON(),
    );
    expect(text).toContain("dry run");
  });
});
