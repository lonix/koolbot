import { describe, it, expect } from "@jest/globals";
import { PermissionsBitField } from "discord.js";
import {
  buildDesiredState,
  formatColour,
  isValidPermissions,
  parseColour,
  PERMISSION_PRESETS,
  roleLockReason,
  validateGroupInput,
  type GroupSpec,
} from "../../src/services/role-group-plan.js";
import type { ScannedState } from "../../src/services/server-adoption-planner.js";

const group = (over: Partial<GroupSpec> & { id: string }): GroupSpec => ({
  name: over.id,
  roleId: null,
  rank: 1,
  permissions: null,
  capabilities: [],
  colour: null,
  createdByKoolbot: false,
  gateOnly: false,
  ...over,
});

const role = (id: string, position: number, over = {}) => ({
  id,
  name: `role-${id}`,
  color: 0,
  permissions: "0",
  position,
  managed: false,
  ...over,
});

const scan = (over: Partial<ScannedState> = {}): ScannedState => ({
  guildId: "g",
  ownerId: "owner",
  botUserId: "kool",
  botRoleIds: ["botrole"],
  botHighestRolePosition: 20,
  adminUserId: "admin",
  adminRoleIds: [],
  otherBotIds: [],
  roles: [role("g", 0)],
  channels: [],
  config: {},
  boundChannelIds: [],
  koolbotCreatedIds: [],
  ...over,
});

describe("validateGroupInput", () => {
  it("accepts a plain group", () => {
    expect(validateGroupInput({ name: "VIP" }, [])).toBeNull();
  });

  it("rejects empty, over-long and duplicate names (case-insensitive)", () => {
    expect(validateGroupInput({ name: "  " }, [])).toMatch(/needs a name/);
    expect(validateGroupInput({ name: "x".repeat(101) }, [])).toMatch(/100/);
    expect(validateGroupInput({ name: "vip" }, [{ name: "VIP" }])).toMatch(
      /already exists/,
    );
  });

  it("rejects bad permissions, capabilities and colours", () => {
    expect(validateGroupInput({ name: "a", permissions: "abc" }, [])).toMatch(
      /bitfield/,
    );
    expect(
      validateGroupInput({ name: "a", capabilities: ["owner"] }, []),
    ).toMatch(/Unknown capability/);
    expect(validateGroupInput({ name: "a", colour: 0x1000000 }, [])).toMatch(
      /Colour/,
    );
    expect(validateGroupInput({ name: "a", rank: -1 }, [])).toMatch(/Rank/);
  });

  it("keeps humans out of bot groups and capabilities off gate-only groups", () => {
    expect(
      validateGroupInput({ name: "a", capabilities: ["bot", "staff"] }, []),
    ).toMatch(/bot capability/);
    expect(
      validateGroupInput(
        { name: "a", capabilities: ["staff"], gateOnly: true },
        [],
      ),
    ).toMatch(/gate-only/);
  });
});

describe("helpers", () => {
  it("parses and formats colours", () => {
    expect(parseColour("#A95F55")).toBe(0xa95f55);
    expect(parseColour("")).toBeNull();
    expect(parseColour("red")).toBeUndefined();
    expect(formatColour(0xa95f55)).toBe("#a95f55");
    expect(formatColour(null)).toBe("");
  });

  it("validates bitfields", () => {
    expect(isValidPermissions("8")).toBe(true);
    expect(isValidPermissions("-1")).toBe(false);
    expect(isValidPermissions((PermissionsBitField.All + 1n).toString())).toBe(
      false,
    );
  });

  it("ships valid presets; the VIP preset is cosmetic only", () => {
    for (const p of PERMISSION_PRESETS) {
      expect(isValidPermissions(p.permissions)).toBe(true);
    }
    expect(PERMISSION_PRESETS.find((p) => p.key === "vip")?.permissions).toBe(
      "0",
    );
    const mod = BigInt(
      PERMISSION_PRESETS.find((p) => p.key === "moderator")?.permissions ?? "0",
    );
    expect(mod & PermissionsBitField.Flags.ModerateMembers).not.toBe(0n);
    expect(mod & PermissionsBitField.Flags.Administrator).toBe(0n);
  });

  it("classifies locked roles", () => {
    expect(roleLockReason(role("g", 0), "g", 20)).toBe("everyone");
    expect(roleLockReason(role("a", 5, { managed: true }), "g", 20)).toBe(
      "managed",
    );
    expect(roleLockReason(role("b", 20), "g", 20)).toBe("hierarchy");
    expect(roleLockReason(role("c", 5), "g", 20)).toBeNull();
  });
});

