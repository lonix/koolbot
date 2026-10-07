import { describe, it, expect } from "@jest/globals";
import {
  adoptUpdates,
  buildAdminFixDesired,
  detectDrift,
  driftSignature,
  findOutOfGroupAdministrators,
  moveKeepsAdministrator,
  resolvePolicy,
  roleNamesToTrack,
  type ScannedMember,
} from "../../src/services/role-group-sync.js";
import type { GroupSpec } from "../../src/services/role-group-plan.js";
import type {
  RoleState,
  ScannedState,
} from "../../src/services/server-adoption-planner.js";

const ADMIN = "8";

const group = (over: Partial<GroupSpec> & { id: string }): GroupSpec => ({
  name: over.id,
  roleId: null,
  rank: 1,
  permissions: null,
  capabilities: [],
  colour: null,
  createdByKoolbot: false,
  gateOnly: false,
  roleName: null,
  unlinked: false,
  syncPolicy: null,
  ...over,
});

const role = (id: string, position: number, over: Partial<RoleState> = {}) => ({
  id,
  name: `role-${id}`,
  color: 0,
  permissions: "0",
  position,
  managed: false,
  ...over,
});

const roles = [role("g", 0), role("r1", 2), role("r2", 5)];

describe("resolvePolicy", () => {
  it("prefers the group's own policy, then the global one, then flag", () => {
    expect(resolvePolicy({ syncPolicy: "enforce" }, "adopt")).toBe("enforce");
    expect(resolvePolicy({ syncPolicy: null }, "adopt")).toBe("adopt");
    expect(resolvePolicy({ syncPolicy: null }, "nonsense")).toBe("flag");
    expect(resolvePolicy({}, "")).toBe("flag");
  });
});

