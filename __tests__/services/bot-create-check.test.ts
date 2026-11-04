/**
 * Can the bot create a channel or category here? (#1660) Discord is a fake
 * guild; the permission maths is discord.js's own `PermissionsBitField`, with a
 * channel's overwrites modelled by giving it its own effective bits.
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

const create = await import("../../src/services/bot-create-check.js");
const check = await import("../../src/services/bot-permission-check.js");

const P = PermissionFlagsBits;

interface FakeChannel {
  id: string;
  type: number;
  bits: bigint;
}

function makeClient(opts: {
  serverBits?: bigint;
  channels?: FakeChannel[];
  noMe?: boolean;
  guildUnreadable?: boolean;
  permissionsThrow?: boolean;
}): never {
  const channels = new Map((opts.channels ?? []).map((c) => [c.id, c]));
  const me = {
    permissions: new PermissionsBitField(opts.serverBits ?? 0n),
    permissionsIn: jest.fn((c: FakeChannel) => {
      if (opts.permissionsThrow) throw new Error("boom");
      return new PermissionsBitField(c.bits);
    }),
  };
  const guild = {
    id: "guild-1",
    members: {
      me: opts.noMe ? null : me,
      fetchMe: jest.fn(async () => {
        if (opts.noMe) throw new Error("unknown member");
        return me;
      }),
    },
    roles: { cache: new Map(), fetch: jest.fn(async () => new Map()) },
    channels: { cache: channels, fetch: jest.fn(async () => channels) },
  };
  return {
    guilds: {
      cache: new Map(opts.guildUnreadable ? [] : [["guild-1", guild]]),
      fetch: jest.fn(async () => {
        throw new Error("Discord is down");
      }),
    },
  } as never;
}

const direct = { call: async <T>(fn: () => Promise<T>): Promise<T> => fn() };
const category = (bits: bigint): FakeChannel => ({
  id: "cat-1",
  type: ChannelType.GuildCategory,
  bits,
});

beforeEach(() => {
  check.resetBotPermissionCache();
});

describe("canBotCreate", () => {
  it("is ok for a channel when the bot has Manage Channels", async () => {
    const client = makeClient({ serverBits: P.ManageChannels });
    expect(
      await create.canBotCreate(client, "guild-1", { kind: "channel" }, direct),
    ).toEqual({ ok: true });
  });

  it("is ok for a category when the bot has Manage Channels", async () => {
    const client = makeClient({ serverBits: P.ManageChannels });
    expect(
      await create.canBotCreate(
        client,
        "guild-1",
        { kind: "category" },
        direct,
      ),
    ).toEqual({ ok: true });
  });

  it("says why when the bot lacks Manage Channels server-wide", async () => {
    const client = makeClient({ serverBits: P.ViewChannel });
    expect(
      await create.canBotCreate(client, "guild-1", { kind: "channel" }, direct),
    ).toEqual({ ok: false, reason: create.CREATE_REASON.channel });
    check.resetBotPermissionCache();
    expect(
      await create.canBotCreate(
        client,
        "guild-1",
        { kind: "category" },
        direct,
      ),
    ).toEqual({ ok: false, reason: create.CREATE_REASON.category });
  });

  it("is ok under a parent that keeps Manage Channels", async () => {
    const client = makeClient({
      serverBits: P.ManageChannels,
      channels: [category(P.ManageChannels)],
    });
    expect(
      await create.canBotCreate(
        client,
        "guild-1",
        { kind: "channel", parentId: "cat-1" },
        direct,
      ),
    ).toEqual({ ok: true });
  });

  it("says why when only the parent category denies Manage Channels", async () => {
    const client = makeClient({
      serverBits: P.ManageChannels,
      channels: [category(P.ViewChannel)],
    });
    expect(
      await create.canBotCreate(
        client,
        "guild-1",
        { kind: "channel", parentId: "cat-1" },
        direct,
      ),
    ).toEqual({ ok: false, reason: create.CREATE_REASON.parent });
  });

  it("is ok for Administrator, which no overwrite takes away", async () => {
    // discord.js gives an administrator every bit in every channel.
    const client = makeClient({
      serverBits: P.Administrator,
      channels: [category(PermissionsBitField.All)],
    });
    expect(
      await create.canBotCreate(
        client,
        "guild-1",
        { kind: "channel", parentId: "cat-1" },
        direct,
      ),
    ).toEqual({ ok: true });
  });

  it("ignores a parent for a category, which has none", async () => {
    const client = makeClient({ serverBits: P.ManageChannels });
    expect(
      await create.canBotCreate(
        client,
        "guild-1",
        { kind: "category" },
        direct,
      ),
    ).toEqual({ ok: true });
  });

  it("answers unknown when the server cannot be read", async () => {
    const client = makeClient({ guildUnreadable: true });
    expect(
      await create.canBotCreate(client, "guild-1", { kind: "channel" }, direct),
    ).toEqual({ ok: "unknown" });
  });

  it("answers unknown when the bot's own membership cannot be read", async () => {
    const client = makeClient({ noMe: true });
    expect(
      await create.canBotCreate(client, "guild-1", { kind: "channel" }, direct),
    ).toEqual({ ok: "unknown" });
  });

  it("answers unknown when the parent is not found or is not a category", async () => {
    const client = makeClient({
      serverBits: P.ManageChannels,
      channels: [{ id: "text-1", type: ChannelType.GuildText, bits: 0n }],
    });
    for (const parentId of ["gone", "text-1"]) {
      check.resetBotPermissionCache();
      expect(
        await create.canBotCreate(
          client,
          "guild-1",
          { kind: "channel", parentId },
          direct,
        ),
      ).toEqual({ ok: "unknown" });
    }
  });

  it("answers unknown when the parent's permissions cannot be worked out", async () => {
    const client = makeClient({
      serverBits: P.ManageChannels,
      channels: [category(0n)],
      permissionsThrow: true,
    });
    expect(
      await create.canBotCreate(
        client,
        "guild-1",
        { kind: "channel", parentId: "cat-1" },
        direct,
      ),
    ).toEqual({ ok: "unknown" });
  });
});

describe("CREATE_REASON", () => {
  it("names the permission, where to fix it and the Bot permissions page", () => {
    for (const reason of Object.values(create.CREATE_REASON)) {
      expect(reason).toContain("Manage Channels");
      expect(reason).toContain("Bot permissions");
      expect(reason).not.toMatch(/[<>&]/);
    }
  });
});

describe("CREATE_REASON.parent", () => {
  it("sends the admin to the category's overwrites without naming one", () => {
    const line = create.CREATE_REASON.parent;
    // permissionsIn is the effective result of every overwrite, so the check
    // cannot say whether @everyone, a role or the bot itself denies it.
    expect(line).toContain("permission overwrites");
    expect(line).not.toMatch(
      /remove the deny|bot's role on|@everyone|member-specific/i,
    );
  });
});

describe("toPickerCreate", () => {
  it("sets ok for a possible creation", () => {
    expect(create.toPickerCreate("channel", { ok: true })).toEqual({
      kind: "channel",
      ok: true,
    });
  });

  it("carries the reason and the channel subtype when it is not possible", () => {
    expect(
      create.toPickerCreate("channel", { ok: false, reason: "why" }, "voice"),
    ).toEqual({
      kind: "channel",
      channelKind: "voice",
      ok: false,
      reason: "why",
    });
  });

  it("offers no create row, and no line, for unknown", () => {
    expect(
      create.toPickerCreate("category", { ok: "unknown" }),
    ).toBeUndefined();
  });
});

describe("canBotCreate for a role (#1618)", () => {
  it("is ok when the bot has Manage Roles, and ignores Manage Channels", async () => {
    const client = makeClient({ serverBits: P.ManageRoles });
    expect(
      await create.canBotCreate(client, "guild-1", { kind: "role" }, direct),
    ).toEqual({ ok: true });
  });

  it("is ok for Administrator, which holds every permission", async () => {
    const client = makeClient({ serverBits: P.Administrator });
    expect(
      await create.canBotCreate(client, "guild-1", { kind: "role" }, direct),
    ).toEqual({ ok: true });
  });

  it("says why without Manage Roles, even when the bot has Manage Channels", async () => {
    const client = makeClient({ serverBits: P.ManageChannels });
    expect(
      await create.canBotCreate(client, "guild-1", { kind: "role" }, direct),
    ).toEqual({ ok: false, reason: create.CREATE_REASON_ROLE });
    expect(create.CREATE_REASON_ROLE).toContain("Manage Roles");
    expect(create.CREATE_REASON_ROLE).toContain("Bot permissions");
  });

  it("answers unknown when the server cannot be read", async () => {
    const client = makeClient({ guildUnreadable: true });
    expect(
      await create.canBotCreate(client, "guild-1", { kind: "role" }, direct),
    ).toEqual({ ok: "unknown" });
  });

  it("gives the Picker a role flag, and none for unknown", () => {
    expect(create.toPickerCreate("role", { ok: true })).toEqual({
      kind: "role",
      ok: true,
    });
    expect(create.toPickerCreate("role", { ok: false, reason: "why" })).toEqual(
      { kind: "role", ok: false, reason: "why" },
    );
    expect(create.toPickerCreate("role", { ok: "unknown" })).toBeUndefined();
  });
});
