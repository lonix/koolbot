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
import { CAPTAINS_LOBBY_ROW_ID } from "../../src/services/event-live-edit-captains-lobby.js";
import { addGroupLocked } from "../../src/services/event-live-edit-group-set.js";
import { validateGroupSetup } from "../../src/services/event-groups.js";
import { EventGroupChannels } from "../../src/services/event-group-channels.js";

/**
 * The Captains lobby switch (#1251) writes and reads with shapes the unit
 * suite's stand-in can only imitate: the conditional `$push` of a `leads` group
 * (`$size`, `"groups.key": { $ne }`, `"groups.kind": { $ne: "leads" }` and
 * `captainsEnabled: true` in one filter), the `$pull` of the lobby's group by
 * `{ key, channelId }` and by `channelId: null` (which must match a group whose
 * id was never written), a stored `leads` group that carries exactly the fields
 * the row wrote (no schema default is added to it), and a lobby created by the
 * event form's validator that round-trips unchanged. These run the real row, and
 * the real `EventGroupChannels.removeGroup`, against a real server and read the
 * raw stored documents back.
 */
const GUILD = "111111111111111111";
const A = "g_00000001";
const B = "g_00000002";
const LOBBY = "g_000000a1";
const A_CH = "200000000000000001";
const B_CH = "200000000000000002";
const LOBBY_CH = "200000000000000003";

type Raw = Record<string, unknown>;