describe("detectDrift", () => {
  it("finds nothing when Discord matches, and ignores values the admin never set", () => {
    const groups = [
      group({ id: "a", roleId: "r1", rank: 1 }),
      group({ id: "b", roleId: "r2", rank: 2 }),
    ];
    expect(detectDrift(groups, roles, "g")).toEqual([]);
  });

  it("flags a changed permission set only when the group defines one", () => {
    const groups = [
      group({ id: "a", roleId: "r1", permissions: "1024" }),
      group({ id: "b", roleId: "r2", permissions: null, rank: 2 }),
    ];
    const live = [
      role("g", 0),
      role("r1", 2, { permissions: "2048" }),
      role("r2", 5, { permissions: "8" }),
    ];
    const items = detectDrift(groups, live, "g");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ groupId: "a", kind: "permissions" });
  });

  it("flags a rename against the tracked role name, not the group name", () => {
    const groups = [
      group({ id: "a", name: "Mods", roleId: "r1", roleName: "role-r1" }),
      group({ id: "b", name: "Other name", roleId: "r2", rank: 2 }),
    ];
    expect(detectDrift(groups, roles, "g")).toEqual([]);
    const renamed = [
      role("g", 0),
      role("r1", 2, { name: "Renamed" }),
      roles[2],
    ];
    expect(detectDrift(groups, renamed, "g")).toEqual([
      expect.objectContaining({ groupId: "a", kind: "name" }),
    ]);
  });

  it("flags a deleted role, also for a gate-only group", () => {
    const groups = [
      group({ id: "a", roleId: "gone" }),
      group({ id: "b", roleId: "gone2", gateOnly: true, rank: 2 }),
    ];
    expect(detectDrift(groups, roles, "g").map((d) => d.kind)).toEqual([
      "deleted",
      "deleted",
    ]);
  });

  it("ignores unlinked groups and groups waiting for a role", () => {
    const groups = [
      group({ id: "a", roleId: null, unlinked: true }),
      group({ id: "b", roleId: null, rank: 2 }),
    ];
    expect(detectDrift(groups, roles, "g")).toEqual([]);
  });

  it("never reports managed roles or gate-only groups for edits", () => {
    const groups = [
      group({ id: "a", roleId: "m", gateOnly: true, permissions: "1" }),
    ];
    const live = [role("g", 0), role("m", 3, { managed: true })];
    expect(detectDrift(groups, live, "g")).toEqual([]);
  });

  it("flags only a relative order violation, not absolute positions", () => {
    const groups = [
      group({ id: "low", roleId: "r1", rank: 1 }),
      group({ id: "high", roleId: "r2", rank: 2 }),
    ];
    // Both shifted by other roles being added: still in order.
    const shifted = [role("g", 0), role("r1", 7), role("r2", 12)];
    expect(detectDrift(groups, shifted, "g")).toEqual([]);
    const swapped = [role("g", 0), role("r1", 9), role("r2", 4)];
    expect(detectDrift(groups, swapped, "g")).toEqual([
      expect.objectContaining({ groupId: "high", kind: "position" }),
    ]);
  });

  it("flags an admin group whose role lacks Administrator", () => {
    const groups = [group({ id: "a", roleId: "r1", capabilities: ["admin"] })];
    expect(detectDrift(groups, roles, "g")).toEqual([
      expect.objectContaining({ kind: "admin-permission" }),
    ]);
    const ok = [role("g", 0), role("r1", 2, { permissions: ADMIN })];
    expect(detectDrift(groups, ok, "g")).toEqual([]);
  });

  it("reports a missing Administrator once, as its own flag, not as permission drift", () => {
    const groups = [
      group({
        id: "a",
        roleId: "r1",
        capabilities: ["admin"],
        permissions: ADMIN,
      }),
    ];
    const kinds = detectDrift(groups, roles, "g").map((d) => d.kind);
    expect(kinds).toEqual(["admin-permission"]);
  });

  it("leaves an accepted Administrator grant alone when the definition omits it", () => {
    const groups = [
      group({
        id: "a",
        roleId: "r1",
        capabilities: ["admin"],
        permissions: "1024",
      }),
    ];
    const granted = [
      role("g", 0),
      role("r1", 2, { permissions: "1032" }),
      roles[2],
    ];
    expect(detectDrift(groups, granted, "g")).toEqual([]);
    // Other permission changes still count.
    const changed = [
      role("g", 0),
      role("r1", 2, { permissions: "2056" }),
      roles[2],
    ];
    expect(detectDrift(groups, changed, "g").map((d) => d.kind)).toEqual([
      "permissions",
    ]);
  });
});

describe("driftSignature", () => {
  it("is null without drift and stable for the same drift", () => {
    expect(driftSignature([])).toBeNull();
    const a = {
      groupId: "a",
      groupName: "A",
      kind: "name" as const,
      detail: "x",
    };
    const b = { ...a, kind: "permissions" as const };
    expect(driftSignature([a, b])).toBe(driftSignature([b, a]));
    expect(driftSignature([a])).not.toBe(driftSignature([b]));
  });
});

describe("adoptUpdates", () => {
  it("copies permissions and the role name from Discord", () => {
    const groups = [
      group({ id: "a", roleId: "r1", permissions: "1", roleName: "old" }),
    ];
    const live = [
      role("g", 0),
      role("r1", 2, { permissions: "4", name: "new" }),
    ];
    const items = detectDrift(groups, live, "g");
    expect(adoptUpdates(groups, live, items, "g")).toEqual([
      { groupId: "a", set: { permissions: "4", roleName: "new" } },
    ]);
  });

  it("re-ranks the groups to Discord's order, keeping the rank values", () => {
    const groups = [
      group({ id: "low", roleId: "r1", rank: 1 }),
      group({ id: "high", roleId: "r2", rank: 5 }),
    ];
    const swapped = [role("g", 0), role("r1", 9), role("r2", 4)];
    const items = detectDrift(groups, swapped, "g");
    const updates = adoptUpdates(groups, swapped, items, "g");
    expect(updates).toEqual(
      expect.arrayContaining([
        { groupId: "low", set: { rank: 5 } },
        { groupId: "high", set: { rank: 1 } },
      ]),
    );
  });

  it("never adopts the admin-permission flag", () => {
    const groups = [group({ id: "a", roleId: "r1", capabilities: ["admin"] })];
    const items = detectDrift(groups, roles, "g");
    expect(adoptUpdates(groups, roles, items, "g")).toEqual([]);
  });
});

