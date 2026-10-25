/**
 * The bot permission check for scheduled announcements and polls (#1481). Their
 * channel is stored on each schedule row, so the check reads the rows (a
 * `CheckDeps.scheduleRows` reader, stubbed here) and checks each channel in its
 * own channel with overwrites. Discord is a fake guild, as in
 * `bot-permission-check.test.ts`.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

let settings: Record<string, string | boolean> = {};
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBooleanStrict: jest.fn(async (key: string, d: boolean) =>
        key in settings ? settings[key] === true : d,
      ),
      getStringStrict: jest.fn(async (key: string, d: string) =>
        key in settings ? String(settings[key]) : d,
      ),
    }),
  },
}));

const check = await import("../../src/services/bot-permission-check.js");
const registry = await import("../../src/services/bot-permission-registry.js");
const rows = await import("../../src/services/schedule-posting-rows.js");
const { buildMatrix } = await import("../../src/web/bot-permissions-view.js");

const P = PermissionFlagsBits;
const BASE = P.ViewChannel | P.SendMessages;
const POLLS = BASE | P.SendPolls;
const EVERYTHING = POLLS | P.EmbedLinks | P.MentionEveryone;

interface FakeChannel {
  id: string;
  name: string;
  bits: bigint;
  type?: number;
}
const text = (id: string, bitsHeld: bigint = EVERYTHING): FakeChannel => ({
  id,
  name: `chan-${id}`,
  bits: bitsHeld,
  type: ChannelType.GuildText,
});

function makeClient(
  channels: FakeChannel[],
  roles: Array<{ id: string; mentionable: boolean }> = [],
): never {
  const channelMap = new Map(channels.map((c) => [c.id, c] as const));
  const roleMap = new Map(
    roles.map((r) => [r.id, { name: r.id, position: 1, ...r }] as const),
  );
  const me = {
    permissions: new PermissionsBitField(0n),
    permissionsIn: (c: FakeChannel) => new PermissionsBitField(c.bits),
    roles: { highest: { position: 10 }, botRole: null },
  };
  const guild = {
    id: "guild-1",
    members: { me, fetchMe: async () => me },
    roles: { cache: roleMap, fetch: async () => roleMap },
    channels: { cache: channelMap, fetch: async () => channelMap },
  };
  return {
    guilds: {
      cache: new Map([["guild-1", guild]]),
      fetch: async () => guild,
    },
  } as never;
}

type Row = import("../../src/services/schedule-posting-rows.js").ScheduleRow;
const row = (channelId: string, extra: Partial<Row> = {}): Row => ({
  channelId,
  embed: false,
  everyone: false,
  roleIds: [],
  ...extra,
});

let reader: jest.Mock<(guildId: string, source: string) => Promise<Row[]>>;
let announcementRows: Row[];
let pollRows: Row[];

async function run(
  channels: FakeChannel[],
  roles: Array<{ id: string; mentionable: boolean }> = [],
  now?: () => number,
): Promise<Awaited<ReturnType<typeof check.checkBotPermissions>>> {
  return check.checkBotPermissions(makeClient(channels, roles), "guild-1", {
    call: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    roleGroupCount: async () => 0,
    scheduleRows: reader as never,
    ...(now ? { now } : {}),
  });
}

const SCHEDULE_IDS = [
  "announcements-post",
  "announcements-embed",
  "announcements-mentions",
  "polls-post",
  "polls-mentions",
];
const entry = (
  report: Awaited<ReturnType<typeof run>>,
  id: string,
): Array<{
  outcome: string;
  missing: string[];
  enabled: boolean;
  id: string;
}> =>
  report.checks
    .filter((c) => c.feature.id === id)
    .map((c) => ({
      outcome: c.outcome,
      missing: c.missing,
      enabled: c.enabled,
      id: c.target?.id ?? "",
    }));

beforeEach(() => {
  settings = {};
  announcementRows = [];
  pollRows = [];
  reader = jest.fn(async (_guild: string, source: string) =>
    source === "polls" ? pollRows : announcementRows,
  );
  check.resetBotPermissionCache();
});

describe("registry entries for schedules", () => {
  it("has no target setting, a schedules source, and names the permissions the code calls", () => {
    const shape = (id: string): unknown => {
      const r = registry.FEATURE_REQUIREMENTS.find((x) => x.id === id);
      return {
        scope: r?.scope,
        type: r?.targetType,
        targetKey: r?.targetKey,
        source: r?.schedules,
        when: r?.scheduleWhen,
        needs: r?.needs.map((n) => n.name),
      };
    };
    expect(shape("announcements-post")).toEqual({
      scope: "channel",
      type: "guild-text",
      targetKey: undefined,
      source: "announcements",
      when: undefined,
      needs: ["View Channel", "Send Messages"],
    });
    expect(shape("announcements-embed")).toMatchObject({
      when: "embed",
      needs: ["Embed Links"],
    });
    expect(shape("announcements-mentions")).toMatchObject({
      when: "mentions",
      needs: ["Mention @everyone, @here and All Roles"],
    });
    expect(shape("polls-post")).toMatchObject({
      source: "polls",
      needs: ["View Channel", "Send Messages", "Send Polls"],
    });
    expect(shape("polls-mentions")).toMatchObject({
      source: "polls",
      when: "mentions",
    });
  });
});

describe("mentionsIn", () => {
  it.each([
    ["plain text", "Hello team", false, []],
    ["@everyone", "Hi @everyone!", true, []],
    ["@here", "ping @here now", true, []],
    ["a role", "Hi <@&123>", false, ["123"]],
    ["a role twice and another", "<@&1> <@&1> <@&2>", false, ["1", "2"]],
    ["a user is not a ping that needs it", "Hi <@123>", false, []],
    ["a word that only starts like it", "mail@everyone.example", true, []],
  ])("%s", (_name, textIn, everyone, roleIds) => {
    expect(rows.mentionsIn(textIn)).toEqual({ everyone, roleIds });
  });
});

describe("when the entries are in use", () => {
  it("reads nothing and records the entries as off while both features are off", async () => {
    announcementRows = [row("a")];
    const report = await run([text("a")]);
    expect(reader).not.toHaveBeenCalled();
    for (const id of SCHEDULE_IDS) {
      expect(entry(report, id)).toEqual([
        { outcome: "unchecked", missing: [], enabled: false, id: "" },
      ]);
    }
    // The server-wide ticket entries are quiet here (the fake bot holds nothing
    // server-wide); none of them is a schedule entry.
    expect(
      report.quiet.filter((q) => SCHEDULE_IDS.includes(q.feature.id)),
    ).toEqual([]);
    expect(report.notes).toEqual([]);
  });

  it("reads only the source whose feature is on", async () => {
    settings = { "announcements.enabled": true };
    await run([]);
    expect(reader.mock.calls.map((c) => c[1])).toEqual(["announcements"]);
  });

  it("treats an enabled feature with no schedule as not in use, with no note", async () => {
    settings = { "announcements.enabled": true, "polls.enabled": true };
    const report = await run([]);
    for (const id of SCHEDULE_IDS) {
      expect(entry(report, id).every((e) => !e.enabled)).toBe(true);
    }
    expect(report.notes).toEqual([]);
    expect(report.problems).toEqual([]);
    expect(report.unknown).toEqual([]);
  });
});

describe("scheduled announcements", () => {
  beforeEach(() => {
    settings = { "announcements.enabled": true };
  });

  it("is fine when the bot can post in each channel", async () => {
    announcementRows = [row("a"), row("b")];
    const report = await run([text("a", BASE), text("b", BASE)]);
    expect(report.problems).toEqual([]);
    expect(report.okFeatures.map((f) => f.id)).toEqual(["announcements-post"]);
    expect(entry(report, "announcements-post")).toHaveLength(2);
  });

  it("never reports a channel whose overwrite denies Send Messages as fine", async () => {
    announcementRows = [row("a")];
    const report = await run([text("a", P.ViewChannel)]);
    expect(report.okFeatures).toEqual([]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0].permission).toBe("Send Messages");
    expect(report.problems[0].target).toMatchObject({
      kind: "channel",
      id: "a",
      name: "chan-a",
    });
  });

  it("names the one channel that lacks it and does not list the entry as fine", async () => {
    announcementRows = [row("a"), row("b")];
    const report = await run([text("a", BASE), text("b", P.ViewChannel)]);
    expect(report.problems.map((p) => p.target.id)).toEqual(["b"]);
    expect(report.okFeatures).toEqual([]);
    expect(entry(report, "announcements-post").map((e) => e.outcome)).toEqual([
      "ok",
      "missing",
    ]);
  });

  it("checks two schedules in one channel once", async () => {
    announcementRows = [row("a"), row("a")];
    const report = await run([text("a", BASE)]);
    expect(entry(report, "announcements-post")).toHaveLength(1);
  });

  it("asks for Embed Links only in channels with an embed", async () => {
    announcementRows = [row("a", { embed: true }), row("b")];
    const report = await run([text("a", BASE), text("b", BASE)]);
    expect(entry(report, "announcements-embed")).toEqual([
      { outcome: "missing", missing: ["Embed Links"], enabled: true, id: "a" },
    ]);
    expect(report.problems.map((p) => [p.permission, p.target.id])).toEqual([
      ["Embed Links", "a"],
    ]);
  });

  it("does not ask for Embed Links when no schedule has an embed", async () => {
    announcementRows = [row("a")];
    const report = await run([text("a", BASE)]);
    expect(entry(report, "announcements-embed")).toEqual([
      { outcome: "unchecked", missing: [], enabled: false, id: "" },
    ]);
  });

  it("asks for Mention Everyone for @everyone, @here, and a role members cannot mention", async () => {
    announcementRows = [
      row("a", { everyone: true }),
      row("b", { roleIds: ["locked"] }),
      row("c", { roleIds: ["open"] }),
    ];
    const report = await run(
      [text("a", BASE), text("b", BASE), text("c", BASE)],
      [
        { id: "locked", mentionable: false },
        { id: "open", mentionable: true },
      ],
    );
    expect(entry(report, "announcements-mentions").map((e) => e.id)).toEqual([
      "a",
      "b",
    ]);
    expect(report.problems.map((p) => p.permission)).toEqual([
      "Mention @everyone, @here and All Roles",
      "Mention @everyone, @here and All Roles",
    ]);
  });

  it("is fine for a ping when the bot holds Mention Everyone in the channel", async () => {
    announcementRows = [row("a", { everyone: true })];
    const report = await run([text("a", BASE | P.MentionEveryone)]);
    expect(report.problems).toEqual([]);
    expect(report.okFeatures.map((f) => f.id)).toEqual([
      "announcements-post",
      "announcements-mentions",
    ]);
  });

  it("says a ping could not be checked when the pinged role is gone and the bot lacks the permission", async () => {
    announcementRows = [row("a", { roleIds: ["gone"] })];
    const report = await run([text("a", BASE)]);
    expect(report.problems).toEqual([]);
    expect(report.unknown.map((u) => u.feature.id)).toEqual([
      "announcements-mentions",
    ]);
    expect(report.unknown[0].note).toMatch(/role/);
  });

  it.each([
    ["a voice channel", ChannelType.GuildVoice],
    ["an announcement channel", ChannelType.GuildAnnouncement],
    ["a forum", ChannelType.GuildForum],
  ])(
    "does not report %s as fine (the service accepts a text channel only)",
    async (_n, type) => {
      announcementRows = [row("a")];
      const report = await run([{ ...text("a", BASE), type }]);
      expect(report.okFeatures).toEqual([]);
      expect(report.unknown.map((u) => u.feature.id)).toEqual([
        "announcements-post",
      ]);
    },
  );

  it("says so when the channel is gone", async () => {
    announcementRows = [row("deleted")];
    const report = await run([]);
    expect(report.okFeatures).toEqual([]);
    expect(report.unknown[0].note).toMatch(/could not be found/);
  });
});

describe("scheduled polls", () => {
  beforeEach(() => {
    settings = { "polls.enabled": true };
  });

  it("needs Send Polls as well as View Channel and Send Messages", async () => {
    pollRows = [row("p")];
    const report = await run([text("p", BASE)]);
    expect(report.problems.map((p) => p.permission)).toEqual(["Send Polls"]);
    check.resetBotPermissionCache();
    const ok = await run([text("p", POLLS)]);
    expect(ok.problems).toEqual([]);
    expect(ok.okFeatures.map((f) => f.id)).toEqual(["polls-post"]);
  });

  it("asks for Mention Everyone only for a role that members cannot mention", async () => {
    pollRows = [row("p", { roleIds: ["locked"] })];
    const locked = await run(
      [text("p", POLLS)],
      [{ id: "locked", mentionable: false }],
    );
    expect(locked.problems.map((p) => p.feature)).toBeDefined();
    expect(entry(locked, "polls-mentions")).toEqual([
      {
        outcome: "missing",
        missing: ["Mention @everyone, @here and All Roles"],
        enabled: true,
        id: "p",
      },
    ]);
    check.resetBotPermissionCache();
    const open = await run(
      [text("p", POLLS)],
      [{ id: "locked", mentionable: true }],
    );
    expect(open.problems).toEqual([]);
  });

  it("does not check the announcement entries", async () => {
    pollRows = [row("p")];
    const report = await run([text("p", POLLS)]);
    expect(entry(report, "announcements-post")[0].enabled).toBe(false);
  });
});

describe("one channel for announcements and polls", () => {
  it("lists a shared missing permission once, with both features", async () => {
    settings = { "announcements.enabled": true, "polls.enabled": true };
    announcementRows = [row("a")];
    pollRows = [row("a")];
    const report = await run([text("a", P.ViewChannel)]);
    const send = report.problems.filter(
      (p) => p.permission === "Send Messages",
    );
    expect(send).toHaveLength(1);
    expect(send[0].features.map((f) => f.id)).toEqual([
      "announcements-post",
      "polls-post",
    ]);
  });
});

describe("when the schedules cannot be read", () => {
  it("marks those entries unknown and keeps the rest of the page", async () => {
    settings = { "announcements.enabled": true, "polls.enabled": true };
    pollRows = [row("p")];
    reader.mockImplementation(async (_g: string, source: string) => {
      if (source === "announcements") throw new Error("mongo down");
      return pollRows;
    });
    const report = await run([text("p", POLLS)]);
    expect(report.available).toBe(true);
    expect(report.unknown.map((u) => u.feature.id).sort()).toEqual([
      "announcements-embed",
      "announcements-mentions",
      "announcements-post",
    ]);
    expect(report.okFeatures.map((f) => f.id)).toEqual(["polls-post"]);
  });
});

describe("the read is kept with the rest", () => {
  it("reads each source once per check and reuses it until the cache runs out", async () => {
    settings = { "announcements.enabled": true };
    announcementRows = [row("a")];
    let t = 1_000;
    await run([text("a", BASE)], [], () => t);
    expect(reader).toHaveBeenCalledTimes(1);
    t += check.SNAPSHOT_TTL_MS - 1;
    await run([text("a", BASE)], [], () => t);
    expect(reader).toHaveBeenCalledTimes(1);
    t += 2;
    await run([text("a", BASE)], [], () => t);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("forgets it with resetBotPermissionCache", async () => {
    settings = { "announcements.enabled": true };
    await run([]);
    check.resetBotPermissionCache();
    await run([]);
    expect(reader).toHaveBeenCalledTimes(2);
  });
});

describe("the matrix", () => {
  it("lists Mention Everyone and Send Polls as checked where a schedule uses them", async () => {
    settings = { "announcements.enabled": true, "polls.enabled": true };
    announcementRows = [row("a", { everyone: true })];
    pollRows = [row("p")];
    const report = await run([text("a", BASE), text("p", POLLS)]);
    const matrix = buildMatrix(report);
    const mention = matrix.find((m) => m.label.startsWith("Mention"));
    expect(mention?.status).toBe("missing");
    const polls = matrix.find((m) => m.label === "Send Polls");
    expect(polls?.status).toBe("has");
    // No schedule has an embed, so Embed Links is not shown as needed.
    expect(matrix.find((m) => m.label === "Embed Links")?.status).not.toBe(
      "has",
    );
  });
});