describe("buildDesiredState", () => {
  it("plans no change for a linked role with nothing set", () => {
    const { desired, issues } = buildDesiredState(
      [group({ id: "a", roleId: "r1", rank: 1 })],
      scan({ roles: [role("g", 0), role("r1", 3)] }),
    );
    expect(desired.roles).toEqual([]);
    expect(issues).toEqual([]);
  });

  it("only edits what the admin set, and never members", () => {
    const { desired } = buildDesiredState(
      [group({ id: "a", roleId: "r1", permissions: "8", colour: 0xff0000 })],
      scan({ roles: [role("g", 0), role("r1", 3)] }),
    );
    expect(desired.roles).toEqual([
      { id: "r1", name: "role-r1", permissions: "8", color: 0xff0000 },
    ]);
    expect(desired.memberGrants).toBeUndefined();
  });

  it("creates a role for a group without one, above the group below it", () => {
    const { desired } = buildDesiredState(
      [
        group({ id: "mod", name: "Mod", roleId: "r1", rank: 1 }),
        group({ id: "admin", name: "Admin", rank: 2, permissions: "8" }),
      ],
      scan({ roles: [role("g", 0), role("r1", 3)] }),
    );
    expect(desired.roles).toEqual([
      { name: "Admin", permissions: "8", position: 4 },
    ]);
  });

  it("repositions a role that is out of rank order", () => {
    const { desired } = buildDesiredState(
      [
        group({ id: "low", roleId: "r1", rank: 1 }),
        group({ id: "high", roleId: "r2", rank: 2 }),
      ],
      scan({ roles: [role("g", 0), role("r1", 5), role("r2", 2)] }),
    );
    expect(desired.roles).toEqual([{ id: "r2", name: "role-r2", position: 6 }]);
  });

  it("reports groups that do not fit under the bot's role", () => {
    const { issues } = buildDesiredState(
      [group({ id: "a", rank: 1 }), group({ id: "b", rank: 2 })],
      scan({ botHighestRolePosition: 2 }),
    );
    expect(issues.map((i) => i.code)).toContain("groups-do-not-fit");
  });

  it("flags a group whose role vanished from Discord", () => {
    const { issues, desired } = buildDesiredState(
      [group({ id: "a", roleId: "gone" })],
      scan(),
    );
    expect(issues[0]).toMatchObject({ code: "group-role-missing" });
    expect(desired.roles).toEqual([]);
  });

  it("never edits or creates gate-only (managed) groups", () => {
    const { desired } = buildDesiredState(
      [
        group({
          id: "boost",
          roleId: "r9",
          gateOnly: true,
          permissions: "8",
          colour: 1,
        }),
      ],
      scan({ roles: [role("g", 0), role("r9", 3, { managed: true })] }),
    );
    expect(desired.roles).toEqual([]);
  });

  it("plans adding only the bots that lack a bot group's role", () => {
    const { desired } = buildDesiredState(
      [group({ id: "bots", roleId: "rb", capabilities: ["bot"] })],
      scan({
        roles: [role("g", 0), role("rb", 3)],
        otherBotIds: ["b1", "b2"],
        memberRoles: { b1: ["rb"], b2: [] },
      }),
    );
    expect(desired.memberGrants).toEqual([
      { role: { id: "rb" }, memberIds: ["b2"] },
    ]);
  });

  it("skips an unlinked group instead of recreating its role (#1021)", () => {
    const { desired, issues } = buildDesiredState(
      [
        group({ id: "gone", roleId: null, unlinked: true, permissions: "8" }),
        group({ id: "new", roleId: null, rank: 2 }),
      ],
      scan(),
    );
    expect(issues).toEqual([]);
    expect(desired.roles?.map((r) => r.name)).toEqual(["new"]);
  });

  it("restores a tracked role name that was changed in Discord (#1021)", () => {
    const { desired } = buildDesiredState(
      [group({ id: "a", roleId: "r1", roleName: "Mods" })],
      scan({ roles: [role("g", 0), role("r1", 3, { name: "Renamed" })] }),
    );
    expect(desired.roles).toEqual([{ id: "r1", name: "Mods" }]);
  });

  it("leaves a role's name alone when none is tracked", () => {
    const { desired } = buildDesiredState(
      [group({ id: "a", roleId: "r1" })],
      scan({ roles: [role("g", 0), role("r1", 3, { name: "Renamed" })] }),
    );
    expect(desired.roles).toEqual([]);
  });

  it("never adds Administrator to an admin group's role on its own (#1021)", () => {
    const { desired, issues } = buildDesiredState(
      [group({ id: "a", roleId: "r1", capabilities: ["admin"] })],
      scan({ roles: [role("g", 0), role("r1", 3)] }),
    );
    expect(issues).toEqual([]);
    expect(desired.roles).toEqual([]);
  });
});
