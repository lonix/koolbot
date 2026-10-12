import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import type { Client, Guild, GuildMember } from "discord.js";

const config = new Map<string, unknown>();
const reloadCallbacks: Array<() => Promise<void>> = [];
const mockEnv = { guildId: "guild-1", guildMembersIntent: true };
const mockLogger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};
const mockCreate =
  jest.fn<(row: Record<string, unknown>) => Promise<unknown>>();
const mockFindOne = jest.fn();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: (cb: () => Promise<void>) => {
        reloadCallbacks.push(cb);
      },
      getBoolean: async (key: string, def: boolean) =>
        (config.get(key) as boolean | undefined) ?? def,
      getNumber: async (key: string, def: number) =>
        (config.get(key) as number | undefined) ?? def,
      getString: async (key: string, def: string) =>
        (config.get(key) as string | undefined) ?? def,
    })),
  },
}));
jest.unstable_mockModule("../../src/config/env.js", () => ({ env: mockEnv }));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: mockLogger,
}));
jest.unstable_mockModule("../../src/models/moderation-log.js", () => ({
  ModerationLog: { create: mockCreate, findOne: mockFindOne },
}));

const {
  RaidProtectionService,
  clampInt,
  parseRaidAction,
  countJoinsInWindow,
  isNewAccount,
  INIT_WAIT_MS,
} = await import("../../src/services/raid-protection-service.js");

const HOUR = 60 * 60 * 1000;

interface FakeMember {
  member: GuildMember;
  kick: jest.Mock;
  timeout: jest.Mock;
  rolesAdd: jest.Mock;
}

const send = jest.fn<(arg: unknown) => Promise<unknown>>();
const roles = new Map<string, unknown>();
const guild = {
  id: "guild-1",
  channels: {
    fetch: jest.fn(async () => ({ isTextBased: () => true, send })),
  },
  roles: {
    cache: { get: (id: string) => roles.get(id) },
    fetch: jest.fn(async (id: string) => roles.get(id) ?? null),
  },
} as unknown as Guild;

let nextId = 0;
function makeMember(
  opts: {
    bot?: boolean;
    ageMs?: number;
    guildId?: string;
    kickable?: boolean;
    moderatable?: boolean;
    manageable?: boolean;
  } = {},
): FakeMember {
  const kick = jest.fn(async () => undefined);
  const timeout = jest.fn(async () => undefined);
  const rolesAdd = jest.fn(async () => undefined);
  const member = {
    id: `user-${++nextId}`,
    guild: opts.guildId === undefined ? guild : { id: opts.guildId },
    user: {
      bot: opts.bot ?? false,
      createdTimestamp: Date.now() - (opts.ageMs ?? 400 * 24 * HOUR),
    },
    kickable: opts.kickable ?? true,
    moderatable: opts.moderatable ?? true,
    manageable: opts.manageable ?? true,
    kick,
    timeout,
    roles: { add: rolesAdd },
  } as unknown as GuildMember;
  return { member, kick, timeout, rolesAdd };
}

const client = {
  user: { id: "bot-1" },
  guilds: { cache: { get: (id: string) => (id === "guild-1" ? guild : null) } },
} as unknown as Client;

function liveConfig(extra: Record<string, unknown> = {}): void {
  config.clear();
  config.set("moderation.enabled", true);
  config.set("moderation.raid.enabled", true);
  config.set("moderation.raid.dry_run", false);
  config.set("moderation.raid.join_threshold", 3);
  config.set("moderation.raid.window_seconds", 30);
  config.set("moderation.raid.alert_channel_id", "alert-1");
  for (const [k, v] of Object.entries(extra)) config.set(k, v);
}

async function joinMany(n: number): Promise<FakeMember[]> {
  const out: FakeMember[] = [];
  for (let i = 0; i < n; i++) {
    const m = makeMember();
    await RaidProtectionService.getInstance(client).handleMemberJoin(m.member);
    out.push(m);
  }
  return out;
}

function rowsWith(action: string): Array<Record<string, unknown>> {
  return mockCreate.mock.calls
    .map((c) => c[0])
    .filter((r) => r.action === action);
}

