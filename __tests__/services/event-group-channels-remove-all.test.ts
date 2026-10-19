import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { DiscordAPIError, RateLimitError } from "discord.js";

/**
 * `EventGroupChannels.removeAllGroupChannels` (#1243), the host's "groups off":
 * every group channel is deleted and the event's `groupsEnabled` is stored in
 * one hold of the per-event channel lock, with the invariant that the flag is
 * never stored off while a group still has a recorded channel. Driven with a
 * fake Discord REST client and the in-memory Event stand-in (which throws on a
 * filter or update shape it does not know); the real shapes are proven against
 * MongoDB in
 * `__tests__/integration/event-live-edit-groups-switch.integration.test.ts`.
 * Also covers the end-hold recheck that `removeGroup` gained right before its
 * record write.
 */

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  store,
  writes,
  fake,
  EventMock,
  type Json,
} from "./event-live-edit-groups-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
}));

const { EventGroupChannels } =
  await import("../../src/services/event-group-channels.js");
const { getRenameQueue } =
  await import("../../src/services/event-rename-queue.js");

const GUILD = "111111111111111111";
const EV = "65a000000000000000000001";
const BOT = "999999999999999999";
const A = "g_00000001";
const B = "g_00000002";
const C = "g_00000003";
const A_CH = "200000000000000001";
const B_CH = "200000000000000002";
const MAIN = "200000000000000009";

function apiError(code: number, status = 400): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: "x" },
    code,
    status,
    "DELETE",
    "/",
    {},
  );
}

function seed(over: Json = {}): void {
  store.set(EV, {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    channelId: MAIN,
    groups: [
      {
        key: A,
        name: "Alpha",
        kind: "team",
        size: null,
        tag: "",
        marker: "",
        channelId: A_CH,
        captainId: "u1",
        memberIds: ["u1", "u2"],
      },
      {
        key: B,
        name: "Bravo",
        kind: "leads",
        size: null,
        tag: "",
        marker: "",
        channelId: B_CH,
        captainId: null,
        memberIds: [],
      },
      {
        key: C,
        name: "Charlie",
        kind: "open",
        size: null,
        tag: "",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: ["u3"],
      },
    ],
    ...over,
  });
}
const doc = (): Json => store.get(EV) as Json;
const groups = (): Json[] => doc().groups as Json[];
const channelIds = (): unknown[] => groups().map((g) => g.channelId);

function makeEnv(
  opts: {
    eventsEnabled?: boolean | (() => Promise<boolean>);
    members?: Record<string, string[]>;
    channelType?: number;
  } = {},
) {
  const members = new Map<string, Set<string>>(
    Object.entries(opts.members ?? {}).map(([c, ids]) => [c, new Set(ids)]),
  );
  const gone = new Set<string>();
  const calls: string[] = [];
  const failures: {
    delete?: (id: string) => unknown;
    fetch?: (id: string) => unknown;
  } = {};
  const voice = (id: string) => ({
    id,
    guildId: GUILD,
    type: opts.channelType ?? 2,
    get members() {
      return new Map([...(members.get(id) ?? [])].map((u) => [u, { id: u }]));
    },
  });
  const cache = new Map<string, unknown>(
    [A_CH, B_CH].map((id) => [id, voice(id)]),
  );
  const rest = {
    delete: jest.fn(async (route: string) => {
      const id = /channels\/(\d+)$/.exec(route)?.[1] ?? "";
      calls.push(`delete ${id}`);
      const failure = failures.delete?.(id);
      if (failure) throw failure;
      if (gone.has(id)) throw apiError(10003, 404);
      gone.add(id);
      cache.delete(id);
      return {};
    }),
  };
  const guild = {
    id: GUILD,
    channels: {
      cache,
      fetch: jest.fn(async (id: string) => {
        calls.push(`fetch ${id}`);
        const failure = failures.fetch?.(id);
        if (failure) throw failure;
        if (gone.has(id)) throw apiError(10003, 404);
        return voice(id);
      }),
    },
  };
  const enabled = opts.eventsEnabled ?? true;
  const channels = new EventGroupChannels(
    { user: { id: BOT }, token: "t" } as never,
    {
      getPrefix: async () => "📅",
      getGraceMs: async () => 0,
      isEnabled: typeof enabled === "function" ? enabled : async () => enabled,
    },
    {
      rest: rest as never,
      call: ((fn: (s: AbortSignal) => Promise<unknown>) =>
        fn(new AbortController().signal)) as never,
      paceMs: 0,
    },
  );
  return {
    channels,
    guild: guild as never,
    rest,
    members,
    gone,
    calls,
    failures,
    cache,
  };
}

