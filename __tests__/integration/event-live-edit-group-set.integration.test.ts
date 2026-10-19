import {
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import mongoose from "mongoose";
import { ChannelType, type Guild } from "discord.js";
import { ConfigService } from "../../src/services/config-service.js";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import {
  runLiveEdit,
  signConfirmation,
  verifyConfirmation,
  type LiveEditDeps,
  type LiveEditEffects,
  type LiveEditOutcome,
} from "../../src/services/event-live-edit.js";
import {
  GROUP_ADD_ROW_ID,
  GROUP_REMOVE_ROW_ID,
} from "../../src/services/event-live-edit-group-set.js";
import { groupSizeRowId } from "../../src/services/event-live-edit-groups.js";
import { EventGroupChannels } from "../../src/services/event-group-channels.js";

/**
 * Adding and removing groups on a running event (#1242) writes with shapes the
 * unit suite's stand-in can only imitate: `$push` of a group conditional on
 * `$size` and on `"groups.key": { $ne }`, the members' unassign matched by an
 * EXACT member array inside `$elemMatch` and written through `arrayFilters`,
 * `$pull` of a group by `{ key, channelId }` (and by `channelId: null`, which
 * must match a group whose id was never written), and a stored group that must
 * carry exactly the fields the row wrote (no schema default added to it).
 * These run the real rows, and the real `EventGroupChannels.removeGroup`,
 * against a real server and read the raw stored documents back.
 */
const GUILD = "111111111111111111";
const A = "g_00000001";
const B = "g_00000002";
const NEW = "g_0000abcd";
const A_CH = "200000000000000001";
const B_CH = "200000000000000002";
const LEADER = "100000000000000001";

type Raw = Record<string, unknown>;

describeWithMongo(
  "live edit that adds and removes groups against a real MongoDB (#1242)",
  () => {
    useRealMongo();

    const calls: string[] = [];
    const deleted = new Set<string>();

    const effects: LiveEditEffects = {
      syncGroupName: async (_g, _e, key) => ({
        groupKey: key,
        status: "applied",
      }),
      syncGroupUserLimit: async (_g, _e, key) => ({
        groupKey: key,
        status: "applied",
      }),
      retagMembers: () => undefined,
      eventVoiceInUse: () => true,
      syncLeadsAccess: async () => undefined,
      syncGroupControls: async () => undefined,
      syncTags: async () => undefined,
      // Like the group pass: a channel id is recorded on every group that has
      // none (positional write, as the pass does).
      createGroupChannels: async (_guildId, eventId) => {
        calls.push("create");
        const row = (await Event.findById(eventId).lean()) as {
          groups?: Array<{ key: string; channelId?: string | null }>;
        } | null;
        for (const g of row?.groups ?? []) {
          if (g.channelId) continue;
          await Event.updateOne(
            {
              _id: eventId,
              groups: { $elemMatch: { key: g.key, channelId: null } },
            },
            { $set: { "groups.$.channelId": `made-${g.key}` } },
          );
        }
        return { failures: [] };
      },
      emptyGroupChannel: async () => ({ status: "empty", moved: [] }),
      // The REAL channel pass, with a fake Discord.
      removeGroupChannel: async (guildId, eventId, key, channelId, opts) => {
        const members = new Map<string, unknown>();
        const guild = {
          id: guildId,
          channels: {
            cache: new Map(),
            fetch: async (id: string) => ({
              id,
              type: ChannelType.GuildVoice,
              guildId,
              members,
            }),
          },
        } as unknown as Guild;
        const channels = new EventGroupChannels(
          { user: { id: "999999999999999999" }, token: "t" } as never,
          {
            getPrefix: async () => "x",
            getGraceMs: async () => 0,
            isEnabled: async () => true,
          },
          {
            rest: {
              delete: async (route: string) => {
                deleted.add(route);
                return {};
              },
            } as never,
            call: ((fn: (s: AbortSignal) => Promise<unknown>) =>
              fn(new AbortController().signal)) as never,
            paceMs: 0,
          },
        );
        return channels.removeGroup(eventId, guild, {
          groupKey: key,
          channelId,
          ignore: opts.ignore,
          ending: opts.ending,
        });
      },
    };
    const deps: LiveEditDeps = {
      isEventsEnabled: async () => true,
      maxGroups: async () => 15,
      isEnding: () => false,
      effects,
    };

    beforeAll(async () => {
      await Event.init();
    });
    beforeEach(async () => {
      await Event.deleteMany({});
      calls.length = 0;
      deleted.clear();
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
        channelId: "main-1",
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
    const groupsOf = async (id: string): Promise<Raw[]> =>
      (await raw(id)).groups as Raw[];
    const keysOf = async (id: string): Promise<string[]> =>
      (await groupsOf(id)).map((g) => g.key as string);

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
    const newGroup = (over: Raw = {}) => ({
      key: NEW,
      name: "Delta",
      kind: "team",
      size: 4,
      tag: "D",
      ...over,
    });
    const outcomeOf = (o: LiveEditOutcome): string =>
      o.status === "done" ? `done:${o.applied.map((c) => c.rowId)}` : o.status;

    /** The confirmation page and the confirmed run, as the host routes do. */
    async function removeConfirmed(
      eventId: string,
      keys: string[],
    ): Promise<LiveEditOutcome> {
      const first = await run(eventId, [
        { rowId: GROUP_REMOVE_ROW_ID, to: keys, base: [] },
      ]);
      if (first.status !== "needs-confirmation") return first;
      process.env.WEBUI_SESSION_SECRET = "group-set-integration-secret";
      const token = signConfirmation({
        eventId,
        guildId: GUILD,
        userId: "host",
        changes: first.changes.map((c) => ({
          rowId: c.rowId,
          from: c.from,
          to: c.to,
        })),
        revision: first.revision,
      });
      const check = verifyConfirmation(token, {
        eventId,
        guildId: GUILD,
        userId: "host",
      });
      if (!check.ok) throw new Error("token refused");
      return runLiveEdit({
        guildId: GUILD,
        eventId,
        deps,
        confirmed: check.changes,
        confirmedRevision: check.revision,
      });
    }

    it("pushes the group with exactly the fields the row wrote: no schema default is added", async () => {
      const id = await makeEvent();
      const out = await run(id, [
        { rowId: GROUP_ADD_ROW_ID, to: [newGroup()], base: [] },
      ]);
      expect(outcomeOf(out)).toBe("done:groupAdd");
      expect(await keysOf(id)).toEqual([A, B, NEW]);
      const added = (await groupsOf(id))[2];
      expect(added).toEqual({
        key: NEW,
        name: "Delta",
        kind: "team",
        size: 4,
        tag: "D",
        marker: "",
        channelId: "made-g_0000abcd",
        captainId: null,
        memberIds: [],
      });
      // The other groups are exactly as they were written.
      expect((await groupsOf(id))[0]).toMatchObject({
        key: A,
        memberIds: [LEADER, "u2"],
        channelId: A_CH,
        captainId: LEADER,
      });
      expect((await raw(id)).liveEditRevision).toBe(1);
      expect(calls).toEqual(["create"]);
    });

    it("a group with no size and no tag is stored with null and an empty tag, not the field missing", async () => {
      const id = await makeEvent();
      await run(id, [
        {
          rowId: GROUP_ADD_ROW_ID,
          to: [newGroup({ size: null, tag: "", kind: "open" })],
          base: [],
        },
      ]);
      expect((await groupsOf(id))[2]).toMatchObject({
        kind: "open",
        size: null,
        tag: "",
        memberIds: [],
      });
    });

    it("posting the same add twice is one group: the second finds the key stored", async () => {
      const id = await makeEvent();
      const entry = { rowId: GROUP_ADD_ROW_ID, to: [newGroup()], base: [] };
      await run(id, [entry]);
      const again = await run(id, [entry]);
      expect(again.status).toBe("done");
      expect(await keysOf(id)).toEqual([A, B, NEW]);
      expect((await raw(id)).liveEditRevision).toBe(1);
    });

    it("the conditional push is refused when the group count is not the one it was decided from", async () => {
      const id = await makeEvent();
      const filter = {
        _id: new mongoose.Types.ObjectId(id),
        groups: { $size: 5 },
        "groups.key": { $ne: NEW },
      };
      const result = await Event.updateOne(filter, {
        $push: { groups: { key: NEW, name: "X", kind: "open" } },
      });
      expect(result.matchedCount).toBe(0);
      expect(await keysOf(id)).toEqual([A, B]);
      // And with the right count and a key that is stored already: refused too.
      const stored = await Event.updateOne(
        {
          _id: new mongoose.Types.ObjectId(id),
          groups: { $size: 2 },
          "groups.key": { $ne: A },
        },
        { $push: { groups: { key: A, name: "X", kind: "open" } } },
      );
      expect(stored.matchedCount).toBe(0);
    });

    it("removes a group: unassigns its members through the exact array match, deletes the channel, pulls the record, keeps the rest", async () => {
      const id = await makeEvent();
      const out = await removeConfirmed(id, [A]);
      expect(outcomeOf(out)).toBe("done:groupRemove");
      expect(await keysOf(id)).toEqual([B]);
      expect([...deleted]).toEqual([`/channels/${A_CH}`]);
      const left = (await groupsOf(id))[0];
      expect(left).toMatchObject({
        key: B,
        memberIds: ["u3"],
        channelId: B_CH,
      });
    });

    it("a removal whose delete fails leaves the group unassigned and present; saving again finishes it", async () => {
      const id = await makeEvent();
      // The channel pass answers "occupied" while somebody is connected.
      const original = effects.removeGroupChannel;
      effects.removeGroupChannel = async () => ({
        status: "failed",
        reason: "Missing Permissions",
      });
      try {
        const out = await removeConfirmed(id, [A]);
        expect(out.status).toBe("done");
        expect(out.status === "done" && out.partial).toHaveLength(1);
      } finally {
        effects.removeGroupChannel = original;
      }
      const stuck = (await groupsOf(id))[0];
      expect(stuck).toMatchObject({ key: A, memberIds: [], channelId: A_CH });
      const again = await removeConfirmed(id, [A]);
      expect(outcomeOf(again)).toBe("done:groupRemove");
      expect(await keysOf(id)).toEqual([B]);
    });

    it("pulls a group whose channelId was never written as readily as one stored as null", async () => {
      const inserted = await Event.collection.insertOne({
        guildId: GUILD,
        title: "Old row",
        startTime: new Date(Date.now() + 3_600_000),
        createdBy: "host",
        state: "active",
        groupsEnabled: true,
        groups: [
          { key: A, name: "Solo", kind: "team", memberIds: ["u1"] },
          { key: B, name: "Duo", kind: "team", memberIds: [] },
        ],
      });
      const oldId = String(inserted.insertedId);
      const out = await removeConfirmed(oldId, [A]);
      expect(outcomeOf(out)).toBe("done:groupRemove");
      expect(await keysOf(oldId)).toEqual([B]);
    });

    it("a membership that changed since the read makes the unassign match nothing", async () => {
      const id = await makeEvent();
      const result = await Event.updateOne(
        {
          _id: new mongoose.Types.ObjectId(id),
          groups: { $elemMatch: { key: A, memberIds: [LEADER] } },
        },
        { $set: { "groups.$[g].memberIds": [] } },
        { arrayFilters: [{ "g.key": A }] },
      );
      expect(result.matchedCount).toBe(0);
      expect((await groupsOf(id))[0].memberIds).toEqual([LEADER, "u2"]);
    });

    it("the channel pass pulls only under the channel id it deleted: a replacement recorded meanwhile keeps the group", async () => {
      const id = await makeEvent();
      await Event.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id), "groups.key": A },
        { $set: { "groups.$.channelId": "300000000000000001" } },
      );
      const result = await Event.updateOne(
        {
          _id: new mongoose.Types.ObjectId(id),
          groups: { $elemMatch: { key: A, channelId: A_CH } },
        },
        { $pull: { groups: { key: A, channelId: A_CH } } },
      );
      expect(result.matchedCount).toBe(0);
      expect(await keysOf(id)).toEqual([A, B]);
    });

    it("never removes the last group", async () => {
      const id = await makeEvent();
      const out = await run(id, [
        { rowId: GROUP_REMOVE_ROW_ID, to: [A, B], base: [] },
      ]);
      expect(out.status).toBe("invalid");
      expect(await keysOf(id)).toEqual([A, B]);
    });

    it("a size form shown for another group at the position is a conflict against the real row", async () => {
      const id = await makeEvent();
      await removeConfirmed(id, [A]);
      // Position 1 is Bravo now (no size); the form showed Alpha there.
      const out = await runLiveEdit({
        guildId: GUILD,
        eventId: id,
        deps,
        submission: [
          { rowId: groupSizeRowId(0), to: 5, base: null, guard: A },
        ] as never,
      });
      expect(out.status === "done" && out.notApplied).toHaveLength(1);
      expect((await groupsOf(id))[0].size ?? null).toBeNull();
    });
  },
);
