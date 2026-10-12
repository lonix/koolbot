import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { PermissionFlagsBits } from "discord.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RAID_ACTION_PERMISSIONS } from "../../src/utils/raid-actions.js";
import { settingsMetadata } from "../../src/services/config-schema.js";

const mockGetStatus = jest.fn<() => Promise<unknown>>();
type Requirement = { action: string; label: string; flag: bigint };
let requirement: Requirement = {
  action: "timeout",
  label: "Moderate Members",
  flag: PermissionFlagsBits.ModerateMembers,
};
const mockSetLockdown =
  jest.fn<
    (
      g: unknown,
      on: boolean,
      id: string,
      authorize?: (r: Requirement) => string | null,
    ) => Promise<unknown>
  >();

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
  counts: { actioned: 2, wouldAction: 0, skipped: 1, failed: 0 },
  gateCounts: { actioned: 7, wouldAction: 0, skipped: 0, failed: 0 },
  unrecorded: 0,
};

describe("/raidmode", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requirement = {
      action: "timeout",
      label: "Moderate Members",
      flag: PermissionFlagsBits.ModerateMembers,
    };
    // Behaves like the service: authorises against the settings snapshot it
    // holds (`requirement`) before starting, but never for `off`.
    mockSetLockdown.mockImplementation(async (_g, on, _id, authorize) => {
      const refusal = on ? (authorize?.(requirement) ?? null) : null;
      return refusal
        ? { changed: false, message: refusal }
        : { changed: true, message: "done" };
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
    const i = interaction(mode);
    await execute(i as never);
    expect(i.deferReply).toHaveBeenCalled();
    expect(mockSetLockdown).toHaveBeenCalledWith(
      { id: "guild-1" },
      on,
      "mod-1",
      expect.any(Function),
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
        requirement = { action, label, flag };

        const without = interaction("on", { perms: [MOD] });
        await execute(without as never);
        if (flag === MOD) {
          expect(without.editReply).toHaveBeenCalledWith({ content: "done" });
        } else {
          expect(without.editReply).toHaveBeenCalledWith({
            content: expect.stringContaining(label),
          });
        }

        const withIt = interaction("on", { perms: [MOD, flag] });
        await execute(withIt as never);
        expect(withIt.editReply).toHaveBeenCalledWith({ content: "done" });
      },
    );

    it("checks the snapshot the service started with, not a separate earlier read", async () => {
      // The permission check is passed into setLockdown, so a settings change
      // between "check" and "start" cannot widen the action.
      requirement = {
        action: "kick",
        label: "Kick Members",
        flag: PermissionFlagsBits.KickMembers,
      };
      const i = interaction("on", {
        perms: [PermissionFlagsBits.ModerateMembers],
      });
      await execute(i as never);
      expect(i.editReply).toHaveBeenCalledWith({
        content: expect.stringContaining("Kick Members"),
      });
    });

    it.each(["off", "status"])(
      "%s stays with Moderate Members",
      async (mode) => {
        requirement = {
          action: "kick",
          label: "Kick Members",
          flag: PermissionFlagsBits.KickMembers,
        };
        mockGetStatus.mockResolvedValue(status);
        const i = interaction(mode);
        await execute(i as never);
        if (mode === "off") {
          expect(i.editReply).toHaveBeenCalledWith({ content: "done" });
        } else {
          expect(mockGetStatus).toHaveBeenCalled();
        }
      },
    );

    it("lists every action's permission in COMMANDS.md and the setting text", () => {
      const docs = readFileSync(
        fileURLToPath(new URL("../../COMMANDS.md", import.meta.url)),
        "utf8",
      );
      const setting =
        settingsMetadata["moderation.raid.lockdown_action"].description;
      // The requirement covers the stronger new-account action too (#1045).
      expect(docs).toMatch(/new-account\s+action/);
      expect(setting).toContain("new-account action");
      for (const [action, { label }] of Object.entries(
        RAID_ACTION_PERMISSIONS,
      )) {
        expect(docs).toContain(`\`${action}\``);
        expect(docs).toContain(label);
        expect(setting).toContain(`${action}: ${label}`);
      }
    });
  });

  it("labels lockdown and gate counters separately and flags unwritten rows", () => {
    const text = JSON.stringify(
      buildStatusEmbed({
        ...status,
        lockdown: false,
        unrecorded: 2,
      } as never).toJSON(),
    );
    expect(text).toContain("This lockdown so far:** 2 acted on");
    expect(text).toContain(
      "New-account gate since the bot started:** 7 acted on",
    );
    expect(text).toContain("2 log row(s) could not be written");
  });
});
