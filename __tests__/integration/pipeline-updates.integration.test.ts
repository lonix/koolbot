import { describe, it, expect, beforeAll, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import { LfgPost } from "../../src/models/lfg-post.js";
import { PollTurnout } from "../../src/models/poll-turnout.js";
import { EventService } from "../../src/services/event-service.js";
import { LfgService } from "../../src/services/lfg-service.js";
import { PollParticipationTracker } from "../../src/services/poll-participation-tracker.js";

/**
 * Mongoose 9 rejects an aggregation-pipeline update unless `updatePipeline: true`
 * is passed (#1103). The mocked unit tests only see the options handed to a
 * stub, so they cannot tell whether Mongoose accepts them; these run the real
 * service methods against a real server and assert the stored documents.
 */
describeWithMongo("pipeline updates against a real MongoDB (#1103)", () => {
  useRealMongo();

  // The methods under test touch only models, never the Discord client.
  const client = {} as Client;

  beforeAll(async () => {
    await Promise.all([Event.init(), LfgPost.init(), PollTurnout.init()]);
  });

  describe("EventService.setRsvp / removeRsvp", () => {
    const events = () => EventService.getInstance(client);

    it("adds, switches and removes a member's RSVP", async () => {
      const event = await Event.create({
        guildId: "guild-1",
        title: "Game night",
        startTime: new Date(Date.now() + 3_600_000),
        createdBy: "host",
        announcementMessageId: "msg-1",
      });
      const id = String(event._id);

      const added = await events().setRsvp(id, "user-a", "going", "msg-1");
      expect(added?.rsvps.map((r) => [r.userId, r.status])).toEqual([
        ["user-a", "going"],
      ]);

      await events().setRsvp(id, "user-b", "maybe", "msg-1");
      const switched = await events().setRsvp(id, "user-a", "cant", "msg-1");
      expect(switched?.rsvps.map((r) => [r.userId, r.status]).sort()).toEqual([
        ["user-a", "cant"],
        ["user-b", "maybe"],
      ]);

      const stored = await Event.findById(id).lean();
      expect(stored?.rsvps).toHaveLength(2);
      expect(stored?.rsvps.find((r) => r.userId === "user-a")?.status).toBe(
        "cant",
      );

      // Ended events are not announcement-rendered, so removeRsvp needs no
      // Discord client; setRsvp itself refuses them, which is asserted too.
      await Event.updateOne({ _id: id }, { $set: { state: "ended" } });
      expect(await events().setRsvp(id, "user-c", "going", "msg-1")).toBeNull();

      const result = await events().removeRsvp("guild-1", "user-a");
      expect(result).toEqual({ matched: 1, removed: 1, rendersFailed: 0 });
      const after = await Event.findById(id).lean();
      expect(after?.rsvps.map((r) => r.userId)).toEqual(["user-b"]);
    });
  });

  describe("LfgService.joinPost", () => {
    const lfg = () => LfgService.getInstance(client);

    beforeEach(async () => {
      await LfgPost.deleteMany({});
    });

    it("appends the member and closes the post once it is full", async () => {
      const post = await LfgPost.create({
        guildId: "guild-1",
        hostId: "host",
        game: "Chess",
        partySize: 2,
        memberIds: ["host"],
        channelId: "chan",
        state: "open",
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      const id = String(post._id);

      const joined = await lfg().joinPost(id, "user-a");
      expect(joined.status).toBe("joined");

      const stored = await LfgPost.findById(id).lean();
      expect(stored?.memberIds).toEqual(["host", "user-a"]);
      expect(stored?.state).toBe("closed");
      expect(stored?.closeReason).toBe("full");
      expect(stored?.renderPending).toBe(true);

      expect((await lfg().joinPost(id, "user-b")).status).toBe("closed");
    });
  });

  describe("PollParticipationTracker turnout upsert", () => {
    it("upserts the turnout row and accumulates votes and voters", async () => {
      const tracker = PollParticipationTracker.getInstance(client);
      // recordTurnout reconnects through its own guard; the suite already has
      // a live connection, so skip that step.
      (tracker as unknown as { mongo: unknown }).mongo = {
        ensureConnection: async () => undefined,
      };
      type Internals = {
        recordTurnout: (
          guildId: string,
          message: Record<string, unknown>,
          userId: string,
          now: Date,
        ) => Promise<void>;
      };
      const record = (userId: string): Promise<void> =>
        (tracker as unknown as Internals).recordTurnout(
          "guild-1",
          { id: "msg-1", channelId: "chan-1", createdAt: new Date(0) },
          userId,
          new Date(),
        );

      await record("user-a"); // insert via upsert
      await record("user-b"); // update the existing row
      await record("user-a"); // same voter again: votes +1, voters unchanged

      const rows = await PollTurnout.find({ messageId: "msg-1" }).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0].votesCast).toBe(3);
      expect([...rows[0].voterIds].sort()).toEqual(["user-a", "user-b"]);
      expect(rows[0].channelId).toBe("chan-1");
    });
  });
});
