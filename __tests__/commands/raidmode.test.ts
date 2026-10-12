import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { PermissionFlagsBits } from "discord.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RAID_ACTION_PERMISSIONS } from "../../src/utils/raid-actions.js";
import { settingsMetadata } from "../../src/services/config-schema.js";

const mockGetStatus = jest.fn<() => Promise<unknown>>();
const mockRequirement =
  jest.fn<() => Promise<{ action: string; label: string; flag: bigint }>>();
const mockSetLockdown =
  jest.fn<(g: unknown, on: boolean, id: string) => Promise<unknown>>();

jest.unstable_mockModule(
  "../../src/services/raid-protection-service.js",
  () => ({
    RaidProtectionService: {
      getInstance: jest.fn(() => ({
        getStatus: mockGetStatus,
        setLockdown: mockSetLockdown,
        getLockdownRequirement: mockRequirement,
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
  opts: { perms?: boolean | bigint[]; guild?: boolean } = {},
) {
  return {
    guildId: opts.guild === false ? null : "guild-1",
    guild: opts.guild === false ? null : { id: "guild-1" },
    client: {},
    user: { id: "mod-1" },
    memberPermissions: {
      has: (flag: bigint) => {
        const perms = opts.perms ?? true;
        if (Array.isArray(perms)) return perms.includes(flag);
        return perms && flag === PermissionFlagsBits.ModerateMembers;
      },
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
    mockRequirement.mockResolvedValue({
      action: "timeout",
      label: "Moderate Members",
      flag: PermissionFlagsBits.ModerateMembers,
    });
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

  describe("starting a lockdown needs the permission of the configured action", () => {
    const MOD = PermissionFlagsBits.ModerateMembers;
    it.each(
      Object.entries(RAID_ACTION_PERMISSIONS).map(
        ([action, { flag, label }]) => [action, flag, label] as const,
      ),
    )(
      "%s: refused without %s, allowed with it",
      async (action, flag, label) => {
        mockRequirement.mockResolvedValue({ action, label, flag });
        mockSetLockdown.mockResolvedValue({ changed: true, message: "done" });

        const without = interaction("on", { perms: [MOD] });
        await execute(without as never);
        if (flag === MOD) {
          expect(mockSetLockdown).toHaveBeenCalledTimes(1);
          mockSetLockdown.mockClear();
        } else {
          expect(mockSetLockdown).not.toHaveBeenCalled();
          expect(without.editReply).toHaveBeenCalledWith({
            content: expect.stringContaining(label),
          });
        }

        const withIt = interaction("on", { perms: [MOD, flag] });
        await execute(withIt as never);
        expect(mockSetLockdown).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["off", "status"])(
      "%s stays with Moderate Members",
      async (mode) => {
        mockRequirement.mockResolvedValue({
          action: "kick",
          label: "Kick Members",
          flag: PermissionFlagsBits.KickMembers,
        });
        mockSetLockdown.mockResolvedValue({ changed: true, message: "done" });
        mockGetStatus.mockResolvedValue(status);
        await execute(interaction(mode) as never);
        expect(mockRequirement).not.toHaveBeenCalled();
        expect(
          mode === "off" ? mockSetLockdown : mockGetStatus,
        ).toHaveBeenCalled();
      },
    );

    it("lists every action's permission in COMMANDS.md and the setting text", () => {
      const docs = readFileSync(
        fileURLToPath(new URL("../../COMMANDS.md", import.meta.url)),
        "utf8",
      );
      const setting =
        settingsMetadata["moderation.raid.lockdown_action"].description;
      for (const [action, { label }] of Object.entries(
        RAID_ACTION_PERMISSIONS,
      )) {
        expect(docs).toContain(`\`${action}\``);
        expect(docs).toContain(label);
        expect(setting).toContain(`${action}: ${label}`);
      }
    });
  });
});
