import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import type { Client, Guild, Role } from "discord.js";

const settings: Record<string, string | boolean> = {};
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({
      getString: jest.fn(async (k: string, d: string) =>
        typeof settings[k] === "string" ? settings[k] : d,
      ),
      getBoolean: jest.fn(async (k: string, d: boolean) =>
        typeof settings[k] === "boolean" ? settings[k] : d,
      ),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

const mockList = jest.fn<(...a: any[]) => Promise<any[]>>();
const mockMarkUnlinked = jest.fn<(...a: any[]) => Promise<boolean>>();
const mockRecreate = jest.fn<(...a: any[]) => Promise<boolean>>();
const mockAdopted = jest.fn<(...a: any[]) => Promise<void>>();
const mockSetPolicy = jest.fn<(...a: any[]) => Promise<void>>();
const mockSetSig = jest.fn<(...a: any[]) => Promise<void>>();
const mockScan = jest.fn<(...a: any[]) => Promise<any>>();
const mockTrack = jest.fn<(...a: any[]) => Promise<void>>();
jest.unstable_mockModule("../../src/services/role-group-service.js", () => ({
  RoleGroupService: {
    getInstance: () => ({
      list: mockList,
      markUnlinked: mockMarkUnlinked,
      requestRecreate: mockRecreate,
      applyAdopted: mockAdopted,
      setSyncPolicy: mockSetPolicy,
      setDriftSignature: mockSetSig,
      trackRoleNames: mockTrack,
    }),
  },
  scanGuildRoles: mockScan,
}));
const mockLinkCreated = jest.fn<(...a: any[]) => Promise<number>>();
const { roleNamesToTrack } =
  await import("../../src/services/role-group-sync.js");
jest.unstable_mockModule("../../src/services/role-group-adoption.js", () => ({
  linkCreatedRoles: mockLinkCreated,
  // Same behaviour as the real helper, over the mocked group service.
  trackNames: async (
    guildId: string,
    groups: Array<Record<string, unknown>>,
    roles: unknown[],
  ) => {
    const track = roleNamesToTrack(groups as never, roles as never, guildId);
    if (track.length === 0) return groups;
    await mockTrack(guildId, track);
    const names = new Map(track.map((t) => [t.groupId, t.roleName]));
    return groups.map((g) =>
      names.has(g.id as string)
        ? { ...g, roleName: names.get(g.id as string) }
        : g,
    );
  },
}));
const mockAudit = jest.fn<(...a: any[]) => Promise<void>>();
jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockAudit,
}));
const mockActive = jest.fn<(...a: any[]) => Promise<unknown>>();
jest.unstable_mockModule("../../src/models/adoption-snapshot.js", () => ({
  AdoptionSnapshot: { exists: mockActive },
  ADOPTION_STALE_AFTER_MS: 30 * 60 * 1000,
}));
const mockLog = jest.fn<(...a: any[]) => Promise<boolean>>();
jest.unstable_mockModule("../../src/services/discord-logger.js", () => ({
  DiscordLogger: { getInstance: () => ({ logToChannel: mockLog }) },
}));
const mockStartApply = jest.fn<(...a: any[]) => any>();
jest.unstable_mockModule(
  "../../src/services/server-adoption-service.js",
  () => ({
    BUSY_MESSAGE: "busy",
    ServerAdoptionService: {
      getInstance: async () => ({ startApply: mockStartApply }),
    },
  }),
);
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { RoleGroupSyncService } =
  await import("../../src/services/role-group-sync-service.js");

const liveRole = (
  id: string,
  position: number,
  over: Record<string, unknown> = {},
) => ({
  id,
  name: `role-${id}`,
  color: 0,
  position,
  managed: false,
  permissions: { bitfield: 0n },
  ...over,
});
const stateRole = (
  id: string,
  position: number,
  over: Record<string, unknown> = {},
) => ({
  id,
  name: `role-${id}`,
  color: 0,
  permissions: "0",
  position,
  managed: false,
  ...over,
});

