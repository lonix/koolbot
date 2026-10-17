import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import {
  copyGroupSetup,
  emptyGroupSetup,
} from "../../src/services/event-groups.js";

/**
 * Events made before groups (#1188) have no group fields at all. The unit tests
 * mock the model, so they cannot show that such a row loads with the defaults
 * and that the schema's own guards hold; these run against a real server. The
 * old row is written with the raw driver, because `Event.create` would add the
 * defaults and prove nothing.
 */
describeWithMongo("event groups against a real MongoDB (#1188)", () => {
  useRealMongo();

  beforeAll(async () => {
    await Event.init();
  });

  beforeEach(async () => {
    await Event.deleteMany({});
  });

  it("loads an event row written before groups with the plain-event defaults", async () => {
    const { insertedId } = await Event.collection.insertOne({
      guildId: "guild-1",
      title: "Old game night",
      description: "",
      startTime: new Date(Date.now() + 3_600_000),
      timezone: "UTC",
      durationMinutes: 120,
      categoryId: "",
      channelId: null,
      state: "scheduled",
      reminderSent: false,
      rsvps: [],
      recurrence: "none",
      createdBy: "host",
    });
    const raw = await Event.collection.findOne({ _id: insertedId });
    expect(raw).not.toHaveProperty("groups");
    expect(raw).not.toHaveProperty("groupsEnabled");

    const loaded = await Event.findById(insertedId);
    expect(loaded).not.toBeNull();
    expect(loaded?.groupsEnabled).toBe(false);
    expect(loaded?.groups).toHaveLength(0);
    expect(loaded?.presetId).toBeNull();
    expect(loaded?.groupLabel).toBe("Team");
    expect(loaded?.leaderLabel).toBe("Leader");
    expect(loaded?.channelLeadMinutes).toBeNull();
    expect(loaded?.captainsEnabled).toBe(false);
    expect(loaded?.captainCustomisationEnabled).toBe(false);
    expect(loaded?.tagsEnabled).toBe(false);

    // What the spawn copies from it is the empty setup.
    expect(copyGroupSetup(loaded as never)).toEqual(emptyGroupSetup());
  });

  it("a lean read of an old row has no group fields, so readers must default them", async () => {
    const { insertedId } = await Event.collection.insertOne({
      guildId: "guild-1",
      title: "Old",
      startTime: new Date(Date.now() + 3_600_000),
      createdBy: "host",
    });
    const lean = await Event.findById(insertedId).lean();
    expect(lean?.groups).toBeUndefined();
    expect(copyGroupSetup(lean as never)).toEqual(emptyGroupSetup());
  });

  it("round-trips a group setup, defaulting the fields later issues fill in", async () => {
    const created = await Event.create({
      guildId: "guild-1",
      title: "Clan match",
      startTime: new Date(Date.now() + 3_600_000),
      createdBy: "host",
      groupsEnabled: true,
      presetId: "builtin:wardogs",
      groupLabel: "Squad",
      channelLeadMinutes: 30,
      groups: [
        { key: "g_1", name: "Manticore", kind: "team", size: 8, marker: "🟢" },
        { key: "g_2", name: "Command", kind: "leads" },
      ],
    });
    const loaded = await Event.findById(created._id).lean();
    expect(loaded?.channelLeadMinutes).toBe(30);
    expect(loaded?.groups).toEqual([
      {
        key: "g_1",
        name: "Manticore",
        kind: "team",
        size: 8,
        tag: "",
        marker: "🟢",
        channelId: null,
        captainId: null,
        memberIds: [],
      },
      {
        key: "g_2",
        name: "Command",
        kind: "leads",
        size: null,
        tag: "",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: [],
      },
    ]);
  });

  it("refuses a size, kind or lead time outside the allowed range", async () => {
    const base = {
      guildId: "guild-1",
      title: "Bad",
      startTime: new Date(Date.now() + 3_600_000),
      createdBy: "host",
    };
    await expect(
      Event.create({
        ...base,
        groups: [{ key: "g", name: "A", kind: "team", size: 100 }],
      }),
    ).rejects.toThrow();
    await expect(
      Event.create({
        ...base,
        groups: [{ key: "g", name: "A", kind: "boss" }],
      }),
    ).rejects.toThrow();
    await expect(
      Event.create({ ...base, channelLeadMinutes: 5000 }),
    ).rejects.toThrow();
  });
});