const member = (
  id: string,
  roleIds: string[],
  over: Partial<ScannedMember> = {},
): ScannedMember => ({ id, name: id, bot: false, roleIds, ...over });

describe("findOutOfGroupAdministrators", () => {
  const live = [
    role("g", 0),
    role("admins", 9, { permissions: ADMIN }),
    role("legacy", 8, { permissions: ADMIN }),
    role("mods", 4),
  ];
  const base = {
    roles: live,
    guildId: "g",
    ownerId: "owner",
    botUserId: "kool",
  };

  it("is null (skipped) when no admin group has a role", () => {
    expect(
      findOutOfGroupAdministrators({
        ...base,
        members: [member("u", ["legacy"])],
        adminGroupRoleIds: [],
      }),
    ).toBeNull();
  });

  it("lists humans outside the group and keeps bots apart, KoolBot marked", () => {
    const report = findOutOfGroupAdministrators({
      ...base,
      adminGroupRoleIds: ["admins"],
      members: [
        member("in", ["admins"]),
        member("owner", ["legacy"]),
        member("out", ["legacy", "mods"]),
        member("mod", ["mods"]),
        member("kool", ["legacy"], { bot: true }),
        member("other", ["legacy"], { bot: true }),
      ],
    });
    expect(report?.humans).toEqual([
      { id: "out", name: "out", viaRoleIds: ["legacy"] },
    ]);
    expect(report?.bots).toEqual([
      { id: "kool", name: "kool", viaRoleIds: ["legacy"], self: true },
      { id: "other", name: "other", viaRoleIds: ["legacy"] },
    ]);
  });

  it("does not count @everyone holding Administrator as a role for everyone", () => {
    const report = findOutOfGroupAdministrators({
      ...base,
      roles: [role("g", 0, { permissions: ADMIN }), ...live.slice(1)],
      adminGroupRoleIds: ["admins"],
      members: [member("u", ["mods"])],
    });
    expect(report?.humans).toEqual([]);
  });
});