const grp = (over: Record<string, unknown> = {}) => ({
  id: "g1",
  name: "Mods",
  roleId: "r1",
  rank: 1,
  permissions: null,
  capabilities: [],
  colour: null,
  createdByKoolbot: false,
  gateOnly: false,
  hoist: false,
  roleName: null,
  unlinked: false,
  lostRoleId: null,
  recreateRequestedAt: null,
  syncPolicy: null,
  driftSignature: null,
  createdAt: new Date(),
  ...over,
});

let liveRoles: ReturnType<typeof liveRole>[];
const guild = (): Guild =>
  ({
    id: "g",
    roles: {
      fetch: jest.fn(async () => new Map(liveRoles.map((r) => [r.id, r]))),
    },
  }) as unknown as Guild;

const client = (g: Guild | null = guild()): Client =>
  ({
    user: { id: "kool" },
    guilds: { fetch: jest.fn(async () => g ?? Promise.reject(new Error("x"))) },
  }) as unknown as Client;

const scanFor = (roles: ReturnType<typeof stateRole>[]) => ({
  scanned: {
    guildId: "g",
    ownerId: "owner",
    botUserId: "kool",
    botRoleIds: ["botrole"],
    botHighestRolePosition: 20,
    adminUserId: "kool",
    adminRoleIds: [],
    otherBotIds: [],
    roles: [
      stateRole("g", 0),
      ...roles,
      stateRole("botrole", 20, { permissions: "8" }),
    ],
    channels: [],
    config: {},
    boundChannelIds: [],
    koolbotCreatedIds: [],
  },
  memberCounts: new Map(),
  botIds: null,
  members: null,
});

let svc: InstanceType<typeof RoleGroupSyncService>;
let c: Client;

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(settings)) delete settings[k];
  RoleGroupSyncService.reset();
  liveRoles = [liveRole("g", 0), liveRole("r1", 3)];
  mockList.mockResolvedValue([grp()]);
  mockMarkUnlinked.mockResolvedValue(true);
  mockRecreate.mockResolvedValue(true);
  mockActive.mockResolvedValue(null);
  mockLinkCreated.mockResolvedValue(0);
  mockLog.mockResolvedValue(true);
  mockScan.mockResolvedValue(scanFor([stateRole("r1", 3)]));
  c = client();
  svc = RoleGroupSyncService.getInstance(c);
});

afterEach(() => {
  RoleGroupSyncService.reset();
  jest.useRealTimers();
});