describe("RaidProtectionService helpers", () => {
  it("clamps and falls back", () => {
    expect(clampInt(1, 5, 10, 7)).toBe(5);
    expect(clampInt(99, 5, 10, 7)).toBe(10);
    expect(clampInt(6.9, 5, 10, 7)).toBe(6);
    expect(clampInt(Number.NaN, 5, 10, 7)).toBe(7);
  });

  it("falls back to the reversible action for anything unknown", () => {
    expect(parseRaidAction("kick")).toBe("kick");
    expect(parseRaidAction("quarantine")).toBe("quarantine");
    expect(parseRaidAction("ban")).toBe("timeout");
    expect(parseRaidAction("")).toBe("timeout");
  });

  it("counts only joins inside the window, in any order", () => {
    const joins = [1000, 50, 900, 990];
    expect(countJoinsInWindow(joins, 1000, 200)).toBe(3);
    expect(joins).toEqual([1000, 900, 990]);
  });

  it("treats a gate of 0 as off and compares account age otherwise", () => {
    const now = 100 * HOUR;
    expect(isNewAccount(now, now, 0)).toBe(false);
    expect(isNewAccount(now - 2 * HOUR, now, 24)).toBe(true);
    expect(isNewAccount(now - 25 * HOUR, now, 24)).toBe(false);
  });
});

