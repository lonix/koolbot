import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import mongoose from "mongoose";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event, type IEvent } from "../../src/models/event.js";
import {
  LIVE_EDIT_ROWS,
  runLiveEdit,
  type LiveEditDeps,
  type LiveEditEffects,
} from "../../src/services/event-live-edit.js";
import { groupTagsRow } from "../../src/services/event-live-edit-leaders-tags.js";

/**
 * The leaders and tags rows of the live edit (#1240) write with shapes the unit
 * suite's stand-in can only imitate: `captainsEnabled: { $ne: true }` matching a
 * row from before the field existed, `leaderLabel: { $in: [.., "", null] }`,
 * `groups.$[gN].tag` selected by `arrayFilters`, and one filter holding an
 * `$elemMatch` per touched group in `$and` (all or nothing). These run the real
 * rows against a real server and read the raw stored documents back.
 */
describeWithMongo(
  "leaders and tags live edit against a real MongoDB (#1240)",
  () => {
    useRealMongo();

    beforeAll(async () => {
      await Event.init();
    });
    beforeEach(async () => {
      await Event.deleteMany({});
      calls = [];
    });

    const GUILD = "guild-1";
    let calls: string[] = [];
    const effects: LiveEditEffects = {
      eventVoiceInUse: () => true,
      syncLeadsAccess: async (_g, e) => {
        calls.push(`leads:${e}`);
      },
      syncGroupControls: async (e) => {
        calls.push(`controls:${e}`);
      },
      syncTags: async (_g, e, mode) => {
        calls.push(`tags:${mode}:${e}`);
      },
    };
    const deps: LiveEditDeps = {
      isEventsEnabled: async () => true,
      maxGroups: async () => 15,
      isEnding: () => false,
      effects,
    };

    async function makeEvent(
      over: Record<string, unknown> = {},
    ): Promise<string> {
      const event = await Event.create({
        guildId: GUILD,
        title: "Clan match",
        startTime: new Date(Date.now() + 3_600_000),
        createdBy: "host",
        state: "active",
        groupsEnabled: true,
        groups: [
          {
            key: "g_a",
            name: "Heli",
            kind: "team",
            tag: "HEL",
            captainId: "u1",
            memberIds: ["u1", "u2"],
          },
          { key: "g_b", name: "Logi", kind: "team", tag: "LOG" },
          { key: "g_c", name: "Lobby", kind: "open", tag: "" },
        ],
        ...over,
      });
      return String(event._id);
    }

    const oid = (id: string): mongoose.Types.ObjectId =>
      new mongoose.Types.ObjectId(id);
    const raw = async (id: string): Promise<Record<string, unknown>> => {
      const doc = await Event.collection.findOne({ _id: oid(id) });
      if (!doc) throw new Error("event missing");
      return doc as unknown as Record<string, unknown>;
    };
    const groupsOf = async (
      id: string,
    ): Promise<Array<Record<string, unknown>>> =>
      (await raw(id)).groups as Array<Record<string, unknown>>;

    const run = (
      eventId: string,
      entries: Array<{ rowId: string; to: unknown; base: unknown }>,
    ) =>
      runLiveEdit({
        guildId: GUILD,
        eventId,
        deps,
        rows: LIVE_EDIT_ROWS,
        submission: entries as never,
      });

    it("leaders on and off: the switch is stored, the stored leader is kept, and a row from before the field matches", async () => {
      const id = await makeEvent();
      // A row written before the field existed has no `captainsEnabled` at all.
      await Event.collection.updateOne(
        { _id: oid(id) },
        { $unset: { captainsEnabled: "" } },
      );
      expect(
        await run(id, [{ rowId: "captainsEnabled", to: true, base: false }]),
      ).toMatchObject({ status: "done", notApplied: [] });
      expect((await raw(id)).captainsEnabled).toBe(true);
      expect(calls).toEqual([`leads:${id}`, `controls:${id}`]);
      expect(
        await run(id, [{ rowId: "captainsEnabled", to: false, base: true }]),
      ).toMatchObject({ status: "done", notApplied: [] });
      expect((await raw(id)).captainsEnabled).toBe(false);
      const groups = await groupsOf(id);
      expect(groups[0].captainId).toBe("u1");
      expect(groups[0].memberIds).toEqual(["u1", "u2"]);
    });

    it("customisation, label, tagging and position are plain conditional writes", async () => {
      const id = await makeEvent();
      await Event.collection.updateOne(
        { _id: oid(id) },
        { $unset: { leaderLabel: "", tagsSuffix: "" } },
      );
      const out = await run(id, [
        { rowId: "captainCustomisationEnabled", to: true, base: false },
        { rowId: "leaderLabel", to: "Captain", base: "Leader" },
        { rowId: "tagsEnabled", to: true, base: false },
        { rowId: "tagsSuffix", to: true, base: false },
      ]);
      expect(out).toMatchObject({ status: "done", notApplied: [] });
      expect(await raw(id)).toMatchObject({
        captainCustomisationEnabled: true,
        leaderLabel: "Captain",
        tagsEnabled: true,
        tagsSuffix: true,
        liveEditRevision: 1,
      });
      // One pass of each kind for the whole save.
      expect(calls).toEqual([`controls:${id}`, `tags:sync:${id}`]);
    });

    it("tagging off asks for a restore", async () => {
      const id = await makeEvent({ tagsEnabled: true });
      await run(id, [{ rowId: "tagsEnabled", to: false, base: true }]);
      expect(calls).toEqual([`tags:restore:${id}`]);
    });

    it("a changed tag writes that team's tag by key and nothing else of any group", async () => {
      const id = await makeEvent();
      const before = await groupsOf(id);
      const out = await run(id, [
        {
          rowId: "groupTags",
          to: { g_a: "SKY", g_b: "LOG" },
          base: { g_a: "HEL", g_b: "LOG" },
        },
      ]);
      expect(out).toMatchObject({ status: "done", notApplied: [] });
      const after = await groupsOf(id);
      expect(after[0]).toEqual({ ...before[0], tag: "SKY" });
      expect(after[1]).toEqual(before[1]);
      // The open group is not a team: its tag is never read or written.
      expect(after[2]).toEqual(before[2]);
      expect(calls).toEqual([`tags:restore:${id}`]);
    });

    it("a team with no stored tag field matches 'no tag' and takes the new one", async () => {
      const id = await makeEvent();
      await Event.collection.updateOne(
        { _id: oid(id) },
        { $unset: { "groups.1.tag": "" } },
      );
      const out = await run(id, [
        {
          rowId: "groupTags",
          to: { g_a: "HEL", g_b: "NEW" },
          base: { g_a: "HEL", g_b: "" },
        },
      ]);
      expect(out).toMatchObject({ status: "done", notApplied: [] });
      expect((await groupsOf(id))[1].tag).toBe("NEW");
    });

    it("the host's tag becomes the original of a customised team, and only of that team", async () => {
      const id = await makeEvent();
      await Event.collection.updateOne(
        { _id: oid(id) },
        {
          $set: {
            "groups.0.tag": "RDS",
            "groups.0.originalName": "Red",
            "groups.0.originalTag": "HEL",
          },
        },
      );
      await run(id, [
        {
          rowId: "groupTags",
          to: { g_a: "SKY", g_b: "ICE" },
          base: { g_a: "RDS", g_b: "LOG" },
        },
      ]);
      const groups = await groupsOf(id);
      expect(groups[0]).toMatchObject({ tag: "SKY", originalTag: "SKY" });
      expect(groups[1].tag).toBe("ICE");
      expect("originalTag" in groups[1]).toBe(false);
    });

    it("is all or nothing: a team that changed since the plan makes the whole write match nothing", async () => {
      const id = await makeEvent();
      const event = (await Event.findById(id).lean()) as unknown as IEvent;
      // Between the plan (from HEL / LOG) and the write, Logi's tag moves on.
      await Event.collection.updateOne(
        { _id: oid(id) },
        { $set: { "groups.1.tag": "NAVY" } },
      );
      const outcome = await groupTagsRow.apply({
        event,
        eventId: id,
        guildId: GUILD,
        from: { g_a: "HEL", g_b: "LOG" },
        to: { g_a: "SKY", g_b: "ICE" },
        ending: () => false,
      });
      expect(outcome).toEqual({ status: "lost" });
      const groups = await groupsOf(id);
      expect(groups[0].tag).toBe("HEL");
      expect(groups[1].tag).toBe("NAVY");
    });

    it("an ended event matches nothing (the write is conditional on the event being open)", async () => {
      const id = await makeEvent();
      const event = (await Event.findById(id).lean()) as unknown as IEvent;
      await Event.collection.updateOne(
        { _id: oid(id) },
        { $set: { state: "ended" } },
      );
      const outcome = await groupTagsRow.apply({
        event,
        eventId: id,
        guildId: GUILD,
        from: { g_a: "HEL", g_b: "LOG" },
        to: { g_a: "SKY", g_b: "LOG" },
        ending: () => false,
      });
      expect(outcome).toEqual({ status: "lost" });
      expect((await groupsOf(id))[0].tag).toBe("HEL");
    });

    it("saving the same form again is 'already applied': no write, no new revision", async () => {
      const id = await makeEvent();
      const form = [{ rowId: "captainsEnabled", to: true, base: false }];
      await run(id, form);
      const revision = (await raw(id)).liveEditRevision;
      calls = [];
      expect(await run(id, form)).toMatchObject({
        status: "done",
        alreadyApplied: ["captainsEnabled"],
      });
      expect((await raw(id)).liveEditRevision).toBe(revision);
      expect(calls).toEqual([]);
    });
  },
);