beforeEach(() => {
  store.clear();
  writes.length = 0;
  fake.beforeWrite = null;
  fake.failReads = false;
  fake.afterFind = null;
  fake.extraSettable = new Set(["groupsEnabled"]);
  getRenameQueue().forget(A_CH);
  getRenameQueue().forget(B_CH);
  seed();
});

describe("removeAllGroupChannels switches the groups off", () => {
  it("deletes every channel on the fail-fast client, clears each recorded id, and only then stores the flag", async () => {
    const env = makeEnv();
    const out = await env.channels.removeAllGroupChannels(EV, env.guild, {});
    expect(out).toEqual({ status: "off", deleted: 2 });
    expect(env.calls).toEqual([
      `fetch ${A_CH}`,
      `fetch ${B_CH}`,
      `delete ${A_CH}`,
      `delete ${B_CH}`,
    ]);
    expect(env.rest.delete.mock.calls[0][0]).toBe(`/channels/${A_CH}`);
    expect(doc().groupsEnabled).toBe(false);
    expect(channelIds()).toEqual([null, null, null]);
    // The groups are history: records, members and leaders stay.
    expect(groups().map((g) => g.key)).toEqual([A, B, C]);
    expect(groups().map((g) => g.memberIds)).toEqual([
      ["u1", "u2"],
      [],
      ["u3"],
    ]);
    expect(groups()[0].captainId).toBe("u1");
    // Positional channel-id clears, then ONE flag write, conditional on no
    // group having a recorded channel any more.
    expect(writes.map((w) => w.update)).toEqual([
      { $set: { "groups.$.channelId": null } },
      { $set: { "groups.$.channelId": null } },
      { $set: { groupsEnabled: false } },
    ]);
    expect(writes[0].filter).toEqual({
      _id: EV,
      groups: { $elemMatch: { key: A, channelId: A_CH } },
    });
    expect(writes[2].filter).toEqual({
      _id: EV,
      state: { $in: ["scheduled", "active"] },
      groupsEnabled: true,
      $nor: [
        {
          groups: {
            $elemMatch: { channelId: { $type: "string", $ne: "" } },
          },
        },
      ],
    });
  });

  it("an event with no channel yet is switched off with no Discord request", async () => {
    seed({
      groups: (store.get(EV)!.groups as Json[]).map((g) => ({
        ...g,
        channelId: null,
      })),
    });
    const env = makeEnv();
    expect(
      await env.channels.removeAllGroupChannels(EV, env.guild, {}),
    ).toEqual({
      status: "off",
      deleted: 0,
    });
    expect(env.calls).toEqual([]);
    expect(doc().groupsEnabled).toBe(false);
  });

  it("looks at every channel before it deletes any: one with somebody in it keeps all of them", async () => {
    const env = makeEnv({ members: { [B_CH]: ["u5", "u6"] } });
    const out = await env.channels.removeAllGroupChannels(EV, env.guild, {});
    expect(out).toEqual({ status: "occupied", remaining: 2, groupKey: B });
    expect(env.rest.delete).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(doc().groupsEnabled).toBe(true);
    expect(channelIds()).toEqual([A_CH, B_CH, null]);
  });

  it("people known to have left (the cache may still show them) do not hold a channel", async () => {
    const env = makeEnv({ members: { [A_CH]: ["u1"], [B_CH]: ["u5"] } });
    const out = await env.channels.removeAllGroupChannels(EV, env.guild, {
      ignore: new Set(["u1", "u5"]),
    });
    expect(out).toEqual({ status: "off", deleted: 2 });
  });

  it("a channel that cannot be read keeps every channel: nothing is deleted", async () => {
    const env = makeEnv();
    env.failures.fetch = (id) => (id === B_CH ? apiError(50013, 403) : null);
    const out = await env.channels.removeAllGroupChannels(EV, env.guild, {});
    expect(out.status).toBe("failed");
    expect((out as { reason: string }).reason).toContain(
      'the channel of "Bravo" could not be checked',
    );
    expect((out as { deleted: number }).deleted).toBe(0);
    expect(env.rest.delete).not.toHaveBeenCalled();
    expect(doc().groupsEnabled).toBe(true);
  });

  it("a channel Discord says is already gone counts as deleted", async () => {
    const env = makeEnv();
    env.gone.add(A_CH);
    const out = await env.channels.removeAllGroupChannels(EV, env.guild, {});
    expect(out).toEqual({ status: "off", deleted: 2 });
    expect(channelIds()).toEqual([null, null, null]);
    // Only the channel that still existed was deleted.
    expect(env.rest.delete).toHaveBeenCalledTimes(1);
  });

  it("a channel that vanishes between the look and the delete (10003) counts as deleted too", async () => {
    const env = makeEnv();
    env.failures.delete = (id) => (id === A_CH ? apiError(10003, 404) : null);
    const out = await env.channels.removeAllGroupChannels(EV, env.guild, {});
    expect(out).toEqual({ status: "off", deleted: 2 });
    expect(channelIds()).toEqual([null, null, null]);
    expect(doc().groupsEnabled).toBe(false);
  });

  it("an id that is no longer a voice channel is not ours to delete: only the record goes", async () => {
    const env = makeEnv({ channelType: 4 });
    const out = await env.channels.removeAllGroupChannels(EV, env.guild, {});
    expect(out).toEqual({ status: "off", deleted: 2 });
    expect(env.rest.delete).not.toHaveBeenCalled();
    expect(channelIds()).toEqual([null, null, null]);
  });

  describe("a delete failing halfway", () => {
    it("stops, says how many are gone, keeps the flag, and the scan does not re-create what was deleted", async () => {
      const env = makeEnv();
      env.failures.delete = (id) =>
        id === B_CH ? new RateLimitError({ timeToReset: 5000 } as never) : null;
      const out = await env.channels.removeAllGroupChannels(EV, env.guild, {});
      expect(out.status).toBe("failed");
      expect((out as { deleted: number }).deleted).toBe(1);
      // The first channel is gone and its id cleared; the flag is NOT stored
      // while another group still has a channel.
      expect(doc().groupsEnabled).toBe(true);
      expect(channelIds()).toEqual([null, B_CH, null]);
      expect(writes.map((w) => w.update)).toEqual([
        { $set: { "groups.$.channelId": null } },
      ]);
      // The scan's pass would create a channel for the group that has none: the
      // hold set for the switch keeps it from doing so.
      const report = await env.channels.reconcile({ _id: EV }, env.guild);
      expect(report.created).toBe(0);
      expect(report.failures.map((f) => [f.key, f.reason])).toEqual([
        [
          A,
          "The groups are being switched off. Save the switch again to finish.",
        ],
        [
          C,
          "The groups are being switched off. Save the switch again to finish.",
        ],
      ]);
    });

    it("a second try finishes the job", async () => {
      const env = makeEnv();
      let failB = true;
      env.failures.delete = (id) =>
        id === B_CH && failB ? apiError(500, 500) : null;
      const first = await env.channels.removeAllGroupChannels(
        EV,
        env.guild,
        {},
      );
      expect(first.status).toBe("failed");
      failB = false;
      const second = await env.channels.removeAllGroupChannels(
        EV,
        env.guild,
        {},
      );
      expect(second).toEqual({ status: "off", deleted: 1 });
      expect(doc().groupsEnabled).toBe(false);
      expect(channelIds()).toEqual([null, null, null]);
    });

    it("somebody joining a channel after the first was deleted fails with what is gone", async () => {
      const env = makeEnv();
      // B is empty when read, and occupied when its delete is about to be sent.
      env.failures.delete = (id) => {
        if (id === A_CH) {
          env.members.set(B_CH, new Set(["u7"]));
        }
        return null;
      };
      const out = await env.channels.removeAllGroupChannels(EV, env.guild, {});
      expect(out).toEqual({
        status: "failed",
        reason: "1 person joined a group channel",
        deleted: 1,
      });
      expect(doc().groupsEnabled).toBe(true);
    });

    it("somebody joining the first channel before any delete is occupied, not failed", async () => {
      const env = makeEnv();
      // Joined between the look at the channels and the first delete.
      const original = env.guild as unknown as {
        channels: { fetch: (id: string) => Promise<unknown> };
      };
      const fetch = original.channels.fetch;
      let fetched = 0;
      original.channels.fetch = async (id: string) => {
        const channel = await fetch(id);
        if (++fetched === 2) env.members.set(A_CH, new Set(["u8"]));
        return channel;
      };
      const out = await env.channels.removeAllGroupChannels(EV, env.guild, {});
      expect(out).toEqual({ status: "occupied", remaining: 1, groupKey: A });
      expect(env.rest.delete).not.toHaveBeenCalled();
      expect(doc().groupsEnabled).toBe(true);
    });
  });

  describe("the end hold", () => {
    it("asked right before each delete: nothing is deleted when an end holds the event", async () => {
      const env = makeEnv();
      const out = await env.channels.removeAllGroupChannels(EV, env.guild, {
        ending: () => true,
      });
      expect(out).toEqual({
        status: "failed",
        reason: "the event is being ended",
        deleted: 0,
      });
      expect(env.rest.delete).not.toHaveBeenCalled();
      expect(doc().groupsEnabled).toBe(true);
    });

    it("asked once more right before the flag is stored: it stays on, with the deleted channels reported", async () => {
      const env = makeEnv();
      let asked = 0;
      // Two deletes ask once each; the third question is the one before the flag.
      const out = await env.channels.removeAllGroupChannels(EV, env.guild, {
        ending: () => ++asked >= 3,
      });
      expect(out).toEqual({
        status: "failed",
        reason: "the event is being ended",
        deleted: 2,
      });
      expect(doc().groupsEnabled).toBe(true);
      expect(channelIds()).toEqual([null, null, null]);
    });
  });

  describe("refusals that change nothing", () => {
    it("events switched off, an event that is over, groups already off, an unreadable event", async () => {
      const off = makeEnv({ eventsEnabled: false });
      expect(
        await off.channels.removeAllGroupChannels(EV, off.guild, {}),
      ).toEqual({ status: "lost" });
      seed({ state: "ended" });
      const ended = makeEnv();
      expect(
        await ended.channels.removeAllGroupChannels(EV, ended.guild, {}),
      ).toEqual({ status: "lost" });
      seed({ groupsEnabled: false });
      const already = makeEnv();
      expect(
        await already.channels.removeAllGroupChannels(EV, already.guild, {}),
      ).toEqual({ status: "lost" });
      seed();
      fake.failReads = true;
      const unreadable = makeEnv();
      expect(
        await unreadable.channels.removeAllGroupChannels(
          EV,
          unreadable.guild,
          {},
        ),
      ).toEqual({
        status: "failed",
        reason: "the event could not be read",
        deleted: 0,
      });
      expect(writes).toEqual([]);
    });

    it("a group that got a channel recorded meanwhile keeps the flag on: the write is conditional on none", async () => {
      const env = makeEnv();
      // Just before the flag write, a pass records a channel for group C.
      fake.beforeWrite = () => {
        if (writes.length === 2) groups()[2].channelId = "300000000000000003";
      };
      const out = await env.channels.removeAllGroupChannels(EV, env.guild, {});
      expect(out).toEqual({ status: "lost" });
      expect(doc().groupsEnabled).toBe(true);
    });
  });
});

describe("removeGroup asks for the end hold once more right before the record write", () => {
  it("the channel is deleted, an end took its hold meanwhile: the record stays and the outcome is a failure to repeat", async () => {
    const env = makeEnv();
    let asked = 0;
    // The delete asks once; the question before the record write is the second.
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
      ending: () => ++asked >= 2,
    });
    expect(out).toEqual({
      status: "failed",
      reason: "the event is being ended",
    });
    expect(env.rest.delete).toHaveBeenCalledTimes(1);
    expect(groups().map((g) => g.key)).toEqual([A, B, C]);
    expect(writes).toEqual([]);
  });
});