describe("reconcileGuild", () => {
  it("does nothing without groups", async () => {
    mockList.mockResolvedValue([]);
    const s = await svc.reconcileGuild(guild());
    expect(s).toMatchObject({ groups: 0, drift: 0, skipped: false });
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("is quiet when Discord matches the groups", async () => {
    const s = await svc.reconcileGuild(guild());
    expect(s).toMatchObject({ groups: 1, drift: 0 });
    expect(mockLog).not.toHaveBeenCalled();
    expect(mockSetSig).not.toHaveBeenCalled();
  });

  it("only treats an apply with a live heartbeat as running", async () => {
    await svc.reconcileGuild(guild());
    const filter = mockActive.mock.calls[0][0] as {
      guildId: string;
      active: boolean;
      heartbeatAt: { $gte: Date };
    };
    expect(filter).toMatchObject({ guildId: "g", active: true });
    const age = Date.now() - filter.heartbeatAt.$gte.getTime();
    expect(age).toBeGreaterThan(29 * 60_000);
    expect(age).toBeLessThan(31 * 60_000);
  });

  it("starts tracking role names for older groups, then flags a later rename", async () => {
    mockList.mockResolvedValue([grp({ roleName: null })]);
    liveRoles = [liveRole("g", 0), liveRole("r1", 3, { name: "Mods" })];
    await svc.reconcileGuild(guild());
    expect(mockTrack).toHaveBeenCalledWith("g", [
      { groupId: "g1", roleName: "Mods" },
    ]);
    expect(mockLog).not.toHaveBeenCalled();

    liveRoles = [liveRole("g", 0), liveRole("r1", 3, { name: "Renamed" })];
    mockList.mockResolvedValue([grp({ roleName: "Mods" })]);
    const s = await svc.reconcileGuild(guild());
    expect(s.drift).toBe(1);
    expect(mockLog).toHaveBeenCalledTimes(1);
  });

  it("skips while an adoption apply or rollback is running", async () => {
    mockActive.mockResolvedValue({ _id: "x" });
    const s = await svc.reconcileGuild(guild());
    expect(s.skipped).toBe(true);
    expect(mockAdopted).not.toHaveBeenCalled();
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("flag-only (the default) reports drift and logs it once", async () => {
    mockList.mockResolvedValue([grp({ permissions: "1024" })]);
    const s = await svc.reconcileGuild(guild());
    expect(s.drift).toBe(1);
    expect(mockSetSig).toHaveBeenCalledWith("g", "g1", expect.any(String));
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0][0]).toBe("role_groups");
    expect(mockAdopted).not.toHaveBeenCalled();
    expect(mockStartApply).not.toHaveBeenCalled();

    // Same drift, already reported: no second log.
    const sig = mockSetSig.mock.calls[0][2] as string;
    mockList.mockResolvedValue([
      grp({ permissions: "1024", driftSignature: sig }),
    ]);
    mockLog.mockClear();
    await svc.reconcileGuild(guild());
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("clears the signature once the drift is gone", async () => {
    mockList.mockResolvedValue([grp({ driftSignature: "old" })]);
    await svc.reconcileGuild(guild());
    expect(mockSetSig).toHaveBeenCalledWith("g", "g1", null);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("adopt: the group follows Discord and nothing is written to Discord", async () => {
    settings["adoption.role_groups.sync_policy"] = "adopt";
    mockList.mockResolvedValue([grp({ permissions: "1024" })]);
    const s = await svc.reconcileGuild(guild());
    expect(s.adopted).toBe(1);
    expect(mockAdopted).toHaveBeenCalledWith("g", [
      { groupId: "g1", set: { permissions: "0" } },
    ]);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "system:role-group-sync",
        discordUserId: "kool",
        guildId: "g",
      }),
      expect.objectContaining({
        action: "role-groups.sync.adopt",
        targetId: "g1",
        result: "success",
      }),
    );
    expect(mockStartApply).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledTimes(1);
  });

  it("a group's own policy overrides the global one", async () => {
    settings["adoption.role_groups.sync_policy"] = "enforce";
    mockList.mockResolvedValue([
      grp({ permissions: "1024", syncPolicy: "flag" }),
    ]);
    await svc.reconcileGuild(guild());
    expect(mockStartApply).not.toHaveBeenCalled();
    expect(mockAdopted).not.toHaveBeenCalled();
    expect(mockSetSig).toHaveBeenCalled();
  });

  it("never adopts or enforces the admin-permission flag", async () => {
    settings["adoption.role_groups.sync_policy"] = "enforce";
    mockList.mockResolvedValue([grp({ capabilities: ["admin"] })]);
    const s = await svc.reconcileGuild(guild());
    expect(mockStartApply).not.toHaveBeenCalled();
    expect(s.drift).toBe(1);
  });

  it("enforce: re-applies the definition through the engine as the bot", async () => {
    settings["adoption.role_groups.sync_policy"] = "enforce";
    mockList.mockResolvedValue([grp({ permissions: "1024" })]);
    mockStartApply.mockReturnValue({
      status: "done",
      result: { failed: [] },
      error: null,
    });
    const s = await svc.reconcileGuild(guild());
    expect(s.enforced).toBe(1);
    const [plan, opts] = mockStartApply.mock.calls[0];
    expect(plan.operations).toEqual([
      expect.objectContaining({
        type: "role.edit",
        roleId: "r1",
        changes: { permissions: "1024" },
      }),
    ]);
    expect(plan.plannedBy).toBe("kool");
    expect(opts.actor).toMatchObject({
      discordUserId: "kool",
      guildId: "g",
      sessionId: "system:role-group-sync",
    });
    expect(mockSetPolicy).not.toHaveBeenCalled();
  });

  it("enforce only restores the enforced groups, not the flagged ones", async () => {
    settings["adoption.role_groups.sync_policy"] = "flag";
    liveRoles.push(liveRole("r2", 5));
    mockScan.mockResolvedValue(
      scanFor([stateRole("r1", 3), stateRole("r2", 5)]),
    );
    mockList.mockResolvedValue([
      grp({ permissions: "1024", syncPolicy: "enforce" }),
      grp({
        id: "g2",
        name: "Other",
        roleId: "r2",
        rank: 2,
        permissions: "2048",
      }),
    ]);
    mockStartApply.mockReturnValue({
      status: "done",
      result: { failed: [] },
      error: null,
    });
    await svc.reconcileGuild(guild());
    const [plan] = mockStartApply.mock.calls[0];
    expect(plan.operations.map((o: { roleId: string }) => o.roleId)).toEqual([
      "r1",
    ]);
  });

  it("falls back to flag-only when an enforce plan can't be applied", async () => {
    settings["adoption.role_groups.sync_policy"] = "enforce";
    // The group's role sits above the bot: the planner refuses the edit.
    mockScan.mockResolvedValue(scanFor([stateRole("r1", 25)]));
    liveRoles = [liveRole("g", 0), liveRole("r1", 25)];
    mockList.mockResolvedValue([grp({ permissions: "1024" })]);
    await svc.reconcileGuild(guild());
    expect(mockStartApply).not.toHaveBeenCalled();
    expect(mockSetPolicy).toHaveBeenCalledWith("g", "g1", "flag");
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "role-groups.sync.fallback",
        targetId: "g1",
      }),
    );
    expect(mockLog).toHaveBeenCalledTimes(1);
  });

  it("falls back to flag-only when the engine run fails", async () => {
    settings["adoption.role_groups.sync_policy"] = "enforce";
    mockList.mockResolvedValue([grp({ permissions: "1024" })]);
    mockStartApply.mockReturnValue({
      status: "done",
      result: { failed: [{ opId: "1", error: "boom" }] },
      error: null,
    });
    await svc.reconcileGuild(guild());
    expect(mockSetPolicy).toHaveBeenCalledWith("g", "g1", "flag");
  });

  it("does not fall back when the engine is merely busy", async () => {
    settings["adoption.role_groups.sync_policy"] = "enforce";
    mockList.mockResolvedValue([grp({ permissions: "1024" })]);
    mockStartApply.mockImplementation(() => {
      throw new Error("busy");
    });
    await svc.reconcileGuild(guild());
    expect(mockSetPolicy).not.toHaveBeenCalled();
  });

  describe("a deleted role", () => {
    beforeEach(() => {
      liveRoles = [liveRole("g", 0)];
      mockScan.mockResolvedValue(scanFor([]));
    });

    it("marks the group unlinked and alerts, and does not recreate it (flag)", async () => {
      const s = await svc.reconcileGuild(guild());
      expect(mockMarkUnlinked).toHaveBeenCalledWith("g", "g1", "r1");
      expect(mockAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "role-groups.sync.unlink",
          details: { name: "Mods", lostRoleId: "r1" },
        }),
      );
      expect(s.unlinked).toBe(1);
      expect(mockRecreate).not.toHaveBeenCalled();
      expect(mockStartApply).not.toHaveBeenCalled();
      expect(mockLog).toHaveBeenCalledTimes(1);
    });

    it("does not recreate it under adopt either", async () => {
      settings["adoption.role_groups.sync_policy"] = "adopt";
      await svc.reconcileGuild(guild());
      expect(mockRecreate).not.toHaveBeenCalled();
      expect(mockStartApply).not.toHaveBeenCalled();
    });

    it("recreates it only under enforce, through the engine", async () => {
      settings["adoption.role_groups.sync_policy"] = "enforce";
      const recreated = grp({
        roleId: null,
        unlinked: false,
        lostRoleId: "r1",
        recreateRequestedAt: new Date(),
        permissions: "1024",
      });
      mockList
        .mockResolvedValueOnce([grp({ permissions: "1024" })])
        .mockResolvedValueOnce([grp({ permissions: "1024" })])
        .mockResolvedValue([recreated]);
      mockStartApply.mockReturnValue({
        status: "done",
        result: { failed: [] },
        error: null,
      });
      await svc.reconcileGuild(guild());
      expect(mockRecreate).toHaveBeenCalledWith("g", "g1");
      expect(mockAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "role-groups.sync.recreate" }),
      );
      const [plan] = mockStartApply.mock.calls[0];
      expect(plan.operations).toEqual([
        expect.objectContaining({ type: "role.create", name: "Mods" }),
      ]);
      expect(mockLinkCreated).toHaveBeenCalledTimes(2);
    });

    it("never recreates a gate-only group's role", async () => {
      settings["adoption.role_groups.sync_policy"] = "enforce";
      mockList.mockResolvedValue([grp({ gateOnly: true })]);
      await svc.reconcileGuild(guild());
      expect(mockMarkUnlinked).toHaveBeenCalled();
      expect(mockRecreate).not.toHaveBeenCalled();
      expect(mockStartApply).not.toHaveBeenCalled();
    });

    it("ignores a group that was already unlinked", async () => {
      mockList.mockResolvedValue([grp({ roleId: null, unlinked: true })]);
      const s = await svc.reconcileGuild(guild());
      expect(mockMarkUnlinked).not.toHaveBeenCalled();
      expect(s.unlinked).toBe(0);
    });
  });

  it("never throws when Discord or the database fails", async () => {
    mockList.mockRejectedValue(new Error("db"));
    await expect(svc.reconcileGuild(guild())).resolves.toMatchObject({
      groups: 0,
    });
  });

  it("serialises overlapping reconciles", async () => {
    const order: string[] = [];
    mockList.mockImplementation(async () => {
      order.push("list");
      return [];
    });
    await Promise.all([
      svc.reconcileGuild(guild()),
      svc.reconcileGuild(guild()),
    ]);
    expect(order).toHaveLength(2);
  });
});