describe("buildAdminFixDesired", () => {
  const scanned = (over: Partial<ScannedState> = {}): ScannedState => ({
    guildId: "g",
    ownerId: "owner",
    botUserId: "kool",
    botRoleIds: ["botrole"],
    botHighestRolePosition: 20,
    adminUserId: "me",
    adminRoleIds: ["admins"],
    otherBotIds: [],
    roles: [
      role("g", 0),
      role("admins", 9, { permissions: ADMIN }),
      role("legacy", 8, { permissions: "8200" }),
      role("managed", 7, { permissions: ADMIN, managed: true }),
      role("botrole", 20, { permissions: ADMIN }),
    ],
    channels: [],
    config: {},
    boundChannelIds: [],
    koolbotCreatedIds: [],
    ...over,
  });
  const report = {
    humans: [{ id: "u1", name: "u1", viaRoleIds: ["legacy"] }],
    bots: [],
  };

  it("grants the admin role to the chosen humans only", () => {
    const { desired, issues } = buildAdminFixDesired(
      { moveMemberIds: ["u1", "u1"], dropRoleIds: [] },
      report,
      ["admins"],
      scanned(),
    );
    expect(issues).toEqual([]);
    expect(desired.memberGrants).toEqual([
      { role: { id: "admins" }, memberIds: ["u1"] },
    ]);
    expect(desired.roles).toBeUndefined();
  });

  it("refuses members who aren't reported as out-of-group administrators", () => {
    const { desired, issues } = buildAdminFixDesired(
      { moveMemberIds: ["stranger"], dropRoleIds: [] },
      report,
      ["admins"],
      scanned(),
    );
    expect(issues[0]).toMatchObject({ code: "not-reported" });
    expect(desired.memberGrants).toBeUndefined();
  });

  it("drops only the Administrator bit and keeps the other permissions", () => {
    const { desired, issues } = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: ["legacy"] },
      report,
      ["admins"],
      scanned(),
    );
    expect(issues).toEqual([]);
    expect(desired.roles).toEqual([
      { id: "legacy", name: "role-legacy", permissions: "8192" },
    ]);
  });

  it("never drops Administrator from KoolBot's own role or a managed role", () => {
    const { desired, issues } = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: ["botrole", "managed"] },
      report,
      ["admins"],
      scanned(),
    );
    expect(issues.map((i) => i.code)).toEqual(["own-role", "role-protected"]);
    expect(desired.roles).toBeUndefined();
  });

  it("blocks a drop that would remove the invoking admin's own Administrator", () => {
    const lockout = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: ["legacy"] },
      report,
      ["admins"],
      scanned({ adminRoleIds: ["legacy"] }),
    );
    expect(lockout.issues.map((i) => i.code)).toContain("admin-lockout");
  });

  it("allows it when the admin keeps access through the group, as owner, or another role", () => {
    const viaGroup = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: ["legacy"] },
      report,
      ["admins"],
      scanned({ adminRoleIds: ["legacy", "admins"] }),
    );
    expect(viaGroup.issues).toEqual([]);
    const owner = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: ["legacy"] },
      report,
      ["admins"],
      scanned({ adminRoleIds: ["legacy"], adminUserId: "owner" }),
    );
    expect(owner.issues).toEqual([]);
  });

  it("reports a role that no longer exists", () => {
    const { issues } = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: ["nope"] },
      report,
      ["admins"],
      scanned(),
    );
    expect(issues[0]).toMatchObject({ code: "unknown-role" });
  });

  it("gives the admin group's role Administrator only when asked, keeping its other permissions", () => {
    const state = scanned({
      roles: [
        role("g", 0),
        role("admins", 9, { permissions: "1024" }),
        role("legacy", 8, { permissions: "8200" }),
        role("botrole", 20, { permissions: ADMIN }),
      ],
    });
    const none = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: [] },
      report,
      ["admins"],
      state,
    );
    expect(none.desired).toEqual({});
    const granted = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: [], grantAdministrator: true },
      report,
      ["admins"],
      state,
    );
    expect(granted.issues).toEqual([]);
    expect(granted.desired.roles).toEqual([
      { id: "admins", name: "role-admins", permissions: "1032" },
    ]);
    // Already carrying it: nothing to do.
    const again = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: [], grantAdministrator: true },
      report,
      ["admins"],
      scanned(),
    );
    expect(again.desired.roles).toBeUndefined();
  });

  it("does not count the admin group's role as keeping access until it carries Administrator", () => {
    const state = scanned({
      adminRoleIds: ["legacy", "admins"],
      roles: [
        role("g", 0),
        role("admins", 9, { permissions: "0" }),
        role("legacy", 8, { permissions: "8200" }),
        role("botrole", 20, { permissions: ADMIN }),
      ],
    });
    const lockout = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: ["legacy"] },
      report,
      ["admins"],
      state,
    );
    expect(lockout.issues.map((i) => i.code)).toContain("admin-lockout");
    const withGrant = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: ["legacy"], grantAdministrator: true },
      report,
      ["admins"],
      state,
    );
    expect(withGrant.issues).toEqual([]);
  });

  it("counts being moved into the admin group as keeping access", () => {
    const state = scanned({ adminRoleIds: ["legacy"], adminUserId: "u1" });
    const { issues } = buildAdminFixDesired(
      { moveMemberIds: ["u1"], dropRoleIds: ["legacy"] },
      report,
      ["admins"],
      state,
    );
    expect(issues).toEqual([]);
  });

  it("never drops Administrator from a role a bot holds it through", () => {
    const shared = {
      humans: [{ id: "u1", name: "u1", viaRoleIds: ["legacy"] }],
      bots: [{ id: "b1", name: "Music", viaRoleIds: ["legacy"] }],
    };
    const { desired, issues } = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: ["legacy"] },
      shared,
      ["admins"],
      scanned(),
    );
    expect(issues[0]).toMatchObject({ code: "bot-role" });
    expect(issues[0].message).toContain("Music");
    expect(desired.roles).toBeUndefined();
  });

  it("blocks a drop while another group defines Administrator for that role", () => {
    const definer = group({
      id: "vip",
      name: "Legacy admins",
      roleId: "legacy",
      permissions: "8200",
    });
    const blocked = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: ["legacy"] },
      report,
      ["admins"],
      scanned(),
      [definer],
    );
    expect(blocked.issues[0]).toMatchObject({
      code: "group-defines-administrator",
    });
    expect(blocked.desired.roles).toBeUndefined();
    // Once the group's definition omits it (or there is none), the drop is fine.
    for (const g of [
      group({ id: "vip", roleId: "legacy", permissions: "8192" }),
      group({ id: "vip", roleId: "legacy", permissions: null }),
    ]) {
      const ok = buildAdminFixDesired(
        { moveMemberIds: [], dropRoleIds: ["legacy"] },
        report,
        ["admins"],
        scanned(),
        [g],
      );
      expect(ok.issues).toEqual([]);
    }
  });

  it("only counts a move as keeping Administrator when the role has it or is granted it", () => {
    const withBit = [role("admins", 9, { permissions: ADMIN })];
    const without = [role("admins", 9, { permissions: "0" })];
    expect(moveKeepsAdministrator({}, ["admins"], withBit)).toBe(true);
    expect(moveKeepsAdministrator({}, ["admins"], without)).toBe(false);
    expect(
      moveKeepsAdministrator({ grantAdministrator: true }, ["admins"], without),
    ).toBe(true);
    expect(moveKeepsAdministrator({}, [], withBit)).toBe(false);
  });

  it("won't drop Administrator from the admin group's own role", () => {
    const { issues, desired } = buildAdminFixDesired(
      { moveMemberIds: [], dropRoleIds: ["admins"] },
      report,
      ["admins"],
      scanned(),
    );
    expect(issues[0]).toMatchObject({ code: "admin-group-role" });
    expect(desired.roles).toBeUndefined();
  });
});

