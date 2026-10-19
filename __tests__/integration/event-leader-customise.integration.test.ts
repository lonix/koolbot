import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { ConfigService } from "../../src/services/config-service.js";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import {
  customiseGroup,
  resetGroupCustomisation,
  type CustomiseDeps,
} from "../../src/services/event-leader-customise.js";
import { EventGroupChannels } from "../../src/services/event-group-channels.js";

/**
 * The leader customiser (#1196) writes `groups.$[g].<field>` with `arrayFilters`
 * under a `$elemMatch` filter that also tests `captainId`, `memberIds`, the old
 * `name` and (for the first edit) that `originalName` is still absent (`$in`
 * with null), mixes `$set` with `$unset`, and records a control message with
 * `controlMessageId: null` inside a `$elemMatch` (matching a field that was
 * never written). The unit suites use an in-memory stand-in for the model, so
 * they cannot tell whether MongoDB accepts those shapes or what
 * `modifiedCount` is; these run the real writers against a real server.
 */
const GUILD = "guild-1";
const RED = "g_00000001";
const BLUE = "g_00000002";
const LEADER = "100000000000000001";
const MEMBER = "100000000000000002";
const OTHER = "100000000000000003";
const RED_CH = "200000000000000001";
const BLUE_CH = "200000000000000002";

const deps: CustomiseDeps = {
  eventsEnabled: async () => true,
  syncName: async (_g, _e, key) => ({ groupKey: key, status: "applied" }),
  retag: () => undefined,
};