describe("Discord events", () => {
  const role = (id: string, over: Record<string, unknown> = {}) =>
    ({
      id,
      name: "n",
      position: 1,
      permissions: { bitfield: 0n },
      guild: { id: "g" },
      ...over,
    }) as unknown as Role;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  it("reconciles shortly after a group's role is edited, once for a burst", async () => {
    await svc.handleRoleUpdate(role("r1"), role("r1", { name: "x" }));
    await svc.handleRoleUpdate(role("r1"), role("r1", { position: 4 }));
    await jest.advanceTimersByTimeAsync(4_000);
    expect(mockActive).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(mockActive).toHaveBeenCalledTimes(1);
  });

  it("ignores edits that change nothing the sync cares about", async () => {
    await svc.handleRoleUpdate(role("r1"), role("r1"));
    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockActive).not.toHaveBeenCalled();
  });

  it("ignores roles that back no group", async () => {
    await svc.handleRoleUpdate(role("zzz"), role("zzz", { name: "x" }));
    await svc.handleRoleDelete(role("zzz"));
    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockActive).not.toHaveBeenCalled();
  });

  it("reconciles after a group's role is deleted", async () => {
    await svc.handleRoleDelete(role("r1"));
    await jest.advanceTimersByTimeAsync(6_000);
    expect(mockActive).toHaveBeenCalledTimes(1);
  });

  it("still reconciles live changes while the periodic job is switched off", async () => {
    settings["adoption.role_groups.reconcile_enabled"] = false;
    await svc.handleRoleDelete(role("r1"));
    await jest.advanceTimersByTimeAsync(6_000);
    expect(mockActive).toHaveBeenCalledTimes(1);
  });

  it("retries later when an adoption was running, then gives up", async () => {
    mockActive.mockResolvedValue({ _id: "x" });
    await svc.handleRoleDelete(role("r1"));
    await jest.advanceTimersByTimeAsync(6_000);
    expect(mockActive).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(31_000);
    expect(mockActive).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(31_000 * 12);
    expect(mockActive.mock.calls.length).toBeLessThanOrEqual(12);
  });
});

describe("scheduled run", () => {
  it("reads the schedule and runs against the configured guild", async () => {
    settings["adoption.role_groups.reconcile_cron"] = "*/10 * * * *";
    settings["GUILD_ID"] = "g";
    mockList.mockResolvedValue([]);
    const summary = await svc.runNow();
    expect(summary).toMatchObject({ groups: 0 });
    expect(c.guilds.fetch).toHaveBeenCalledWith("g");
  });

  it("aborts without a configured guild", async () => {
    expect(await svc.runNow()).toBeNull();
  });

  it("is disabled by its key", async () => {
    settings["adoption.role_groups.reconcile_enabled"] = false;
    settings["GUILD_ID"] = "g";
    expect(await svc.runNow()).toBeNull();
  });
});
