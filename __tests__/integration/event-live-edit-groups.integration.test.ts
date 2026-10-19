import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import mongoose from "mongoose";
import { ConfigService } from "../../src/services/config-service.js";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import {
  runLiveEdit,
  type LiveEditDeps,
  type LiveEditOutcome,
} from "../../src/services/event-live-edit.js";
import {
  groupNameRowId,
  groupPresetRow,
  groupSizeRowId,
  GROUP_PRESET_ROW_ID,
  readPresetValue,
} from "../../src/services/event-live-edit-groups.js";
import {
  customiseGroup,
  resetGroupCustomisation,
  type CustomiseDeps,
} from "../../src/services/event-leader-customise.js";
import { EventGroupChannels } from "../../src/services/event-group-channels.js";

/**
 * The live edit of group names, sizes and preset (#1241) writes with shapes the
 * unit suite's stand-in can only imitate: `groups.$[g].<field>` selected by
 * `arrayFilters`, `$elemMatch` on `size: null` (which must also match a group
 * whose `size` was never written) and on `originalName: { $in: [null, ""] }`,
 * the preset's `$and` of `$size` and one `$elemMatch` per group with `$unset`
 * of the leader's originals, and a new optional field (`sizeSyncPending`) that
 * Mongoose's strict mode would silently drop if the schema did not declare it.
 * These run the real rows against a real server and read the raw stored
 * documents back.
 */
const GUILD = "guild-1";
const A = "g_00000001";
const B = "g_00000002";
const LEADER = "100000000000000001";
const A_CH = "200000000000000001";
const B_CH = "200000000000000002";

const deps: LiveEditDeps = {
  isEventsEnabled: async () => true,
  maxGroups: async () => 15,
  isEnding: () => false,
  effects: {
    syncGroupName: async (_g, _e, key) => ({ groupKey: key, status: "applied" }),
    syncGroupUserLimit: async (_g, _e, key) => ({
      groupKey: key,
      status: "applied",
    }),
    retagMembers: () => undefined,
    eventVoiceInUse: () => true,
    syncLeadsAccess: async () => undefined,
    syncGroupControls: async () => undefined,
    syncTags: async () => undefined,
  },
};

type Raw = Record<string, unknown>;