describeWithMongo(
  "the leader customiser against a real MongoDB (#1196)",
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
        captainsEnabled: true,
        captainCustomisationEnabled: true,
        tagsEnabled: true,
        groups: [
          {
            key: RED,
            name: "Red",
            tag: "RED",
            kind: "team",
            channelId: RED_CH,
            captainId: LEADER,
            memberIds: [LEADER, MEMBER],
          },
          {
            key: BLUE,
            name: "Blue",
            tag: "BLU",
            kind: "team",
            channelId: BLUE_CH,
            captainId: OTHER,
            memberIds: [OTHER],
          },
        ],
        ...over,
      });
      return String(event._id);
    }
    const group = async (id: string, key = RED) =>
      (await Event.findById(id).lean())!.groups.find((g) => g.key === key)!;
    const edit = (id: string, over: Record<string, unknown> = {}) =>
      customiseGroup(
        {
          guildId: GUILD,
          eventId: id,
          groupKey: RED,
          actorId: LEADER,
          channelId: RED_CH,
          rawName: "Crimson",
          rawTag: "CRM",
          ...over,
        } as Parameters<typeof customiseGroup>[0],
        deps,
      );

    it("a leader's first edit stores the change, the host's originals and the pending flag in one write", async () => {
      const id = await makeEvent();
      const r = await edit(id);
      expect(r).toMatchObject({ ok: true, changed: true });
      const g = await group(id);
      expect(g).toMatchObject({
        name: "Crimson",
        tag: "CRM",
        originalName: "Red",
        originalTag: "RED",
        nameSyncPending: true,
        captainId: LEADER,
        memberIds: [LEADER, MEMBER],
        channelId: RED_CH,
      });
      // The other team is untouched.
      expect(await group(id, BLUE)).toMatchObject({ name: "Blue", tag: "BLU" });
    });

    it("a second edit keeps the originals", async () => {
      const id = await makeEvent();
      await edit(id);
      await edit(id, { rawName: "Scarlet", rawTag: "SCR" });
      expect(await group(id)).toMatchObject({
        name: "Scarlet",
        tag: "SCR",
        originalName: "Red",
        originalTag: "RED",
      });
    });

    it.each([
      ["not the leader", { actorId: MEMBER }],
      ["another team's leader", { actorId: OTHER }],
    ])("%s writes nothing", async (_n, over) => {
      const id = await makeEvent();
      const r = await edit(id, over);
      expect(r.ok).toBe(false);
      expect(await group(id)).toMatchObject({ name: "Red", tag: "RED" });
    });

    it.each([
      ["customisation off", { captainCustomisationEnabled: false }],
      ["leaders off", { captainsEnabled: false }],
      ["event ended", { state: "ended" }],
      [
        "an event without the field at all",
        { captainCustomisationEnabled: undefined },
      ],
    ])("%s writes nothing", async (_n, over) => {
      const id = await makeEvent(over);
      if (
        "captainCustomisationEnabled" in over &&
        over.captainCustomisationEnabled === undefined
      ) {
        await Event.collection.updateOne(
          { _id: (await Event.findById(id))!._id },
          { $unset: { captainCustomisationEnabled: "" } },
        );
      }
      const r = await edit(id);
      expect(r.ok).toBe(false);
      expect(await group(id)).toMatchObject({ name: "Red", tag: "RED" });
    });

    it("refuses someone who is no longer the stored leader (the gate and the write filter agree; the read-to-write race itself is in the unit suite)", async () => {
      const id = await makeEvent();
      // Make the filter fail exactly as a lost race would: the stored leader changed.
      await Event.updateOne(
        { _id: id },
        { $set: { "groups.$[g].captainId": MEMBER } },
        { arrayFilters: [{ "g.key": RED }] },
      );
      const r = await edit(id, { actorId: LEADER });
      expect(r.ok).toBe(false);
      expect(await group(id)).toMatchObject({ name: "Red" });
    });

    it("the host's reset restores the originals and removes them", async () => {
      const id = await makeEvent();
      await edit(id);
      const r = await resetGroupCustomisation(
        { guildId: GUILD, eventId: id, groupKey: RED },
        deps,
      );
      expect(r).toMatchObject({ ok: true, changed: true });
      const g = await group(id);
      expect(g).toMatchObject({
        name: "Red",
        tag: "RED",
        nameSyncPending: true,
      });
      expect(g.originalName).toBeUndefined();
      expect(g.originalTag).toBeUndefined();
      // A second reset has nothing to go back to.
      expect(
        await resetGroupCustomisation(
          { guildId: GUILD, eventId: id, groupKey: RED },
          deps,
        ),
      ).toMatchObject({ ok: true, changed: false });
    });

    describe("the channel pass", () => {
      function channelsWith(
        names: Map<string, string>,
        sent: string[],
      ): EventGroupChannels {
        const rest = {
          patch: async (route: string, o: { body: { name: string } }) => {
            sent.push(o.body.name);
            names.set(/channels\/(\d+)/.exec(route)![1], o.body.name);
            return {};
          },
          post: async () => ({ id: "300000000000000001" }),
          get: async () => [],
          delete: async () => ({}),
        };
        return new EventGroupChannels(
          { user: { id: "999999999999999999" }, token: "t" } as never,
          {
            getPrefix: async () => "📅",
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
      const guildWith = (names: Map<string, string>): never =>
        ({
          id: GUILD,
          channels: {
            cache: new Map(),
            fetch: async (id: string) => ({
              id,
              name: names.get(id),
              guildId: GUILD,
            }),
          },
        }) as never;

      it("clears the pending flag only after the rename, and only for the name that was renamed", async () => {
        const id = await makeEvent();
        await edit(id);
        const names = new Map([[RED_CH, "📅 Red"]]);
        const sent: string[] = [];
        const out = await channelsWith(names, sent).syncNames(
          id,
          guildWith(names),
        );
        expect(out).toEqual([{ groupKey: RED, status: "applied" }]);
        expect(sent).toEqual(["📅 Crimson"]);
        expect((await group(id)).nameSyncPending).toBe(false);

        // A name chosen while a rename was in flight stays pending.
        await edit(id, { rawName: "Scarlet", rawTag: null });
        expect((await group(id)).nameSyncPending).toBe(true);
      });

      it("posts, records, finds and removes the control message with the real filters", async () => {
        const id = await makeEvent();
        const names = new Map<string, string>();
        const sent: string[] = [];
        const channels = channelsWith(names, sent);
        await channels.syncControls(id);
        expect(await group(id)).toMatchObject({
          controlMessageId: "300000000000000001",
          controlChannelId: RED_CH,
        });
        // Switched off: the record is cleared (the field was a real string, not missing).
        await Event.updateOne(
          { _id: id },
          { $set: { captainCustomisationEnabled: false } },
        );
        await channels.syncControls(id);
        expect((await group(id)).controlMessageId).toBeNull();
        expect((await group(id)).controlChannelId).toBeNull();
      });
    });
  },
);
