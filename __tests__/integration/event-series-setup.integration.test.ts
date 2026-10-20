import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import {
  readSeriesGroupSetup,
  seriesGroupSetupOf,
  successorGroupFields,
} from "../../src/services/event-groups.js";
import {
  runLiveEdit,
  type LiveEditDeps,
} from "../../src/services/event-live-edit.js";

/**
 * The series' group setup (#1266) is stored on the event row with no schema
 * defaults, and written by the live edit's tick with a filter the unit suite's
 * stand-in only imitates (`state: { $in }`, `seriesCancelled: { $ne: true }`).
 * These run against a real server and read the RAW stored documents back, so a
 * default that sneaks into a stored field (it once broke a round-trip test of
 * the groups) shows here.
 */
describeWithMongo("series group setup against a real MongoDB (#1266)", () => {
  useRealMongo();

  beforeAll(async () => {
    await Event.init();
  });
  beforeEach(async () => {
    await Event.deleteMany({});
  });

  const GUILD = "guild-1";
  const deps: LiveEditDeps = {
    isEventsEnabled: async () => true,
    maxGroups: async () => 15,
    isEnding: () => false,
  };

  const setup = {
    groupsEnabled: true,
    presetId: null,
    groupLabel: "Squad",
    leaderLabel: "Captain",
    groupsLocked: true,
    captainsEnabled: true,
    captainCustomisationEnabled: false,
    tagsEnabled: true,
    tagsSuffix: false,
    groups: [
      {
        key: "g_a",
        name: "Caldari",
        kind: "team" as const,
        size: 6,
        tag: "CAL",
        marker: "",
      },
      {
        key: "g_b",
        name: "Gallente",
        kind: "open" as const,
        size: null,
        tag: "",
        marker: "",
      },
    ],
  };

  async function makeRecurring(
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const event = await Event.create({
      guildId: GUILD,
      title: "Quiz night",
      startTime: new Date(Date.now() + 3_600_000),
      createdBy: "host",
      state: "active",
      recurrence: "weekly",
      seriesId: "series-1",
      groupsEnabled: true,
      groupLabel: "Squad",
      groups: [
        {
          key: "g_a",
          name: "Quizzzzbois",
          kind: "team",
          size: 6,
          tag: "QZ",
          originalName: "Caldari",
          originalTag: "CAL",
          memberIds: ["u1"],
          captainId: "u-leader",
          channelId: "c-a",
        },
      ],
      ...over,
    });
    return String(event._id);
  }

  it("a row without a series setup stores none and reads as none (no schema default)", async () => {
    const event = await Event.create({
      guildId: GUILD,
      title: "Plain",
      startTime: new Date(Date.now() + 3_600_000),
      createdBy: "host",
    });
    const raw = await Event.collection.findOne({ _id: event._id });
    expect(raw).not.toHaveProperty("seriesGroupSetup");
    const lean = await Event.findById(event._id).lean();
    expect(lean?.seriesGroupSetup).toBeUndefined();
    expect(readSeriesGroupSetup(lean?.seriesGroupSetup)).toBeNull();
    const loaded = await Event.findById(event._id);
    expect(loaded?.seriesGroupSetup).toBeUndefined();
  });

  it("round-trips the setup exactly as written, with nothing added by the schema", async () => {
    const event = await Event.create({
      guildId: GUILD,
      title: "Quiz night",
      startTime: new Date(Date.now() + 3_600_000),
      createdBy: "host",
      seriesGroupSetup: setup,
    });
    const raw = await Event.collection.findOne({ _id: event._id });
    expect(raw?.seriesGroupSetup).toEqual(setup);
    const lean = await Event.findById(event._id).lean();
    expect(lean?.seriesGroupSetup).toEqual(setup);
    expect(readSeriesGroupSetup(lean?.seriesGroupSetup)).toEqual(setup);
  });

  it("a successor built from the stored setup carries it on and starts without people, leaders or channels", async () => {
    const event = await Event.create({
      guildId: GUILD,
      title: "Quiz night",
      startTime: new Date(Date.now() + 3_600_000),
      createdBy: "host",
      seriesGroupSetup: setup,
    });
    const stored = readSeriesGroupSetup(
      (await Event.findById(event._id).lean())?.seriesGroupSetup,
    );
    expect(stored).not.toBeNull();
    const fields = successorGroupFields(stored!, null);
    const next = await Event.create({
      guildId: GUILD,
      title: "Quiz night",
      startTime: new Date(Date.now() + 7_200_000),
      createdBy: "host",
      ...fields,
      seriesGroupSetup: stored,
    });
    const raw = await Event.collection.findOne({ _id: next._id });
    expect(raw).toMatchObject({
      groupsEnabled: true,
      groupsLocked: true,
      groupLabel: "Squad",
      leaderLabel: "Captain",
      captainsEnabled: true,
      seriesGroupSetup: setup,
    });
    expect(raw?.groups).toEqual([
      {
        key: "g_a",
        name: "Caldari",
        kind: "team",
        size: 6,
        tag: "CAL",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: [],
      },
      {
        key: "g_b",
        name: "Gallente",
        kind: "open",
        size: null,
        tag: "",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: [],
      },
    ]);
  });

  it("the tick writes the host's setup of a running occurrence, leaving out a leader's rename and every person", async () => {
    const id = await makeRecurring();
    const out = await runLiveEdit({
      guildId: GUILD,
      eventId: id,
      deps,
      submission: [{ rowId: "seriesSetup", to: true, base: false }],
    });
    expect(out).toMatchObject({ status: "done" });
    const raw = await Event.collection.findOne({
      _id: (await Event.findById(id))?._id,
    });
    expect(raw?.seriesGroupSetup).toEqual({
      groupsEnabled: true,
      presetId: null,
      groupLabel: "Squad",
      leaderLabel: "Leader",
      groupsLocked: false,
      captainsEnabled: false,
      captainCustomisationEnabled: false,
      tagsEnabled: false,
      tagsSuffix: false,
      groups: [
        {
          key: "g_a",
          name: "Caldari",
          kind: "team",
          size: 6,
          tag: "CAL",
          marker: "",
        },
      ],
    });
    const text = JSON.stringify(raw?.seriesGroupSetup);
    for (const forbidden of ["Quizzzzbois", "u1", "u-leader", "c-a"]) {
      expect(text).not.toContain(forbidden);
    }
    // The occurrence itself is untouched: its own group keeps the leader's name.
    expect((raw?.groups as Array<{ name: string }>).map((g) => g.name)).toEqual(
      ["Quizzzzbois"],
    );
  });

  it("the tick does nothing for an event that ended, and for a cancelled series", async () => {
    const ended = await makeRecurring({ state: "ended" });
    expect(
      await runLiveEdit({
        guildId: GUILD,
        eventId: ended,
        deps,
        submission: [{ rowId: "seriesSetup", to: true, base: false }],
      }),
    ).toMatchObject({ status: "refused", code: "not-open" });

    // Its own series: the unique key is (guild, series, occurrence).
    const cancelled = await makeRecurring({
      seriesCancelled: true,
      seriesId: "series-2",
    });
    const out = await runLiveEdit({
      guildId: GUILD,
      eventId: cancelled,
      deps,
      submission: [{ rowId: "seriesSetup", to: true, base: false }],
    });
    expect(out).toMatchObject({ status: "invalid" });
    for (const id of [ended, cancelled]) {
      const raw = await Event.collection.findOne({
        _id: (await Event.findById(id))?._id,
      });
      expect(raw).not.toHaveProperty("seriesGroupSetup");
    }
  });

  it("seriesGroupSetupOf of a stored row has the same shape the schema stores", async () => {
    const id = await makeRecurring();
    const lean = await Event.findById(id).lean();
    const snapshot = seriesGroupSetupOf(lean as never);
    const copy = await Event.create({
      guildId: GUILD,
      title: "Copy",
      startTime: new Date(Date.now() + 3_600_000),
      createdBy: "host",
      seriesGroupSetup: snapshot,
    });
    const raw = await Event.collection.findOne({ _id: copy._id });
    expect(raw?.seriesGroupSetup).toEqual(snapshot);
  });
});
