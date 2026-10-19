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
import { GROUPS_SWITCH_ROW_ID } from "../../src/services/event-live-edit-groups-switch.js";
import { EventGroupChannels } from "../../src/services/event-group-channels.js";

/**
 * Switching the groups of a running event on and off (#1243) writes with shapes
 * the unit suites' stand-in can only imitate: the switch-on's `$set` of the
 * whole `groups` array on an event that has none (matched by `$or` of a missing
 * field and `$size: 0`), its conditional `$set` of `groupsEnabled` on the kept
 * groups (`$size`, `groupsEnabled: { $ne: true }`), the channel pass's
 * positional `groups.$.channelId` clears, and the switch-off's single flag write
 * conditional on `$nor` of an `$elemMatch` on a real channel id. These run the
 * real row and the real `EventGroupChannels.removeAllGroupChannels` against a
 * real server and read the raw stored documents back, including that a stored
 * group carries exactly the fields written (no schema default added to it) and
 * that the kept groups come through a switch-off unchanged.
 */
const GUILD = "111111111111111111";
const A = "g_00000001";
const B = "g_00000002";
const A_CH = "200000000000000001";
const B_CH = "200000000000000002";
const LEADER = "100000000000000001";

type Raw = Record<string, unknown>;

const SETUP = {
  id: "builtin:red-vs-blue",
  groupLabel: "Squad",
  leaderLabel: "Captain",
  tagsEnabled: true,
  groups: [
    { name: "Red", kind: "team", size: 4, tag: "R", marker: "🔴" },
    { name: "Command", kind: "leads", size: null, tag: "", marker: "" },
  ],
};

