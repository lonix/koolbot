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
const changeListeners: Array<(key: string) => void> = [];
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
      addChangeListener: (cb: (key: string) => void) => {
        changeListeners.push(cb);
      },
      removeReloadCallback: (cb: () => Promise<void>) => {
        const i = reloadCallbacks.indexOf(cb);
        if (i !== -1) reloadCallbacks.splice(i, 1);
      },
      removeChangeListener: (cb: (key: string) => void) => {
        const i = changeListeners.indexOf(cb);
        if (i !== -1) changeListeners.splice(i, 1);
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
// ObjectIds that increase with creation order, like the real ones in one process.
let objectIdCounter = 0;
jest.unstable_mockModule("mongoose", () => ({
  Types: {
    ObjectId: class {
      private readonly value = String(++objectIdCounter).padStart(8, "0");
      toString(): string {
        return this.value;
      }
    },
  },
}));
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
  MAX_PENDING_ROWS,
  MAX_PENDING_TRANSITIONS,
  ROW_RETRY_DELAYS_MS,
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
    changeListeners.length = 0;
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
      expect(status.counts.wouldAction).toBe(3);
      expect(status.counts.actioned).toBe(0);
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

    it("closes the lockdown on an ordinary settings save, which only notifies change listeners", async () => {
      const service = RaidProtectionService.getInstance(client);
      await service.initialize();
      expect(changeListeners).toHaveLength(1);
      await service.setLockdown(guild, true, "mod-1");

      // Unrelated keys are ignored.
      changeListeners[0]("quotes.enabled");
      await new Promise((r) => setTimeout(r, 0));
      expect(rowsWith("raid_clear")).toHaveLength(0);

      liveConfig({ "moderation.enabled": false });
      changeListeners[0]("moderation.enabled");
      await new Promise((r) => setTimeout(r, 0));
      expect(rowsWith("raid_clear")).toHaveLength(1);
      liveConfig();
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

  describe("detection reset and counters", () => {
    it("does not restart a cleared lockdown from the joins that caused it", async () => {
      const service = RaidProtectionService.getInstance(client);
      await joinMany(4);
      expect(rowsWith("raid_lockdown")).toHaveLength(1);
      await service.setLockdown(guild, false, "mod-1");
      const next = makeMember();
      expect(await service.handleMemberJoin(next.member)).toBe(false);
      expect(rowsWith("raid_lockdown")).toHaveLength(1);
      expect((await service.getStatus(guild)).lockdown).toBe(false);
    });

    it("keeps the new-account gate out of the lockdown counters", async () => {
      liveConfig({
        "moderation.raid.min_account_age_hours": 24,
        "moderation.raid.dry_run": true,
      });
      const service = RaidProtectionService.getInstance(client);
      await service.handleMemberJoin(makeMember({ ageMs: HOUR }).member);
      const status = await service.getStatus(guild);
      expect(status.lockdown).toBe(false);
      expect(status.counts.wouldAction).toBe(0);
      expect(status.gateCounts.wouldAction).toBe(1);
    });

    it("counts lockdown actions against the lockdown only", async () => {
      await joinMany(4);
      const status =
        await RaidProtectionService.getInstance(client).getStatus(guild);
      expect(status.counts.actioned).toBe(1);
      expect(status.gateCounts.actioned).toBe(0);
    });
  });

  describe("transitions and authorisation", () => {
    it("authorises /raidmode on against the settings snapshot it starts with", async () => {
      const service = RaidProtectionService.getInstance(client);
      const seen: string[] = [];
      const refused = await service.setLockdown(guild, true, "mod-1", (r) => {
        seen.push(r.action);
        return "nope";
      });
      expect(refused).toEqual({ changed: false, message: "nope" });
      expect(rowsWith("raid_lockdown")).toHaveLength(0);

      liveConfig({ "moderation.raid.lockdown_action": "kick" });
      const allowed = await service.setLockdown(guild, true, "mod-1", (r) => {
        seen.push(r.action);
        return null;
      });
      expect(allowed.changed).toBe(true);
      expect(seen).toEqual(["timeout", "kick"]);
    });

    it("does not authorise (or require anything for) off", async () => {
      const service = RaidProtectionService.getInstance(client);
      await service.setLockdown(guild, true, "mod-1");
      const authorize = jest.fn(() => "nope");
      expect(
        (await service.setLockdown(guild, false, "mod-1", authorize)).changed,
      ).toBe(true);
      expect(authorize).not.toHaveBeenCalled();
    });

    it("stops recording joins once locked down, so a flood costs no growing window", async () => {
      const service = RaidProtectionService.getInstance(client);
      await joinMany(4);
      await joinMany(40);
      expect((await service.getStatus(guild)).joinsInWindow).toBe(0);
    });

    it("alerts a lockdown start before its end when an automatic lockdown is ended while its row is being written", async () => {
      const service = RaidProtectionService.getInstance(client);
      await joinMany(3);
      let release: () => void = () => undefined;
      mockCreate.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve({}))),
      );
      // The 4th join starts a lockdown automatically (not under the manual
      // lock) and waits on its log row.
      const crossing = service.handleMemberJoin(makeMember().member);
      await new Promise((r) => setTimeout(r, 0));
      const ending = service.setLockdown(guild, false, "mod-2");
      await new Promise((r) => setTimeout(r, 0));
      release();
      await ending;
      await crossing;
      const texts = send.mock.calls.map((c) =>
        String((c[0] as { content: string }).content),
      );
      // Alerts come out in transition order: started, then ended, never the
      // reverse, and the final state is off.
      const started = texts.findIndex((t) => t.includes("lockdown started"));
      const ended = texts.findIndex((t) => t.includes("lockdown ended"));
      expect(started).toBeGreaterThanOrEqual(0);
      expect(ended).toBeGreaterThan(started);
      expect((await service.getStatus(guild)).lockdown).toBe(false);
    });

    it("reports both live and dry-run activity when dry run is switched on mid-lockdown", async () => {
      const service = RaidProtectionService.getInstance(client);
      await joinMany(4);
      liveConfig({ "moderation.raid.dry_run": true });
      await service.handleMemberJoin(makeMember().member);
      await service.setLockdown(guild, false, "mod-1");
      const reason = String(rowsWith("raid_clear")[0].reason);
      expect(reason).toMatch(/1 acted on, 1 would have been \(dry run\)/);
    });
  });

  describe("auto-expiry timer", () => {
    it("ends a quiet lockdown on time with no join, status read or settings save", async () => {
      jest.useFakeTimers({ now: Date.now() });
      liveConfig({ "moderation.raid.lockdown_max_minutes": 10 });
      const service = RaidProtectionService.getInstance(client);
      await service.setLockdown(guild, true, "mod-1");
      send.mockClear();

      await jest.advanceTimersByTimeAsync(9 * 60 * 1000);
      expect(rowsWith("raid_clear")).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(rowsWith("raid_clear")).toHaveLength(1);
      expect(rowsWith("raid_clear")[0]).toMatchObject({ moderatorId: null });
      expect(send).toHaveBeenCalledTimes(1);
      service.destroy();
    });

    it("is cancelled by a manual clear and by destroy()", async () => {
      jest.useFakeTimers({ now: Date.now() });
      liveConfig({ "moderation.raid.lockdown_max_minutes": 10 });
      const service = RaidProtectionService.getInstance(client);
      await service.setLockdown(guild, true, "mod-1");
      await service.setLockdown(guild, false, "mod-1");
      expect(jest.getTimerCount()).toBe(0);
      await service.setLockdown(guild, true, "mod-1");
      expect(jest.getTimerCount()).toBe(1);
      service.destroy();
      expect(jest.getTimerCount()).toBe(0);
    });

    it("re-arms when the limit changes, and is off at 0", async () => {
      jest.useFakeTimers({ now: Date.now() });
      liveConfig({ "moderation.raid.lockdown_max_minutes": 10 });
      const service = RaidProtectionService.getInstance(client);
      await service.initialize();
      await service.setLockdown(guild, true, "mod-1");
      liveConfig({ "moderation.raid.lockdown_max_minutes": 0 });
      await reloadCallbacks[0]();
      expect(jest.getTimerCount()).toBe(0);

      liveConfig({ "moderation.raid.lockdown_max_minutes": 5 });
      await reloadCallbacks[0]();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(6 * 60 * 1000);
      expect(rowsWith("raid_clear")).toHaveLength(1);
      service.destroy();
    });

    it("arms a timer for a restored lockdown", async () => {
      jest.useFakeTimers({ now: Date.now() });
      liveConfig({ "moderation.raid.lockdown_max_minutes": 10 });
      mockFindOne.mockReturnValue({
        sort: () => ({
          lean: () => ({
            exec: async () => ({
              action: "raid_lockdown",
              createdAt: new Date(),
              moderatorId: "mod-1",
              reason: "Manual",
            }),
          }),
        }),
      });
      RaidProtectionService.reset();
      const service = RaidProtectionService.getInstance(client);
      await service.initialize();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(11 * 60 * 1000);
      expect(rowsWith("raid_clear")).toHaveLength(1);
      service.destroy();
    });
  });

  describe("late startup restoration", () => {
    it("is ignored once the bounded wait has failed open", async () => {
      jest.useFakeTimers();
      RaidProtectionService.reset();
      let resolveFind: (row: unknown) => void = () => undefined;
      mockFindOne.mockReturnValue({
        sort: () => ({
          lean: () => ({
            exec: () => new Promise((resolve) => (resolveFind = resolve)),
          }),
        }),
      });
      const service = RaidProtectionService.getInstance(client);
      const init = service.initialize();
      const pending = service.handleMemberJoin(makeMember().member);
      await jest.advanceTimersByTimeAsync(INIT_WAIT_MS + 1);
      expect(await pending).toBe(false);

      // The restore finally answers with an old, open lockdown.
      resolveFind({
        action: "raid_lockdown",
        createdAt: new Date(),
        moderatorId: "mod-1",
        reason: "Manual",
      });
      await init;
      expect((await service.getStatus(guild)).lockdown).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("ignoring a lockdown restored after"),
      );
      const next = makeMember();
      expect(await service.handleMemberJoin(next.member)).toBe(false);
    });
  });

  describe("lifecycle and queue limits", () => {
    it("destroy() unregisters the config callbacks and a recreated service registers once", async () => {
      const service = RaidProtectionService.getInstance(client);
      await service.initialize();
      expect(reloadCallbacks).toHaveLength(1);
      expect(changeListeners).toHaveLength(1);
      service.destroy();
      expect(reloadCallbacks).toHaveLength(0);
      expect(changeListeners).toHaveLength(0);
      // A destroyed instance no longer reacts to saves.
      await service.initialize();
      expect(reloadCallbacks).toHaveLength(1);
      service.destroy();
    });

    it("never sheds a lockdown or clear row when the unwritten-row queue overflows", async () => {
      const delays = ROW_RETRY_DELAYS_MS.splice(0);
      try {
        const service = RaidProtectionService.getInstance(client);
        mockCreate.mockRejectedValue(new Error("db down"));
        await service.setLockdown(guild, true, "mod-1");
        for (let i = 0; i < MAX_PENDING_ROWS + 20; i++) {
          await service.handleMemberJoin(makeMember().member);
        }
        mockCreate.mockClear();
        mockCreate.mockResolvedValue({});
        const status = await service.getStatus(guild);
        expect(status.unrecorded).toBe(0);
        const actions = mockCreate.mock.calls.map((c) => c[0].action);
        expect(actions).toHaveLength(MAX_PENDING_ROWS);
        expect(actions[0]).toBe("raid_lockdown");
      } finally {
        ROW_RETRY_DELAYS_MS.push(...delays);
      }
    });
  });

  describe("idempotent log rows", () => {
    it("gives each queued row one stable _id, increasing in queue order", async () => {
      const service = RaidProtectionService.getInstance(client);
      mockCreate
        .mockRejectedValueOnce(new Error("blip"))
        .mockRejectedValueOnce(new Error("blip"))
        .mockResolvedValue({});
      await service.setLockdown(guild, true, "mod-1");
      await service.setLockdown(guild, false, "mod-1");
      const calls = mockCreate.mock.calls.map((c) => c[0]);
      // First row: three attempts, all with the same _id.
      expect(calls[0]._id).toBe(calls[1]._id);
      expect(calls[1]._id).toBe(calls[2]._id);
      const first = String(calls[0]._id);
      const second = String(calls[3]._id);
      expect(second > first).toBe(true);
      expect(calls[0].createdAt).toBe(calls[2].createdAt);
    });

    it("writes exactly one row when an attempt committed but its reply was lost", async () => {
      const store = new Map<string, Record<string, unknown>>();
      let first = true;
      mockCreate.mockImplementation(async (row) => {
        const id = String(row._id);
        if (store.has(id)) {
          throw Object.assign(new Error("E11000 duplicate key"), {
            code: 11000,
          });
        }
        store.set(id, row);
        if (first) {
          first = false;
          throw new Error("write concern timeout (but it was committed)");
        }
        return {};
      });
      const service = RaidProtectionService.getInstance(client);
      await service.setLockdown(guild, true, "mod-1");
      expect(store.size).toBe(1);
      expect((await service.getStatus(guild)).unrecorded).toBe(0);
    });

    it("treats a duplicate-key error on the fixed _id as written", async () => {
      mockCreate.mockRejectedValue(
        Object.assign(new Error("E11000"), { code: 11000 }),
      );
      const service = RaidProtectionService.getInstance(client);
      await service.setLockdown(guild, true, "mod-1");
      expect((await service.getStatus(guild)).unrecorded).toBe(0);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe("dry run counts like live mode", () => {
    type Case = [string, () => FakeMember, Record<string, unknown>];
    const cases: Case[] = [
      [
        "a member the bot cannot moderate",
        () => makeMember({ moderatable: false }),
        { "moderation.raid.lockdown_action": "timeout" },
      ],
      [
        "a member the bot cannot kick",
        () => makeMember({ kickable: false }),
        { "moderation.raid.lockdown_action": "kick" },
      ],
      [
        "a member the bot cannot manage",
        () => makeMember({ manageable: false }),
        {
          "moderation.raid.lockdown_action": "quarantine",
          "moderation.raid.quarantine_role_id": "q-ok",
        },
      ],
      [
        "a missing quarantine role",
        () => makeMember(),
        {
          "moderation.raid.lockdown_action": "quarantine",
          "moderation.raid.quarantine_role_id": "nope",
        },
      ],
      [
        "a quarantine role above the bot",
        () => makeMember(),
        {
          "moderation.raid.lockdown_action": "quarantine",
          "moderation.raid.quarantine_role_id": "q-high",
        },
      ],
    ];

    it.each(cases)(
      "%s is skipped, not counted as would-act, in both modes",
      async (_label, build, extra) => {
        roles.set("q-ok", { id: "q-ok", managed: false, editable: true });
        roles.set("q-high", { id: "q-high", managed: false, editable: false });
        const results: Array<{ skipped: number; wouldAction: number }> = [];
        for (const dryRun of [true, false]) {
          RaidProtectionService.reset();
          liveConfig({ ...extra, "moderation.raid.dry_run": dryRun });
          mockFindOne.mockReturnValue({
            sort: () => ({ lean: () => ({ exec: async () => null }) }),
          });
          const service = RaidProtectionService.getInstance(client);
          await service.initialize();
          await service.setLockdown(guild, true, "mod-1");
          await service.handleMemberJoin(build().member);
          const { counts } = await service.getStatus(guild);
          results.push({
            skipped: counts.skipped,
            wouldAction: counts.wouldAction,
          });
        }
        expect(results[0]).toEqual({ skipped: 1, wouldAction: 0 });
        expect(results[1]).toEqual(results[0]);
      },
    );

    it("still counts an allowed member as would-act in dry run", async () => {
      roles.set("q-ok", { id: "q-ok", managed: false, editable: true });
      liveConfig({
        "moderation.raid.dry_run": true,
        "moderation.raid.lockdown_action": "quarantine",
        "moderation.raid.quarantine_role_id": "q-ok",
      });
      const service = RaidProtectionService.getInstance(client);
      await service.setLockdown(guild, true, "mod-1");
      await service.handleMemberJoin(makeMember().member);
      const { counts } = await service.getStatus(guild);
      expect(counts).toMatchObject({ wouldAction: 1, skipped: 0 });
    });
  });

  describe("transition rows in the write queue", () => {
    it("keeps every lockdown/clear row, in order, when only transitions overflow the cap", async () => {
      const delays = ROW_RETRY_DELAYS_MS.splice(0);
      try {
        const service = RaidProtectionService.getInstance(client);
        mockCreate.mockRejectedValue(new Error("db down"));
        const pairs = Math.ceil(MAX_PENDING_ROWS / 2) + 5;
        for (let i = 0; i < pairs; i++) {
          await service.setLockdown(guild, true, "mod-1");
          await service.setLockdown(guild, false, "mod-1");
        }
        mockCreate.mockClear();
        mockCreate.mockResolvedValue({});
        await service.getStatus(guild);
        const actions = mockCreate.mock.calls.map((c) => c[0].action);
        expect(actions).toHaveLength(pairs * 2);
        expect(
          actions.every(
            (a, i) => a === (i % 2 ? "raid_clear" : "raid_lockdown"),
          ),
        ).toBe(true);
      } finally {
        ROW_RETRY_DELAYS_MS.push(...delays);
      }
    });

    it("resolves a transition write only after its own row was written, even behind a drain in flight", async () => {
      const service = RaidProtectionService.getInstance(client);
      const written: string[] = [];
      let release: () => void = () => undefined;
      mockCreate.mockImplementationOnce(
        (row) =>
          new Promise((resolve) => {
            release = () => {
              written.push(String(row.action));
              resolve({});
            };
          }),
      );
      mockCreate.mockImplementation(async (row) => {
        written.push(String(row.action));
        return {};
      });
      const starting = service.setLockdown(guild, true, "mod-1");
      await new Promise((r) => setTimeout(r, 0));
      let endedResolved = false;
      const ending = service
        .setLockdown(guild, false, "mod-2")
        .then((result) => {
          endedResolved = true;
          return result;
        });
      await new Promise((r) => setTimeout(r, 0));
      expect(endedResolved).toBe(false);
      release();
      await ending;
      expect(written).toEqual(["raid_lockdown", "raid_clear"]);
      await starting;
    });

    it("does not hang /raidmode when the database keeps failing", async () => {
      const service = RaidProtectionService.getInstance(client);
      mockCreate.mockRejectedValue(new Error("db down"));
      const results = await Promise.all([
        service.setLockdown(guild, true, "mod-1"),
        service.setLockdown(guild, false, "mod-2"),
      ]);
      expect(results.every((r) => typeof r.message === "string")).toBe(true);
      expect((await service.getStatus(guild)).unrecorded).toBeGreaterThan(0);
    });
  });

  describe("shutdown, ordering, transition cap and precedence", () => {
    it("destroy() releases joins waiting on a pending restore, and a late restore is a no-op", async () => {
      jest.useFakeTimers({ now: Date.now() });
      liveConfig({ "moderation.raid.lockdown_max_minutes": 10 });
      RaidProtectionService.reset();
      let resolveFind: (row: unknown) => void = () => undefined;
      mockFindOne.mockReturnValue({
        sort: () => ({
          lean: () => ({
            exec: () => new Promise((resolve) => (resolveFind = resolve)),
          }),
        }),
      });
      const service = RaidProtectionService.getInstance(client);
      const init = service.initialize();
      const waiting = service.handleMemberJoin(makeMember().member);
      await Promise.resolve();
      service.destroy();
      // The waiter is released without the 10s timeout.
      expect(await waiting).toBe(false);

      resolveFind({
        action: "raid_lockdown",
        createdAt: new Date(),
        moderatorId: "mod-1",
        reason: "Manual",
      });
      await init;
      expect(jest.getTimerCount()).toBe(0);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(
        mockLogger.warn.mock.calls.some((c) =>
          String(c[0]).includes("restored an active lockdown"),
        ),
      ).toBe(false);
    });

    it("decides concurrent on and off in call order, never losing the clear", async () => {
      const service = RaidProtectionService.getInstance(client);
      const [on, off] = await Promise.all([
        service.setLockdown(guild, true, "mod-1"),
        service.setLockdown(guild, false, "mod-2"),
      ]);
      expect(on.changed).toBe(true);
      expect(off).toMatchObject({ changed: true, message: "Lockdown is off." });
      expect((await service.getStatus(guild)).lockdown).toBe(false);
      expect(rowsWith("raid_clear")).toHaveLength(1);
    });

    it("decides concurrent off then on consistently too", async () => {
      const service = RaidProtectionService.getInstance(client);
      const [off, on] = await Promise.all([
        service.setLockdown(guild, false, "mod-2"),
        service.setLockdown(guild, true, "mod-1"),
      ]);
      expect(off).toMatchObject({
        changed: false,
        message: "Lockdown is not on.",
      });
      expect(on.changed).toBe(true);
      expect((await service.getStatus(guild)).lockdown).toBe(true);
    });

    it("refuses a new transition past the hard cap and keeps earlier rows in order", async () => {
      const delays = ROW_RETRY_DELAYS_MS.splice(0);
      try {
        const service = RaidProtectionService.getInstance(client);
        mockCreate.mockRejectedValue(new Error("db down"));
        for (let i = 0; i < MAX_PENDING_TRANSITIONS / 2; i++) {
          await service.setLockdown(guild, true, "mod-1");
          await service.setLockdown(guild, false, "mod-1");
        }
        const refused = await service.setLockdown(guild, true, "mod-1");
        expect(refused.changed).toBe(false);
        expect(refused.message).toMatch(/Cannot change lockdown/);
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.stringContaining("refused a lockdown change"),
        );
        mockCreate.mockClear();
        mockCreate.mockResolvedValue({});
        await service.getStatus(guild);
        const actions = mockCreate.mock.calls.map((c) => c[0].action);
        expect(actions).toHaveLength(MAX_PENDING_TRANSITIONS);
        expect(
          actions.every(
            (a, i) => a === (i % 2 ? "raid_clear" : "raid_lockdown"),
          ),
        ).toBe(true);
      } finally {
        ROW_RETRY_DELAYS_MS.push(...delays);
      }
    });

    describe("a young account during lockdown", () => {
      it.each([
        ["timeout", "kick", "kick"],
        ["kick", "timeout", "kick"],
        ["timeout", "timeout", "timeout"],
      ] as const)(
        "lockdown %s + new-account %s applies %s",
        async (lockdownAction, gateAction, expected) => {
          liveConfig({
            "moderation.raid.lockdown_action": lockdownAction,
            "moderation.raid.new_account_action": gateAction,
            "moderation.raid.min_account_age_hours": 24,
          });
          const service = RaidProtectionService.getInstance(client);
          await service.setLockdown(guild, true, "mod-1");
          const young = makeMember({ ageMs: HOUR });
          expect(await service.handleMemberJoin(young.member)).toBe(true);
          const called = {
            kick: young.kick.mock.calls.length,
            timeout: young.timeout.mock.calls.length,
          };
          expect(called.kick + called.timeout).toBe(1);
          expect(called[expected]).toBe(1);
          expect(rowsWith(expected).at(-1)?.reason).toMatch(/lockdown/);
        },
      );

      it("an old account during lockdown gets the lockdown action only", async () => {
        liveConfig({
          "moderation.raid.lockdown_action": "timeout",
          "moderation.raid.new_account_action": "kick",
          "moderation.raid.min_account_age_hours": 24,
        });
        const service = RaidProtectionService.getInstance(client);
        await service.setLockdown(guild, true, "mod-1");
        const old = makeMember({ ageMs: 48 * HOUR });
        await service.handleMemberJoin(old.member);
        expect(old.timeout).toHaveBeenCalled();
        expect(old.kick).not.toHaveBeenCalled();
      });
    });
  });

  describe("log row durability", () => {
    it("retries a failed write and records the row", async () => {
      mockCreate.mockRejectedValueOnce(new Error("blip")).mockResolvedValue({});
      await joinMany(4);
      expect(rowsWith("raid_lockdown")).toHaveLength(2);
      const status =
        await RaidProtectionService.getInstance(client).getStatus(guild);
      expect(status.unrecorded).toBe(0);
    });

    it("queues rows during an outage and writes them in order afterwards", async () => {
      const service = RaidProtectionService.getInstance(client);
      mockCreate.mockRejectedValue(new Error("db down"));
      await service.setLockdown(guild, true, "mod-1");
      await service.setLockdown(guild, false, "mod-1");
      expect((await service.getStatus(guild)).unrecorded).toBe(2);
      mockCreate.mockClear();

      mockCreate.mockResolvedValue({});
      const status = await service.getStatus(guild);
      expect(status.unrecorded).toBe(0);
      expect(mockCreate.mock.calls.map((c) => c[0].action)).toEqual([
        "raid_lockdown",
        "raid_clear",
      ]);
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
        expect(status.counts.skipped).toBe(2);
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
      expect(status.counts.failed).toBe(2);
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

    it("breaks a createdAt tie by _id, so a clear written after its lockdown wins", async () => {
      const at = new Date();
      const rows = [
        {
          _id: 1,
          action: "raid_lockdown",
          createdAt: at,
          moderatorId: "mod-1",
          reason: "Manual",
        },
        {
          _id: 2,
          action: "raid_clear",
          createdAt: at,
          moderatorId: "mod-1",
          reason: "Manual",
        },
      ];
      const sortSpy = jest.fn((spec: Record<string, 1 | -1>) => {
        const sorted = [...rows].sort((x, y) => {
          for (const [k, dir] of Object.entries(spec)) {
            const a = (x as Record<string, any>)[k];
            const b = (y as Record<string, any>)[k];
            const cmp = a instanceof Date ? a.getTime() - b.getTime() : a - b;
            if (cmp !== 0) return cmp * dir;
          }
          return 0;
        });
        return { lean: () => ({ exec: async () => sorted[0] }) };
      });
      mockFindOne.mockReturnValue({ sort: sortSpy });
      const service = RaidProtectionService.getInstance(client);
      await service.initialize();
      expect(sortSpy).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
      expect((await service.getStatus(guild)).lockdown).toBe(false);
    });

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

    it("warns once, with one shared timer, for a burst of joins during a slow restore", async () => {
      jest.useFakeTimers();
      RaidProtectionService.reset();
      const service = RaidProtectionService.getInstance(client);
      const pending = Array.from({ length: 6 }, () =>
        service.handleMemberJoin(makeMember().member),
      );
      await Promise.resolve();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(INIT_WAIT_MS + 1);
      await Promise.all(pending);
      const timeoutWarnings = mockLogger.warn.mock.calls.filter((c) =>
        String(c[0]).includes("did not finish"),
      );
      expect(timeoutWarnings).toHaveLength(1);
    });

    it("clears the shared wait timer when restoration finishes first", async () => {
      jest.useFakeTimers();
      RaidProtectionService.reset();
      const service = RaidProtectionService.getInstance(client);
      const pending = service.handleMemberJoin(makeMember().member);
      await Promise.resolve();
      await service.initialize();
      await pending;
      expect(jest.getTimerCount()).toBe(0);
      expect(
        mockLogger.warn.mock.calls.some((c) =>
          String(c[0]).includes("did not finish"),
        ),
      ).toBe(false);
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