describe("roleNamesToTrack", () => {
  it("starts tracking groups linked before name tracking, only once", () => {
    const live = [
      role("g", 0),
      role("r1", 2, { name: "Mods" }),
      role("r2", 3, { name: "Booster", managed: true }),
      role("r3", 4, { name: "Already" }),
    ];
    const groups = [
      group({ id: "a", roleId: "r1" }),
      group({ id: "b", roleId: "r2", gateOnly: true }),
      group({ id: "c", roleId: "r3", roleName: "Already" }),
      group({ id: "d", roleId: "gone" }),
      group({ id: "e", roleId: null, unlinked: true }),
    ];
    expect(roleNamesToTrack(groups, live, "g")).toEqual([
      { groupId: "a", roleName: "Mods" },
    ]);
  });

  it("makes a later rename show as drift once tracked", () => {
    const groups = [group({ id: "a", roleId: "r1" })];
    const before = [role("g", 0), role("r1", 2, { name: "Mods" })];
    expect(detectDrift(groups, before, "g")).toEqual([]);
    const tracked = roleNamesToTrack(groups, before, "g");
    const withName = [{ ...groups[0], roleName: tracked[0].roleName }];
    const after = [role("g", 0), role("r1", 2, { name: "Renamed" })];
    expect(detectDrift(withName, after, "g")).toEqual([
      expect.objectContaining({ kind: "name" }),
    ]);
  });
});