describeWithMongo(
  "the Captains lobby switch against a real MongoDB (#1251)",
  () => {
    useRealMongo();

    const calls: string[] = [];
    /** Somebody is connected to a voice channel of the event (the gateway cache). */
    let voiceInUse = true;
    const deleted = new Set<string>();

    const effects: LiveEditEffects = {
      // Somebody is connected, so turning the lobby off asks first.
      eventVoiceInUse: () => voiceInUse,
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
      voiceInUse = true;
      deleted.clear();
      jest
        .spyOn(ConfigService.getInstance(), "getBoolean")
        .mockImplementation(async (key: string) => key === "events.enabled");
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    const teams = (): Raw[] => [
      {
        key: A,
        name: "Alpha",
        kind: "team",
        size: 3,
        tag: "A",
        channelId: A_CH,
        memberIds: ["u1"],
      },
      {
        key: B,
        name: "Bravo",
        kind: "team",
        tag: "B",
        channelId: B_CH,
        memberIds: ["u2"],
      },
    ];

    async function makeEvent(
      extraGroups: Raw[] = [],
      over: Raw = {},
    ): Promise<string> {
      const event = await Event.create({
        guildId: GUILD,
        title: "Clan match",
        startTime: new Date(Date.now() + 3_600_000),
        createdBy: "host",
        state: "active",
        groupsEnabled: true,
        captainsEnabled: true,
        channelId: "main-1",
        groups: [...teams(), ...extraGroups],
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
    const leadsOf = async (id: string): Promise<Raw[]> =>
      (await groupsOf(id)).filter((g) => g.kind === "leads");

    const run = (
      eventId: string,
      to: boolean,
      base: boolean,
    ): Promise<LiveEditOutcome> =>
      runLiveEdit({
        guildId: GUILD,
        eventId,
        deps,
        submission: [{ rowId: CAPTAINS_LOBBY_ROW_ID, to, base }] as never,
      });

    /** The confirmation page and the confirmed run, as the host routes do. */
    async function offConfirmed(eventId: string): Promise<LiveEditOutcome> {
      const first = await run(eventId, false, true);
      if (first.status !== "needs-confirmation") return first;
      process.env.WEBUI_SESSION_SECRET = "captains-lobby-integration-secret";
      const token = signConfirmation({
        eventId,
        guildId: GUILD,
        userId: "host",
        changes: first.changes.map((c) => ({
          rowId: c.rowId,
          from: c.from,
          to: c.to,
          guard: c.guard,
        })),
        revision: first.revision,
        voiceInUse: first.voiceInUse,
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
        confirmedVoiceInUse: check.voiceInUse,
      });
    }

    const outcomeOf = (o: LiveEditOutcome): string =>
      o.status === "done" ? `done:${o.applied.map((c) => c.rowId)}` : o.status;

    it("turning it on pushes a leads group with exactly the fields the row wrote: no schema default is added", async () => {
      const id = await makeEvent();
      const out = await run(id, true, false);
      expect(outcomeOf(out)).toBe("done:captainsLobby");
      const leads = await leadsOf(id);
      expect(leads).toHaveLength(1);
      expect(leads[0]).toEqual({
        key: expect.stringMatching(/^g_[0-9a-f]{8}$/),
        name: "Leader lobby",
        kind: "leads",
        size: null,
        tag: "",
        marker: "",
        channelId: `made-${leads[0].key as string}`,
        captainId: null,
        memberIds: [],
      });
      // The teams are exactly as they were written.
      expect((await groupsOf(id))[0]).toMatchObject({
        key: A,
        memberIds: ["u1"],
        channelId: A_CH,
      });
      expect((await raw(id)).liveEditRevision).toBe(1);
      expect(calls).toEqual(["create", "leads"]);
    });

    it("saving it on again is already applied and writes nothing", async () => {
      const id = await makeEvent();
      await run(id, true, false);
      const again = await run(id, true, false);
      expect(again.status).toBe("done");
      expect(await leadsOf(id)).toHaveLength(1);
      expect((await raw(id)).liveEditRevision).toBe(1);
    });

    it("an event saved before the switch with a leads group reads as on and keeps working", async () => {
      const id = await makeEvent([
        {
          key: LOBBY,
          name: "Command",
          kind: "leads",
          channelId: LOBBY_CH,
        },
      ]);
      const again = await run(id, true, false);
      expect(again.status).toBe("done");
      expect(await leadsOf(id)).toHaveLength(1);
      expect((await leadsOf(id))[0]).toMatchObject({
        key: LOBBY,
        name: "Command",
        channelId: LOBBY_CH,
      });
      expect(calls).toEqual([]);
    });

    it("the conditional push never makes a second leads group: the kind condition holds in the real filter", async () => {
      const id = await makeEvent([
        { key: LOBBY, name: "Command", kind: "leads", channelId: LOBBY_CH },
      ]);
      const outcome = await addGroupLocked(
        {
          eventId: id,
          guildId: GUILD,
          ending: () => false,
          effects,
        },
        {
          key: "g_0000beef",
          name: "Second lobby",
          kind: "leads",
          size: null,
          tag: "",
        },
        { captainsEnabled: true },
      );
      expect(outcome).toEqual({ status: "lost" });
      expect(await leadsOf(id)).toHaveLength(1);
      expect(await groupsOf(id)).toHaveLength(3);
    });

    it("the push is conditional on leaders still being on, the exact count and an unstored key", async () => {
      const id = await makeEvent([], { captainsEnabled: false });
      const filter = (over: Raw): Raw => ({
        _id: new mongoose.Types.ObjectId(id),
        groupsEnabled: true,
        ...over,
      });
      const push = { $push: { groups: { key: "g_0000beef", kind: "leads" } } };
      // Leaders off: nothing matches.
      expect(
        (await Event.updateOne(filter({ captainsEnabled: true }), push))
          .matchedCount,
      ).toBe(0);
      // A count that is not the one read: nothing matches.
      expect(
        (await Event.updateOne(filter({ groups: { $size: 5 } }), push))
          .matchedCount,
      ).toBe(0);
      // A key that is stored already: nothing matches.
      expect(
        (await Event.updateOne(filter({ "groups.key": { $ne: A } }), push))
          .matchedCount,
      ).toBe(0);
      expect(await groupsOf(id)).toHaveLength(2);
    });

    it("turning it off removes the group through the real channel pass: channel deleted first, record pulled, teams untouched", async () => {
      const id = await makeEvent([
        {
          key: LOBBY,
          name: "Leader lobby",
          kind: "leads",
          channelId: LOBBY_CH,
        },
      ]);
      const out = await offConfirmed(id);
      expect(outcomeOf(out)).toBe("done:captainsLobby");
      expect(await leadsOf(id)).toEqual([]);
      expect([...deleted]).toEqual([`/channels/${LOBBY_CH}`]);
      expect((await groupsOf(id)).map((g) => g.key)).toEqual([A, B]);
      expect((await groupsOf(id))[1]).toMatchObject({
        key: B,
        memberIds: ["u2"],
        channelId: B_CH,
      });
    });

    it("a lobby whose channelId was never written is pulled as readily as one stored as null, without asking", async () => {
      const inserted = await Event.collection.insertOne({
        guildId: GUILD,
        title: "Old row",
        startTime: new Date(Date.now() + 3_600_000),
        createdBy: "host",
        state: "active",
        groupsEnabled: true,
        captainsEnabled: true,
        groups: [
          { key: A, name: "Solo", kind: "team", memberIds: ["u1"] },
          { key: B, name: "Duo", kind: "team", memberIds: [] },
          { key: LOBBY, name: "Command", kind: "leads", memberIds: [] },
        ],
      });
      const oldId = String(inserted.insertedId);
      // Nobody is connected to a voice channel of the event: no confirmation.
      voiceInUse = false;
      const out = await run(oldId, false, true);
      expect(outcomeOf(out)).toBe("done:captainsLobby");
      expect((await groupsOf(oldId)).map((g) => g.key)).toEqual([A, B]);
    });

    it("nobody connected: a lobby with a channel is removed without asking, through the real channel pass", async () => {
      const id = await makeEvent([
        {
          key: LOBBY,
          name: "Leader lobby",
          kind: "leads",
          channelId: LOBBY_CH,
        },
      ]);
      voiceInUse = false;
      const out = await run(id, false, true);
      expect(outcomeOf(out)).toBe("done:captainsLobby");
      expect(await leadsOf(id)).toEqual([]);
      expect([...deleted]).toEqual([`/channels/${LOBBY_CH}`]);
    });

    it("a lobby whose channel could not be deleted stays; saving it off again finishes it", async () => {
      const id = await makeEvent([
        {
          key: LOBBY,
          name: "Leader lobby",
          kind: "leads",
          channelId: LOBBY_CH,
        },
      ]);
      const original = effects.removeGroupChannel;
      effects.removeGroupChannel = async () => ({
        status: "failed",
        reason: "Missing Permissions",
      });
      try {
        const out = await offConfirmed(id);
        expect(out.status).toBe("done");
        expect(out.status === "done" && out.notApplied).toHaveLength(1);
      } finally {
        effects.removeGroupChannel = original;
      }
      expect(await leadsOf(id)).toHaveLength(1);
      const again = await offConfirmed(id);
      expect(outcomeOf(again)).toBe("done:captainsLobby");
      expect(await leadsOf(id)).toEqual([]);
    });

    it("the lobby the event form's validator builds is stored with exactly its fields and reads as on", async () => {
      const result = validateGroupSetup(
        {
          enabled: true,
          presetId: "",
          groupLabel: "",
          leaderLabel: "Captain",
          captainsEnabled: true,
          captainsLobby: true,
          channelLeadMinutes: "",
          rows: [
            {
              position: 1,
              name: "Red",
              kind: "team",
              size: "",
              tag: "",
              marker: "",
            },
          ],
        },
        { maxCount: 15 },
      );
      if (!result.ok) throw new Error(result.errors.join(" "));
      const event = await Event.create({
        guildId: GUILD,
        title: "Cup",
        startTime: new Date(Date.now() + 3_600_000),
        createdBy: "host",
        ...result.setup,
      });
      const id = String(event._id);
      const stored = await groupsOf(id);
      expect(stored.map((g) => [g.name, g.kind])).toEqual([
        ["Red", "team"],
        ["Captain lobby", "leads"],
      ]);
      expect(stored[1]).toEqual({
        key: expect.stringMatching(/^g_[0-9a-f]{8}$/),
        name: "Captain lobby",
        kind: "leads",
        size: null,
        tag: "",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: [],
      });
    });

    it("never turns it on while groups are off", async () => {
      const id = await makeEvent([], { groupsEnabled: false });
      const out = await run(id, true, false);
      expect(out.status).toBe("invalid");
      expect(await leadsOf(id)).toEqual([]);
    });
  },
);
