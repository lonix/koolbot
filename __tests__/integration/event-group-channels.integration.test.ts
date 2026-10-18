import { it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { ChannelType, DiscordAPIError, type Guild } from "discord.js";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import {
  EventGroupChannels,
  eventChannelProtectionFilter,
} from "../../src/services/event-group-channels.js";

/**
 * The group channel lifecycle (#1190) records and clears channel ids with
 * positional updates (`groups.$.channelId`) filtered by `$elemMatch`. The unit
 * tests use an in-memory fake of those two shapes; these run the real class
 * against a real server to show that Mongoose casts and applies them, that a
 * lean read of an old row has no group fields, and that an id written this way
 * survives a later `save()` of a copy of the event loaded before it.
 */
describeWithMongo("event group channels against a real MongoDB (#1190)", () => {
  useRealMongo();

  const GUILD = "111111111111111111";
  const CATEGORY = "333333333333333333";

  beforeAll(async () => {
    await Event.init();
  });

  beforeEach(async () => {
    await Event.deleteMany({});
  });

  function env(): {
    service: EventGroupChannels;
    guild: Guild;
    live: Set<string>;
  } {
    const live = new Set<string>();
    let seq = 0;
    const notFound = (): DiscordAPIError =>
      new DiscordAPIError(
        { code: 10003, message: "x" },
        10003,
        404,
        "GET",
        "/",
        {},
      );
    const guild = {
      id: GUILD,
      members: { me: null },
      channels: {
        cache: new Map(),
        fetch: jest.fn(async (id: string) => {
          if (id === "main-1") {
            return {
              id,
              type: ChannelType.GuildVoice,
              guildId: GUILD,
              parentId: CATEGORY,
              members: { size: 0 },
            };
          }
          if (id === CATEGORY) {
            return {
              id,
              type: ChannelType.GuildCategory,
              permissionOverwrites: { cache: new Map() },
            };
          }
          if (!live.has(id)) throw notFound();
          return {
            id,
            type: ChannelType.GuildVoice,
            guildId: GUILD,
            members: { size: 0 },
          };
        }),
      },
    } as unknown as Guild;
    const rest = {
      post: jest.fn(async () => {
        seq += 1;
        live.add(`chan-${seq}`);
        return { id: `chan-${seq}` };
      }),
      delete: jest.fn(async (route: string) => {
        live.delete(route.split("/").pop() as string);
      }),
    };
    const service = new EventGroupChannels(
      {} as never,
      {
        getPrefix: async () => "📅",
        getGraceMs: async () => 0,
      },
      {
        rest: rest as never,
        call: (async (fn: (s: AbortSignal) => Promise<unknown>) =>
          fn(new AbortController().signal)) as never,
        paceMs: 0,
      },
    );
    return { service, guild, live };
  }

  async function makeEvent(state = "active"): Promise<string> {
    const event = await Event.create({
      guildId: GUILD,
      title: "Clan match",
      startTime: new Date(Date.now() - 6 * 3_600_000),
      durationMinutes: 120,
      state,
      channelId: "main-1",
      createdBy: "222222222222222222",
      groupsEnabled: true,
      groups: [
        { key: "g_a", name: "Alpha", kind: "team", size: 5 },
        { key: "g_b", name: "Bravo", kind: "team" },
      ],
    });
    return String(event._id);
  }

  it("creates and records every group channel, once, even when two passes run together", async () => {
    const id = await makeEvent();
    const { service, guild, live } = env();
    await Promise.all([
      service.reconcile({ _id: id }, guild),
      service.reconcile({ _id: id }, guild),
    ]);
    const stored = await Event.findById(id).lean();
    expect(stored?.groups.map((g) => g.channelId)).toEqual([
      "chan-1",
      "chan-2",
    ]);
    expect(live.size).toBe(2);
  });

  it("an id recorded by the positional update survives a save of a copy loaded before it", async () => {
    const id = await makeEvent();
    const stale = await Event.findById(id); // what the scan holds
    const { service, guild } = env();
    await service.reconcile({ _id: id }, guild);

    (stale as NonNullable<typeof stale>).reminderSent = true;
    await (stale as NonNullable<typeof stale>).save();

    const stored = await Event.findById(id).lean();
    expect(stored?.reminderSent).toBe(true);
    expect(stored?.groups.map((g) => g.channelId)).toEqual([
      "chan-1",
      "chan-2",
    ]);
  });

  it("creates a group's channel again when the recorded one is gone, and does not touch the others", async () => {
    const id = await makeEvent();
    const { service, guild, live } = env();
    await service.reconcile({ _id: id }, guild);
    live.delete("chan-1");
    await service.reconcile({ _id: id }, guild);
    const stored = await Event.findById(id).lean();
    expect(stored?.groups.map((g) => g.channelId)).toEqual([
      "chan-3",
      "chan-2",
    ]);
  });

  it("does not record a channel for a cancelled event and finds recorded ones of a finished event by the scan's query", async () => {
    const id = await makeEvent("cancelled");
    const { service, guild, live } = env();
    await service.reconcile({ _id: id }, guild);
    expect(live.size).toBe(0);

    const open = await makeEvent();
    await service.reconcile({ _id: open }, guild);
    await Event.updateOne({ _id: open }, { $set: { state: "ended" } });
    const found = await Event.find({
      guildId: GUILD,
      state: { $in: ["ended", "cancelled"] },
      "groups.channelId": { $type: "string" },
    });
    expect(found.map((e) => String(e._id))).toEqual([open]);

    const report = await service.cleanup({ _id: open }, guild, new Date());
    expect(report.removed).toBe(2);
    const after = await Event.findById(open).lean();
    expect(after?.groups.every((g) => g.channelId === null)).toBe(true);
    expect(live.size).toBe(0);
    expect(
      await Event.countDocuments({ "groups.channelId": { $type: "string" } }),
    ).toBe(0);
  });

  it("the voice sweeps' protection filter finds a group event's main channel before any group channel exists, and no plain event", async () => {
    const groupEvent = await makeEvent(); // main channel recorded, no group ids
    await Event.create({
      guildId: GUILD,
      title: "Plain",
      startTime: new Date(),
      state: "active",
      channelId: "plain-main",
      createdBy: "222222222222222222",
    });
    const rows = await Event.find(eventChannelProtectionFilter(GUILD)).lean();
    expect(rows.map((r) => String(r._id))).toEqual([groupEvent]);

    const { service, guild } = env();
    await service.reconcile({ _id: groupEvent }, guild);
    const after = await Event.find(eventChannelProtectionFilter(GUILD)).lean();
    expect(after.map((r) => String(r._id))).toEqual([groupEvent]);
  });

  it("a lean read of an old row without group fields is safe for the readers", async () => {
    const { insertedId } = await Event.collection.insertOne({
      guildId: GUILD,
      title: "Old",
      startTime: new Date(Date.now() - 6 * 3_600_000),
      durationMinutes: 120,
      state: "ended",
      channelId: null,
      createdBy: "host",
    });
    const { service, guild } = env();
    const report = await service.cleanup(
      { _id: insertedId },
      guild,
      new Date(),
    );
    expect(report).toEqual({
      created: 0,
      removed: 0,
      occupied: 0,
      failures: [],
      warnings: [],
    });
    const reconciled = await service.reconcile({ _id: insertedId }, guild);
    expect(reconciled.created).toBe(0);
  });
});