describe("RaidProtectionService", () => {
  beforeEach(async () => {
    RaidProtectionService.reset();
    jest.clearAllMocks();
    reloadCallbacks.length = 0;
    roles.clear();
    mockEnv.guildId = "guild-1";
    mockEnv.guildMembersIntent = true;
    mockCreate.mockResolvedValue({});
    send.mockResolvedValue({});
    liveConfig();
    // Joins wait for startup restoration, so every test starts initialised
    // against an empty log unless it says otherwise.
    mockFindOne.mockReturnValue({
      sort: () => ({ lean: () => ({ exec: async () => null }) }),
    });
    await RaidProtectionService.getInstance(client).initialize();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("inactive states", () => {
    it.each([
      ["the feature is off", { "moderation.raid.enabled": false }],
      ["the moderation log is off", { "moderation.enabled": false }],
    ])("does nothing when %s", async (_label, override) => {
      liveConfig(override);
      const joined = await joinMany(6);
      expect(joined.every((m) => m.timeout.mock.calls.length === 0)).toBe(true);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("does nothing without the Server Members Intent and says why", async () => {
      mockEnv.guildMembersIntent = false;
      const service = RaidProtectionService.getInstance(client);
      expect(await service.getInactiveReason()).toMatch(/Members Intent/);
      expect(await service.warnIfInactive()).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("inactive"),
      );
      const m = await joinMany(6);
      expect(m.every((x) => x.timeout.mock.calls.length === 0)).toBe(true);
    });

    it("does not warn when the feature is simply off", async () => {
      liveConfig({ "moderation.raid.enabled": false });
      expect(
        await RaidProtectionService.getInstance(client).warnIfInactive(),
      ).toBe(false);
    });

    it("refuses a manual lockdown while inactive", async () => {
      liveConfig({ "moderation.enabled": false });
      const result = await RaidProtectionService.getInstance(
        client,
      ).setLockdown(guild, true, "mod-1");
      expect(result.changed).toBe(false);
      expect(result.message).toMatch(/moderation log/);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe("join-rate detection", () => {
    it("does not lock down at the threshold, only above it", async () => {
      const first = await joinMany(3);
      expect(first.every((m) => m.timeout.mock.calls.length === 0)).toBe(true);
      expect(rowsWith("raid_lockdown")).toHaveLength(0);

      const fourth = makeMember();
      const acted = await RaidProtectionService.getInstance(
        client,
      ).handleMemberJoin(fourth.member);
      expect(acted).toBe(true);
      expect(fourth.timeout).toHaveBeenCalledWith(
        60 * 60 * 1000,
        expect.stringContaining("lockdown"),
      );
      // Members admitted before the flood was detected are left alone.
      expect(first.every((m) => m.timeout.mock.calls.length === 0)).toBe(true);
    });

    it("records the lockdown, alerts once and logs each action as a raid row", async () => {
      await joinMany(4);
      await joinMany(1);
      expect(rowsWith("raid_lockdown")).toHaveLength(1);
      expect(rowsWith("raid_lockdown")[0]).toMatchObject({
        guildId: "guild-1",
        userId: "guild-1",
        moderatorId: null,
        source: "raid",
      });
      const timeouts = rowsWith("timeout");
      expect(timeouts).toHaveLength(2);
      expect(timeouts[0]).toMatchObject({
        moderatorId: "bot-1",
        source: "raid",
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ allowedMentions: { parse: [] } }),
      );
    });

    it("lets old joins age out of the window", async () => {
      jest.useFakeTimers({ now: Date.now() });
      await joinMany(3);
      jest.setSystemTime(Date.now() + 31_000);
      const m = makeMember();
      await RaidProtectionService.getInstance(client).handleMemberJoin(
        m.member,
      );
      expect(m.timeout).not.toHaveBeenCalled();
    });

    it("starts only one lockdown for concurrent joins", async () => {
      const members = Array.from({ length: 8 }, () => makeMember());
      const service = RaidProtectionService.getInstance(client);
      await Promise.all(members.map((m) => service.handleMemberJoin(m.member)));
      expect(rowsWith("raid_lockdown")).toHaveLength(1);
    });

    it("ignores bots and other guilds", async () => {
      const service = RaidProtectionService.getInstance(client);
      for (let i = 0; i < 6; i++) {
        await service.handleMemberJoin(makeMember({ bot: true }).member);
        await service.handleMemberJoin(makeMember({ guildId: "other" }).member);
      }
      expect(mockCreate).not.toHaveBeenCalled();
      const status = await service.getStatus(guild);
      expect(status.joinsInWindow).toBe(0);
    });
  });

  describe("dry run", () => {
    it("enters lockdown and alerts but never touches a member", async () => {
      liveConfig({ "moderation.raid.dry_run": true });
      const members = await joinMany(6);
      expect(
        members.every(
          (m) =>
            m.timeout.mock.calls.length === 0 &&
            m.kick.mock.calls.length === 0 &&
            m.rolesAdd.mock.calls.length === 0,
        ),
      ).toBe(true);
      expect(rowsWith("timeout")).toHaveLength(0);
      expect(rowsWith("raid_lockdown")[0].reason).toMatch(/dry run/);
      expect(send).toHaveBeenCalledTimes(1);
      const status =
        await RaidProtectionService.getInstance(client).getStatus(guild);
      expect(status.lockdown).toBe(true);
      expect(status.wouldAction).toBe(3);
      expect(status.actioned).toBe(0);
    });
  });

  describe("dry run switched off mid-lockdown", () => {
    it("ends the rehearsal lockdown instead of letting it go live", async () => {
      liveConfig({ "moderation.raid.dry_run": true });
      // A manual rehearsal, so the join counter is not still hot afterwards.
      await RaidProtectionService.getInstance(client).setLockdown(
        guild,
        true,
        "mod-1",
      );
      expect(rowsWith("raid_lockdown")).toHaveLength(1);

      liveConfig({ "moderation.raid.dry_run": false });
      const next = makeMember();
      const acted = await RaidProtectionService.getInstance(
        client,
      ).handleMemberJoin(next.member);
      expect(acted).toBe(false);
      expect(next.timeout).not.toHaveBeenCalled();
      expect(rowsWith("raid_clear")).toHaveLength(1);
      expect(rowsWith("raid_clear")[0].reason).toMatch(
        /dry run was switched off/,
      );
      expect(rowsWith("timeout")).toHaveLength(0);
    });

    it("also ends it when only the status is read", async () => {
      liveConfig({ "moderation.raid.dry_run": true });
      const service = RaidProtectionService.getInstance(client);
      await service.setLockdown(guild, true, "mod-1");
      liveConfig({ "moderation.raid.dry_run": false });
      expect((await service.getStatus(guild)).lockdown).toBe(false);
    });

    it("keeps a live lockdown live", async () => {
      await joinMany(4);
      const status =
        await RaidProtectionService.getInstance(client).getStatus(guild);
      expect(status.lockdown).toBe(true);
      expect(rowsWith("raid_clear")).toHaveLength(0);
    });
  });

  describe("state across settings changes", () => {
    it("does not act on the join that follows a dry-run to live switch", async () => {
      liveConfig({ "moderation.raid.dry_run": true });
      await joinMany(6);
      liveConfig({ "moderation.raid.dry_run": false });
      const next = makeMember();
      const acted = await RaidProtectionService.getInstance(
        client,
      ).handleMemberJoin(next.member);
      expect(acted).toBe(false);
      expect(next.timeout).not.toHaveBeenCalled();
      expect(rowsWith("raid_lockdown")).toHaveLength(1);
      expect(
        (await RaidProtectionService.getInstance(client).getStatus(guild))
          .lockdown,
      ).toBe(false);
    });

    it("starts counting afresh when the threshold is lowered", async () => {
      liveConfig({ "moderation.raid.join_threshold": 50 });
      await joinMany(8);
      liveConfig({ "moderation.raid.join_threshold": 3 });
      const next = makeMember();
      expect(
        await RaidProtectionService.getInstance(client).handleMemberJoin(
          next.member,
        ),
      ).toBe(false);
      expect(rowsWith("raid_lockdown")).toHaveLength(0);
    });

    it("starts counting afresh when the window changes", async () => {
      await joinMany(3);
      liveConfig({ "moderation.raid.window_seconds": 60 });
      const next = makeMember();
      expect(
        await RaidProtectionService.getInstance(client).handleMemberJoin(
          next.member,
        ),
      ).toBe(false);
    });

    it.each([
      ["the feature", { "moderation.raid.enabled": false }],
      ["the moderation log", { "moderation.enabled": false }],
    ])("closes the lockdown when %s is switched off", async (_l, off) => {
      const service = RaidProtectionService.getInstance(client);
      await joinMany(4);
      expect((await service.getStatus(guild)).lockdown).toBe(true);

      liveConfig(off);
      const during = makeMember();
      expect(await service.handleMemberJoin(during.member)).toBe(false);
      expect(rowsWith("raid_clear")).toHaveLength(1);

      // Re-enabled without a restart: no lockdown resumes, and the old window
      // is gone, so the next join is not acted on.
      liveConfig();
      const after = makeMember();
      expect(await service.handleMemberJoin(after.member)).toBe(false);
      expect(after.timeout).not.toHaveBeenCalled();
      expect((await service.getStatus(guild)).lockdown).toBe(false);
    });

    it("closes the lockdown on a settings reload, before any join", async () => {
      const service = RaidProtectionService.getInstance(client);
      await service.initialize();
      expect(reloadCallbacks).toHaveLength(1);
      await service.initialize();
      expect(reloadCallbacks).toHaveLength(1);
      await service.setLockdown(guild, true, "mod-1");
      liveConfig({ "moderation.raid.enabled": false });
      await reloadCallbacks[0]();
      expect(rowsWith("raid_clear")).toHaveLength(1);
      liveConfig();
      expect((await service.getStatus(guild)).lockdown).toBe(false);
    });
  });

  describe("actions and safety", () => {
    it("kicks when configured", async () => {
      liveConfig({ "moderation.raid.lockdown_action": "kick" });
      const members = await joinMany(4);
      expect(members[3].kick).toHaveBeenCalled();
      expect(rowsWith("kick")).toHaveLength(1);
    });

    it("assigns the quarantine role", async () => {
      const role = { id: "q-1", managed: false, editable: true };
      roles.set("q-1", role);
      liveConfig({
        "moderation.raid.lockdown_action": "quarantine",
        "moderation.raid.quarantine_role_id": "q-1",
      });
      const members = await joinMany(4);
      expect(members[3].rolesAdd).toHaveBeenCalledWith(
        role,
        expect.any(String),
      );
      expect(rowsWith("quarantine")).toHaveLength(1);
    });

    it.each([
      ["missing", undefined, ""],
      ["unknown", undefined, "nope"],
      ["managed", { id: "q", managed: true, editable: true }, "q"],
      ["above the bot", { id: "q", managed: false, editable: false }, "q"],
      [
        "@everyone",
        { id: "guild-1", managed: false, editable: true },
        "guild-1",
      ],
    ])(
      "skips quarantine without acting when the role is %s",
      async (_label, role, id) => {
        if (role) roles.set(id, role);
        liveConfig({
          "moderation.raid.lockdown_action": "quarantine",
          "moderation.raid.quarantine_role_id": id,
        });
        const members = await joinMany(5);
        expect(members.every((m) => m.rolesAdd.mock.calls.length === 0)).toBe(
          true,
        );
        expect(rowsWith("quarantine")).toHaveLength(0);
        const status =
          await RaidProtectionService.getInstance(client).getStatus(guild);
        expect(status.skipped).toBe(2);
      },
    );

    it.each([
      ["timeout", "moderatable"],
      ["kick", "kickable"],
      ["quarantine", "manageable"],
    ] as const)(
      "never forces %s on a member the bot may not act on (%s)",
      async (action, flag) => {
        roles.set("q-1", { id: "q-1", managed: false, editable: true });
        liveConfig({
          "moderation.raid.lockdown_action": action,
          "moderation.raid.quarantine_role_id": "q-1",
        });
        await joinMany(3);
        const protectedMember = makeMember({ [flag]: false });
        const acted = await RaidProtectionService.getInstance(
          client,
        ).handleMemberJoin(protectedMember.member);
        expect(acted).toBe(false);
        expect(protectedMember.kick).not.toHaveBeenCalled();
        expect(protectedMember.timeout).not.toHaveBeenCalled();
        expect(protectedMember.rolesAdd).not.toHaveBeenCalled();
        expect(rowsWith(action)).toHaveLength(0);
      },
    );

    it("counts a failed action, writes no row, and alerts once", async () => {
      await joinMany(3);
      const failing = [makeMember(), makeMember()];
      for (const f of failing) {
        f.timeout.mockRejectedValue(new Error("Missing Permissions"));
      }
      const service = RaidProtectionService.getInstance(client);
      expect(await service.handleMemberJoin(failing[0].member)).toBe(false);
      await service.handleMemberJoin(failing[1].member);
      expect(rowsWith("timeout")).toHaveLength(0);
      const status = await service.getStatus(guild);
      expect(status.failed).toBe(2);
      // One lockdown alert plus a single failure alert.
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("clamps an out-of-range timeout to Discord's limit", async () => {
      liveConfig({ "moderation.raid.timeout_minutes": 999999 });
      const members = await joinMany(4);
      expect(members[3].timeout).toHaveBeenCalledWith(
        28 * 24 * 60 * 60 * 1000,
        expect.any(String),
      );
    });

    it("survives a failing log write and a failing alert", async () => {
      mockCreate.mockRejectedValue(new Error("db down"));
      send.mockRejectedValue(new Error("no access"));
      const members = await joinMany(4);
      expect(members[3].timeout).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("new-account gate", () => {
    it("acts on a young account without any lockdown", async () => {
      liveConfig({
        "moderation.raid.min_account_age_hours": 24,
        "moderation.raid.new_account_action": "kick",
      });
      const young = makeMember({ ageMs: 2 * HOUR });
      const old = makeMember({ ageMs: 48 * HOUR });
      const service = RaidProtectionService.getInstance(client);
      expect(await service.handleMemberJoin(young.member)).toBe(true);
      expect(await service.handleMemberJoin(old.member)).toBe(false);
      expect(young.kick).toHaveBeenCalledWith(
        expect.stringContaining("younger than 24h"),
      );
      expect(old.kick).not.toHaveBeenCalled();
      expect(rowsWith("raid_lockdown")).toHaveLength(0);
    });

    it("is off at 0", async () => {
      const young = makeMember({ ageMs: 1000 });
      expect(
        await RaidProtectionService.getInstance(client).handleMemberJoin(
          young.member,
        ),
      ).toBe(false);
      expect(young.timeout).not.toHaveBeenCalled();
    });

    it("previews in dry run without acting", async () => {
      liveConfig({
        "moderation.raid.min_account_age_hours": 24,
        "moderation.raid.dry_run": true,
      });
      const young = makeMember({ ageMs: HOUR });
      await RaidProtectionService.getInstance(client).handleMemberJoin(
        young.member,
      );
      expect(young.timeout).not.toHaveBeenCalled();
      expect(rowsWith("timeout")).toHaveLength(0);
    });
  });

  describe("manual toggle and expiry", () => {
    it("starts and clears a lockdown with an audit row each", async () => {
      const service = RaidProtectionService.getInstance(client);
      const on = await service.setLockdown(guild, true, "mod-1");
      expect(on.changed).toBe(true);
      expect(rowsWith("raid_lockdown")[0]).toMatchObject({
        moderatorId: "mod-1",
      });
      expect((await service.setLockdown(guild, true, "mod-1")).changed).toBe(
        false,
      );

      const m = makeMember();
      expect(await service.handleMemberJoin(m.member)).toBe(true);

      const off = await service.setLockdown(guild, false, "mod-2");
      expect(off.changed).toBe(true);
      expect(rowsWith("raid_clear")[0]).toMatchObject({ moderatorId: "mod-2" });
      expect((await service.setLockdown(guild, false, "mod-2")).changed).toBe(
        false,
      );
      const after = makeMember();
      expect(await service.handleMemberJoin(after.member)).toBe(false);
    });

    it("ends a lockdown by itself after the configured time", async () => {
      jest.useFakeTimers({ now: Date.now() });
      liveConfig({ "moderation.raid.lockdown_max_minutes": 10 });
      const service = RaidProtectionService.getInstance(client);
      await service.setLockdown(guild, true, "mod-1");
      jest.setSystemTime(Date.now() + 11 * 60 * 1000);
      const status = await service.getStatus(guild);
      expect(status.lockdown).toBe(false);
      expect(rowsWith("raid_clear")[0]).toMatchObject({ moderatorId: null });
    });

    it("never expires with 0", async () => {
      jest.useFakeTimers({ now: Date.now() });
      const service = RaidProtectionService.getInstance(client);
      await service.setLockdown(guild, true, "mod-1");
      jest.setSystemTime(Date.now() + 1000 * HOUR);
      expect((await service.getStatus(guild)).lockdown).toBe(true);
    });
  });

  describe("initialize", () => {
    function lastRow(row: unknown): void {
      mockFindOne.mockReturnValue({
        sort: () => ({
          lean: () => ({ exec: async () => row }),
        }),
      });
    }

    it("restores a lockdown that was on before a restart", async () => {
      lastRow({
        action: "raid_lockdown",
        createdAt: new Date(),
        moderatorId: "mod-1",
      });
      const service = RaidProtectionService.getInstance(client);
      await service.initialize();
      const status = await service.getStatus(guild);
      expect(status.lockdown).toBe(true);
      expect(status.startedBy).toBe("mod-1");
    });

    it("does not restore a rehearsal (dry run) lockdown", async () => {
      lastRow({
        action: "raid_lockdown",
        createdAt: new Date(),
        moderatorId: null,
        reason: "Automatic: 5 members joined (dry run)",
      });
      const service = RaidProtectionService.getInstance(client);
      await service.initialize();
      expect((await service.getStatus(guild)).lockdown).toBe(false);
      // The persisted state now agrees: the stale open row is closed.
      expect(rowsWith("raid_clear")).toHaveLength(1);
      expect(rowsWith("raid_clear")[0].reason).toMatch(/dry-run/);
    });

    it("holds a join until restoration finishes, then applies the restored lockdown", async () => {
      RaidProtectionService.reset();
      const service = RaidProtectionService.getInstance(client);
      const m = makeMember();
      const pending = service.handleMemberJoin(m.member);
      await Promise.resolve();
      expect(m.timeout).not.toHaveBeenCalled();
      lastRow({
        action: "raid_lockdown",
        createdAt: new Date(),
        moderatorId: "mod-1",
        reason: "Manual",
      });
      await service.initialize();
      expect(await pending).toBe(true);
      expect(m.timeout).toHaveBeenCalled();
    });

    it("stops waiting after the bounded time when restoration never finishes, and says so", async () => {
      jest.useFakeTimers();
      RaidProtectionService.reset();
      const service = RaidProtectionService.getInstance(client);
      const first = makeMember();
      const pending = service.handleMemberJoin(first.member);
      await jest.advanceTimersByTimeAsync(INIT_WAIT_MS + 1);
      expect(await pending).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("did not finish"),
      );
      // Later joins do not wait again.
      mockLogger.warn.mockClear();
      await service.handleMemberJoin(makeMember().member);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("releases waiting joins even when restoration fails", async () => {
      RaidProtectionService.reset();
      mockFindOne.mockImplementation(() => {
        throw new Error("db down");
      });
      const service = RaidProtectionService.getInstance(client);
      const pending = service.handleMemberJoin(makeMember().member);
      await service.initialize();
      expect(await pending).toBe(false);
    });

    it("closes, rather than restores, a lockdown found while the feature is off", async () => {
      liveConfig({ "moderation.raid.enabled": false });
      lastRow({
        action: "raid_lockdown",
        createdAt: new Date(),
        moderatorId: "mod-1",
        reason: "Manual",
      });
      const service = RaidProtectionService.getInstance(client);
      await service.initialize();
      expect(rowsWith("raid_clear")).toHaveLength(1);
      liveConfig();
      expect((await service.getStatus(guild)).lockdown).toBe(false);
    });

    it("stays out of lockdown when the newest row is a clear, or none", async () => {
      lastRow({
        action: "raid_clear",
        createdAt: new Date(),
        moderatorId: null,
      });
      const service = RaidProtectionService.getInstance(client);
      await service.initialize();
      expect((await service.getStatus(guild)).lockdown).toBe(false);
      RaidProtectionService.reset();
      lastRow(null);
      const again = RaidProtectionService.getInstance(client);
      await again.initialize();
      expect((await again.getStatus(guild)).lockdown).toBe(false);
    });

    it("fails safe when the read fails", async () => {
      mockFindOne.mockImplementation(() => {
        throw new Error("db down");
      });
      const service = RaidProtectionService.getInstance(client);
      await expect(service.initialize()).resolves.toBeUndefined();
      expect((await service.getStatus(guild)).lockdown).toBe(false);
    });
  });
});