describeWithMongo(
  "live edit that switches groups on and off against a real MongoDB (#1243)",
  () => {
    useRealMongo();

    const calls: string[] = [];
    const deleted: string[] = [];
    let failDelete: ((id: string) => boolean) | null = null;

    /** The REAL channel pass, with a fake Discord. */
    function realChannels(guildId: string): {
      channels: EventGroupChannels;
      guild: Guild;
    } {
      const guild = {
        id: guildId,
        channels: {
          cache: new Map(),
          fetch: async (id: string) => ({
            id,
            type: ChannelType.GuildVoice,
            guildId,
            members: new Map(),
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
              const id = route.replace("/channels/", "");
              if (failDelete?.(id)) throw new Error("boom");
              deleted.push(id);
              return {};
            },
          } as never,
          call: ((fn: (s: AbortSignal) => Promise<unknown>) =>
            fn(new AbortController().signal)) as never,
          paceMs: 0,
        },
      );
      return { channels, guild };
    }

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
      syncLeadsAccess: async () => {
        calls.push("leads");
      },
      syncGroupControls: async () => {
        calls.push("controls");
      },
      syncTags: async (_g, _e, mode) => {
        calls.push(`tags:${mode}`);
      },
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
      emptyGroupChannels: async () => ({
        status: "done",
        moved: [],
        occupied: [],
        unconfirmed: 0,
        detail: "",
      }),
      removeGroupChannel: async () => ({ status: "removed" }),
      removeAllGroupChannels: async (guildId, eventId, opts) => {
        const { channels, guild } = realChannels(guildId);
        return channels.removeAllGroupChannels(eventId, guild, {
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
      deleted.length = 0;
      failDelete = null;
      jest
        .spyOn(ConfigService.getInstance(), "getBoolean")
        .mockImplementation(async (key: string) => key === "events.enabled");
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    /** An event with groups on, two channels, members and a leader. */
    async function makeEvent(over: Raw = {}): Promise<string> {
      const event = await Event.create({
        guildId: GUILD,
        title: "Clan match",
        startTime: new Date(Date.now() + 3_600_000),
        createdBy: "host",
        state: "active",
        groupsEnabled: true,
        captainsEnabled: true,
        tagsEnabled: true,
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
            kind: "leads",
            tag: "",
            channelId: B_CH,
            memberIds: [],
          },
        ],
        ...over,
      });
      return String(event._id);
    }
    /** A plain event: made without groups, so every group field is at its default. */
    const makePlain = (over: Raw = {}): Promise<string> =>
      makeEvent({
        groupsEnabled: false,
        captainsEnabled: false,
        tagsEnabled: false,
        groups: [],
        ...over,
      });

    const raw = async (id: string): Promise<Raw> => {
      const doc = await Event.collection.findOne({
        _id: new mongoose.Types.ObjectId(id),
      });
      if (!doc) throw new Error("event missing");
      return doc as unknown as Raw;
    };
    const groupsOf = async (id: string): Promise<Raw[]> =>
      ((await raw(id)).groups as Raw[]) ?? [];

    const run = (
      eventId: string,
      to: unknown,
      base: unknown,
    ): Promise<LiveEditOutcome> =>
      runLiveEdit({
        guildId: GUILD,
        eventId,
        deps,
        submission: [{ rowId: GROUPS_SWITCH_ROW_ID, to, base }] as never,
      });
    const outcomeOf = (o: LiveEditOutcome): string =>
      o.status === "done"
        ? `done:${o.applied.map((c) => c.rowId)}${o.partial.length ? ":partial" : ""}${o.notApplied.length ? ":notApplied" : ""}`
        : o.status;

    /** The confirmation page and the confirmed run, as the host routes do. */
    async function offConfirmed(eventId: string): Promise<LiveEditOutcome> {
      const first = await run(eventId, { on: false }, { on: true });
      if (first.status !== "needs-confirmation") return first;
      process.env.WEBUI_SESSION_SECRET = "groups-switch-integration-secret";
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

    it("switches off: the flag is stored false, every channel id is cleared, and the groups come through unchanged", async () => {
      const id = await makeEvent();
      const before = await groupsOf(id);
      const out = await offConfirmed(id);
      expect(outcomeOf(out)).toBe("done:groupsEnabled");
      const doc = await raw(id);
      expect(doc.groupsEnabled).toBe(false);
      expect(doc.liveEditRevision).toBe(1);
      const after = await groupsOf(id);
      expect(after.map((g) => g.channelId)).toEqual([null, null]);
      // Everything but the channel ids is exactly as it was: members, leader,
      // names, kinds, sizes and tags, and no field was added to a group.
      after.forEach((group, i) => {
        expect(Object.keys(group).sort()).toEqual(
          Object.keys(before[i]).sort(),
        );
        expect({ ...group, channelId: "x" }).toEqual({
          ...before[i],
          channelId: "x",
        });
      });
      expect(after[0].memberIds).toEqual([LEADER, "u2"]);
      expect(after[0].captainId).toBe(LEADER);
      expect([...deleted].sort()).toEqual([A_CH, B_CH]);
      expect(calls).toEqual(["tags:restore"]);
    });

    it("the flag write refuses a group that still has a channel, and accepts one whose id was never written", async () => {
      const id = await makeEvent();
      const filter = {
        _id: new mongoose.Types.ObjectId(id),
        state: { $in: ["scheduled", "active"] },
        groupsEnabled: true,
        $nor: [
          {
            groups: {
              $elemMatch: { channelId: { $type: "string", $ne: "" } },
            },
          },
        ],
      };
      const refused = await Event.updateOne(filter, {
        $set: { groupsEnabled: false },
      });
      expect(refused.matchedCount).toBe(0);
      expect((await raw(id)).groupsEnabled).toBe(true);
      // Group A: cleared to null; group B: the field removed altogether.
      await Event.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id), "groups.key": A },
        { $set: { "groups.$.channelId": null } },
      );
      await Event.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id), "groups.key": B },
        { $unset: { "groups.$.channelId": "" } },
      );
      const accepted = await Event.updateOne(filter, {
        $set: { groupsEnabled: false },
      });
      expect(accepted.matchedCount).toBe(1);
      expect((await raw(id)).groupsEnabled).toBe(false);
    });

    it("an empty-string channel id is not a channel either", async () => {
      const id = await makeEvent();
      await Event.collection.updateMany(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: { "groups.$[].channelId": "" } },
      );
      const { channels, guild } = realChannels(GUILD);
      expect(await channels.removeAllGroupChannels(id, guild, {})).toEqual({
        status: "off",
        deleted: 0,
      });
      expect(deleted).toEqual([]);
      expect((await raw(id)).groupsEnabled).toBe(false);
    });

    it("a delete failing halfway keeps the flag on with the deleted channel's id cleared; saving again finishes", async () => {
      const id = await makeEvent();
      failDelete = (channel) => channel === B_CH;
      const first = await offConfirmed(id);
      expect(outcomeOf(first)).toBe("done::notApplied");
      expect((await raw(id)).groupsEnabled).toBe(true);
      expect((await groupsOf(id)).map((g) => g.channelId)).toEqual([
        null,
        B_CH,
      ]);
      failDelete = null;
      const again = await offConfirmed(id);
      expect(outcomeOf(again)).toBe("done:groupsEnabled");
      expect((await raw(id)).groupsEnabled).toBe(false);
      expect((await groupsOf(id)).map((g) => g.channelId)).toEqual([
        null,
        null,
      ]);
    });

    it("a replayed confirmation applies nothing, and the same form posted again is already applied", async () => {
      const id = await makeEvent();
      const first = await run(id, { on: false }, { on: true });
      expect(first.status).toBe("needs-confirmation");
      await offConfirmed(id);
      const again = await run(id, { on: false }, { on: true });
      expect(again.status === "done" && again.alreadyApplied).toEqual([
        GROUPS_SWITCH_ROW_ID,
      ]);
      expect((await raw(id)).liveEditRevision).toBe(1);
    });

    it("switches the kept groups back on: members and leader are as they were, and the channels are written positionally", async () => {
      const id = await makeEvent();
      await offConfirmed(id);
      calls.length = 0;
      const out = await run(id, { on: true }, { on: false });
      expect(outcomeOf(out)).toBe("done:groupsEnabled");
      const doc = await raw(id);
      expect(doc.groupsEnabled).toBe(true);
      const groups = await groupsOf(id);
      expect(groups.map((g) => g.channelId)).toEqual([
        `made-${A}`,
        `made-${B}`,
      ]);
      expect(groups[0].memberIds).toEqual([LEADER, "u2"]);
      expect(groups[0].captainId).toBe(LEADER);
      expect(calls).toEqual(["create", "leads", "controls", "tags:sync"]);
      // Posted twice: the second finds the groups on.
      const twice = await run(id, { on: true }, { on: false });
      expect(twice.status === "done" && twice.alreadyApplied).toEqual([
        GROUPS_SWITCH_ROW_ID,
      ]);
    });

    it("the conditional switch-on refuses an event whose groups are on already, or whose group count changed", async () => {
      const id = await makeEvent({ groupsEnabled: false });
      const on = await Event.updateOne(
        {
          _id: new mongoose.Types.ObjectId(id),
          groupsEnabled: { $ne: true },
          groups: { $size: 5 },
        },
        { $set: { groupsEnabled: true } },
      );
      expect(on.matchedCount).toBe(0);
      const already = await makeEvent();
      const second = await Event.updateOne(
        {
          _id: new mongoose.Types.ObjectId(already),
          groupsEnabled: { $ne: true },
          groups: { $size: 2 },
        },
        { $set: { groupsEnabled: true } },
      );
      expect(second.matchedCount).toBe(0);
    });

    it("builds the groups of a plain event from the preset with exactly the fields written", async () => {
      const id = await makePlain();
      const out = await run(id, { on: true, setup: SETUP }, { on: false });
      expect(outcomeOf(out)).toBe("done:groupsEnabled");
      const doc = await raw(id);
      expect(doc.groupsEnabled).toBe(true);
      expect(doc.presetId).toBe("builtin:red-vs-blue");
      expect(doc.groupLabel).toBe("Squad");
      expect(doc.leaderLabel).toBe("Captain");
      expect(doc.tagsEnabled).toBe(true);
      expect(doc.captainsEnabled).toBe(false);
      const groups = await groupsOf(id);
      expect(groups).toHaveLength(2);
      groups.forEach((g, i) => {
        expect(g.key).toMatch(/^g_[0-9a-f]{8}$/);
        expect(Object.keys(g).sort()).toEqual([
          "captainId",
          "channelId",
          "key",
          "kind",
          "marker",
          "memberIds",
          "name",
          "size",
          "tag",
        ]);
        expect(g).toMatchObject({
          name: SETUP.groups[i].name,
          kind: SETUP.groups[i].kind,
          size: SETUP.groups[i].size,
          tag: SETUP.groups[i].tag,
          marker: SETUP.groups[i].marker,
          captainId: null,
          memberIds: [],
          channelId: `made-${String(g.key)}`,
        });
      });
      expect(calls).toEqual(["create", "leads", "controls", "tags:sync"]);
      // The same form again builds nothing twice.
      const keys = groups.map((g) => g.key);
      const again = await run(id, { on: true, setup: SETUP }, { on: false });
      expect(again.status === "done" && again.alreadyApplied).toEqual([
        GROUPS_SWITCH_ROW_ID,
      ]);
      expect((await groupsOf(id)).map((g) => g.key)).toEqual(keys);
    });

    it("an event row from before groups (no groups field) is matched like an empty list", async () => {
      const inserted = await Event.collection.insertOne({
        guildId: GUILD,
        title: "Old row",
        startTime: new Date(Date.now() + 3_600_000),
        createdBy: "host",
        state: "active",
        channelId: "main-1",
      });
      const oldId = String(inserted.insertedId);
      const out = await run(oldId, { on: true, setup: SETUP }, { on: false });
      expect(outcomeOf(out)).toBe("done:groupsEnabled");
      expect((await raw(oldId)).groupsEnabled).toBe(true);
      expect(await groupsOf(oldId)).toHaveLength(2);
    });

    it("the conditional seed refuses an event that has groups", async () => {
      const id = await makeEvent({ groupsEnabled: false });
      const result = await Event.updateOne(
        {
          _id: new mongoose.Types.ObjectId(id),
          groupsEnabled: { $ne: true },
          $or: [{ groups: { $exists: false } }, { groups: { $size: 0 } }],
        },
        { $set: { groupsEnabled: true } },
      );
      expect(result.matchedCount).toBe(0);
    });

    it("an event without a main channel is switched on with no channel made, and owes nothing", async () => {
      const id = await makePlain({ channelId: null });
      const out = await run(id, { on: true, setup: SETUP }, { on: false });
      expect(outcomeOf(out)).toBe("done:groupsEnabled");
      expect((await groupsOf(id)).map((g) => g.channelId ?? null)).toEqual([
        null,
        null,
      ]);
      expect(calls).not.toContain("create");
    });
  },
);