describeWithMongo(
  "live edit of group names, sizes and preset against a real MongoDB (#1241)",
  () => {
    useRealMongo();

    beforeAll(async () => {
      await Event.init();
    });
    beforeEach(async () => {
      await Event.deleteMany({});
      jest
        .spyOn(ConfigService.getInstance(), "getBoolean")
        .mockImplementation(async (key: string) => key === "events.enabled");
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    async function makeEvent(over: Raw = {}): Promise<string> {
      const event = await Event.create({
        guildId: GUILD,
        title: "Clan match",
        startTime: new Date(Date.now() + 3_600_000),
        createdBy: "host",
        state: "active",
        groupsEnabled: true,
        captainsEnabled: true,
        captainCustomisationEnabled: true,
        groups: [
          {
            key: A,
            name: "Alpha",
            kind: "team",
            size: 3,
            tag: "A",
            channelId: A_CH,
            captainId: LEADER,
            memberIds: [LEADER, "u2"],
          },
          {
            key: B,
            name: "Bravo",
            kind: "team",
            tag: "B",
            channelId: B_CH,
            memberIds: ["u3"],
          },
        ],
        ...over,
      });
      return String(event._id);
    }

    const raw = async (id: string): Promise<Raw> => {
      const doc = await Event.collection.findOne({
        _id: new mongoose.Types.ObjectId(id),
      });
      if (!doc) throw new Error("event missing");
      return doc as unknown as Raw;
    };
    const rawGroup = async (id: string, key = A): Promise<Raw> =>
      ((await raw(id)).groups as Raw[]).find((g) => g.key === key) as Raw;

    const run = (
      eventId: string,
      entries: Array<{ rowId: string; to: unknown; base: unknown }>,
    ): Promise<LiveEditOutcome> =>
      runLiveEdit({
        guildId: GUILD,
        eventId,
        deps,
        submission: entries as never,
      });
    const entry = (rowId: string, to: unknown, base: unknown) => ({
      rowId,
      to,
      base,
    });
    const applied = (o: LiveEditOutcome): string[] =>
      o.status === "done" ? o.applied.map((c) => c.rowId) : [`<${o.status}>`];

    it("no schema default adds a pending marker, an over-size flag or an original to a group", async () => {
      const id = await makeEvent();
      const g = await rawGroup(id);
      for (const key of [
        "sizeSyncPending",
        "nameSyncPending",
        "overSize",
        "originalName",
        "originalTag",
      ]) {
        expect(key in g).toBe(false);
      }
      // A group made without a size keeps null, as before this step.
      expect((await rawGroup(id, B)).size).toBeNull();
    });

    it("renames one group through arrayFilters and touches nothing else of it or of the other group", async () => {
      const id = await makeEvent();
      const before = await raw(id);
      const out = await run(id, [
        entry(groupNameRowId(0), "Apex", "Alpha"),
      ]);
      expect(applied(out)).toEqual([groupNameRowId(0)]);
      const g = await rawGroup(id);
      expect(g).toMatchObject({
        name: "Apex",
        nameSyncPending: true,
        size: 3,
        tag: "A",
        channelId: A_CH,
        captainId: LEADER,
        memberIds: [LEADER, "u2"],
      });
      // A group nobody customised keeps no original.
      expect("originalName" in g).toBe(false);
      expect(await rawGroup(id, B)).toEqual(
        (before.groups as Raw[]).find((x) => x.key === B),
      );
      expect((await raw(id)).liveEditRevision).toBe(1);
    });

    it("a group a leader renamed: the original becomes the host's name, the original tag stays", async () => {
      const id = await makeEvent();
      const leader = await customiseGroup(
        {
          guildId: GUILD,
          eventId: id,
          groupKey: A,
          actorId: LEADER,
          channelId: A_CH,
          rawName: "Crimson",
          rawTag: "CRM",
        },
        {
          eventsEnabled: async () => true,
          syncName: async (_g, _e, key) => ({ groupKey: key, status: "applied" }),
          retag: () => undefined,
        } as CustomiseDeps,
      );
      expect(leader.ok).toBe(true);
      expect(await rawGroup(id)).toMatchObject({
        name: "Crimson",
        originalName: "Alpha",
        originalTag: "A",
      });
      const out = await run(id, [
        entry(groupNameRowId(0), "Apex", "Crimson"),
      ]);
      expect(applied(out)).toEqual([groupNameRowId(0)]);
      expect(await rawGroup(id)).toMatchObject({
        name: "Apex",
        originalName: "Apex",
        originalTag: "A",
        tag: "CRM",
      });
    });

    it("two renames to the same name in one save: the second is refused and nothing is overwritten", async () => {
      const id = await makeEvent();
      const out = await run(id, [
        entry(groupNameRowId(0), "Zulu", "Alpha"),
        entry(groupNameRowId(1), "zulu", "Bravo"),
      ]);
      expect(applied(out)).toEqual([groupNameRowId(0)]);
      expect((await rawGroup(id)).name).toBe("Zulu");
      expect((await rawGroup(id, B)).name).toBe("Bravo");
    });

    it("a size is written for a group whose size is null and for one whose size was never stored, and the marker persists", async () => {
      const id = await makeEvent();
      const inserted = await Event.collection.insertOne({
        guildId: GUILD,
        title: "Old row",
        startTime: new Date(Date.now() + 3_600_000),
        createdBy: "host",
        state: "active",
        groupsEnabled: true,
        groups: [
          { key: A, name: "Solo", kind: "team", memberIds: [], channelId: null },
        ],
      });
      const oldId = String(inserted.insertedId);
      // Null (a group made by the event form with no size).
      const nulled = await run(id, [entry(groupSizeRowId(1), 4, null)]);
      expect(applied(nulled)).toEqual([groupSizeRowId(1)]);
      expect(await rawGroup(id, B)).toMatchObject({
        size: 4,
        sizeSyncPending: true,
      });
      // Missing (a row from before the field existed).
      const missing = await run(oldId, [entry(groupSizeRowId(0), 5, null)]);
      expect(applied(missing)).toEqual([groupSizeRowId(0)]);
      expect(await rawGroup(oldId)).toMatchObject({
        size: 5,
        sizeSyncPending: true,
      });
      // And back to no limit.
      const cleared = await run(oldId, [entry(groupSizeRowId(0), null, 5)]);
      expect(applied(cleared)).toEqual([groupSizeRowId(0)]);
      expect((await rawGroup(oldId)).size).toBeNull();
    });

    it("lowering a size below the members keeps every member and stores no over-size state", async () => {
      const id = await makeEvent();
      const out = await run(id, [entry(groupSizeRowId(0), 1, 3)]);
      expect(applied(out)).toEqual([groupSizeRowId(0)]);
      const g = await rawGroup(id);
      expect(g.memberIds).toEqual([LEADER, "u2"]);
      expect(g.size).toBe(1);
      expect(Object.keys(g).some((k) => /over/i.test(k))).toBe(false);
    });

    it("a size change loses to a concurrent change of that size", async () => {
      const id = await makeEvent();
      // The form showed 3; somebody set 7 meanwhile.
      await Event.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: { "groups.0.size": 7 } },
      );
      const out = await run(id, [entry(groupSizeRowId(0), 5, 3)]);
      expect(out.status).toBe("done");
      expect(applied(out)).toEqual([]);
      expect((await rawGroup(id)).size).toBe(7);
    });

    describe("the preset switch", () => {
      const squads = {
        id: "builtin:squads",
        groups: [
          { name: "Squad 1", kind: "team", size: 4, tag: "S1" },
          { name: "Squad 2", kind: "team", size: 4, tag: "S2" },
        ],
      };

      async function confirmedSwitch(id: string): Promise<LiveEditOutcome> {
        const event = (await Event.findById(id).lean()) as never;
        const first = await run(id, [
          entry(GROUP_PRESET_ROW_ID, squads, readPresetValue(event)),
        ]);
        if (first.status !== "needs-confirmation") {
          throw new Error(`expected a confirmation, got ${first.status}`);
        }
        return runLiveEdit({
          guildId: GUILD,
          eventId: id,
          deps,
          confirmed: first.changes.map((c) => ({
            rowId: c.rowId,
            from: c.from,
            to: c.to,
          })),
          confirmedRevision: first.revision,
        });
      }

      it("applies names, sizes and tags by position in one write, unsets the leader's originals and keeps everything else", async () => {
        const id = await makeEvent();
        await customiseGroup(
          {
            guildId: GUILD,
            eventId: id,
            groupKey: A,
            actorId: LEADER,
            channelId: A_CH,
            rawName: "Crimson",
            rawTag: "CRM",
          },
          {
            eventsEnabled: async () => true,
            syncName: async (_g, _e, key) => ({
              groupKey: key,
              status: "applied",
            }),
            retag: () => undefined,
          } as CustomiseDeps,
        );
        const before = await raw(id);
        const out = await confirmedSwitch(id);
        expect(applied(out)).toEqual([GROUP_PRESET_ROW_ID]);
        const doc = await raw(id);
        expect(doc.presetId).toBe("builtin:squads");
        const [ga, gb] = doc.groups as Raw[];
        expect(ga).toMatchObject({
          key: A,
          name: "Squad 1",
          size: 4,
          tag: "S1",
          nameSyncPending: true,
          sizeSyncPending: true,
          memberIds: [LEADER, "u2"],
          captainId: LEADER,
          channelId: A_CH,
          kind: "team",
        });
        expect("originalName" in ga).toBe(false);
        expect("originalTag" in ga).toBe(false);
        expect(gb).toMatchObject({
          key: B,
          name: "Squad 2",
          size: 4,
          tag: "S2",
          memberIds: ["u3"],
        });
        // The leader's edit and this save both counted.
        expect(before.liveEditRevision).toBe(1);
        expect(doc.liveEditRevision).toBe(2);
      });

      it("is all or nothing: one group changed since the plan makes the whole write lose", async () => {
        const id = await makeEvent();
        const stale = (await Event.findById(id).lean()) as never;
        await Event.collection.updateOne(
          { _id: new mongoose.Types.ObjectId(id) },
          { $set: { "groups.1.name": "Changed meanwhile" } },
        );
        const result = await groupPresetRow.apply({
          event: stale,
          eventId: id,
          guildId: GUILD,
          from: readPresetValue(stale),
          to: squads,
          ending: () => false,
        } as never);
        expect(result).toEqual({ status: "lost" });
        const doc = await raw(id);
        expect(doc.presetId).toBeNull();
        expect((doc.groups as Raw[]).map((g) => g.name)).toEqual([
          "Alpha",
          "Changed meanwhile",
        ]);
      });

      it("matches a group whose tag was never stored as an empty tag", async () => {
        const inserted = await Event.collection.insertOne({
          guildId: GUILD,
          title: "Old row",
          startTime: new Date(Date.now() + 3_600_000),
          createdBy: "host",
          state: "active",
          groupsEnabled: true,
          groups: [
            { key: A, name: "One", kind: "team", memberIds: [], channelId: null },
            { key: B, name: "Two", kind: "team", memberIds: [], channelId: null },
          ],
        });
        const id = String(inserted.insertedId);
        const out = await confirmedSwitch(id);
        expect(applied(out)).toEqual([GROUP_PRESET_ROW_ID]);
        expect((await rawGroup(id)).tag).toBe("S1");
        expect((await rawGroup(id)).size).toBe(4);
      });
    });

    describe("the leader's writes move the revision", () => {
      const leaderDeps = {
        eventsEnabled: async () => true,
        syncName: async (_g: string, _e: string, key: string) => ({
          groupKey: key,
          status: "applied" as const,
        }),
        retag: () => undefined,
      } as CustomiseDeps;

      it("an edit and a reset each count once", async () => {
        const id = await makeEvent();
        expect((await raw(id)).liveEditRevision).toBeUndefined();
        await customiseGroup(
          {
            guildId: GUILD,
            eventId: id,
            groupKey: A,
            actorId: LEADER,
            channelId: A_CH,
            rawName: "Crimson",
            rawTag: "CRM",
          },
          leaderDeps,
        );
        expect((await raw(id)).liveEditRevision).toBe(1);
        const reset = await resetGroupCustomisation(
          { guildId: GUILD, eventId: id, groupKey: A },
          leaderDeps,
        );
        expect(reset.ok).toBe(true);
        expect((await raw(id)).liveEditRevision).toBe(2);
        expect((await rawGroup(id)).name).toBe("Alpha");
      });
    });

    describe("the user limit pass", () => {
      function channelsWith(
        limits: Map<string, number>,
        sent: Array<Record<string, unknown>>,
      ): EventGroupChannels {
        const rest = {
          patch: async (route: string, o: { body: Record<string, unknown> }) => {
            sent.push(o.body);
            limits.set(
              /channels\/(\d+)/.exec(route)![1],
              o.body.user_limit as number,
            );
            return {};
          },
          post: async () => ({ id: "300000000000000001" }),
          get: async () => [],
          delete: async () => ({}),
        };
        return new EventGroupChannels(
          { user: { id: "999999999999999999" }, token: "t" } as never,
          {
            getPrefix: async () => "",
            getGraceMs: async () => 0,
            isEnabled: async () => true,
          },
          {
            rest: rest as never,
            call: ((fn: (s: AbortSignal) => Promise<unknown>) =>
              fn(new AbortController().signal)) as never,
            paceMs: 0,
          },
        );
      }
      const guildWith = (limits: Map<string, number>): never =>
        ({
          id: GUILD,
          channels: {
            cache: new Map(),
            fetch: async (id: string) => ({
              id,
              name: "x",
              guildId: GUILD,
              userLimit: limits.get(id),
            }),
          },
        }) as never;

      it("sets the limit and clears the marker only for the size that was set; no size means 0", async () => {
        const id = await makeEvent();
        await run(id, [entry(groupSizeRowId(0), 5, 3)]);
        await run(id, [entry(groupSizeRowId(1), 2, null)]);
        await run(id, [entry(groupSizeRowId(1), null, 2)]);
        const limits = new Map([
          [A_CH, 3],
          [B_CH, 2],
        ]);
        const sent: Array<Record<string, unknown>> = [];
        const out = await channelsWith(limits, sent).syncUserLimits(
          id,
          guildWith(limits),
        );
        expect(out.map((o) => [o.groupKey, o.status]).sort()).toEqual([
          [A, "applied"],
          [B, "applied"],
        ]);
        expect(sent).toEqual(
          expect.arrayContaining([{ user_limit: 5 }, { user_limit: 0 }]),
        );
        expect((await rawGroup(id)).sizeSyncPending).toBe(false);
        // B has no size (null): the marker clear matched it.
        expect((await rawGroup(id, B)).sizeSyncPending).toBe(false);
        expect((await rawGroup(id)).memberIds).toEqual([LEADER, "u2"]);
      });
    });
  },
);
