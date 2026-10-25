import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { ScheduledAnnouncement } from "../../src/models/scheduled-announcement.js";
import { PollSchedule } from "../../src/models/poll-schedule.js";
import { readScheduleRows } from "../../src/services/schedule-posting-rows.js";

/**
 * The bot permission check reads the channel of each schedule row (#1481).
 * The unit tests stub the reader, so they cannot show that the query matches
 * what the services load (`{ guildId, enabled: true }`), that the projection
 * keeps the fields the check reads, or that `embedData` is absent (not an empty
 * object) on a row saved without one. These run against a real server.
 */
describeWithMongo("schedule rows for the permission check (#1481)", () => {
  useRealMongo();

  beforeAll(async () => {
    await ScheduledAnnouncement.init();
    await PollSchedule.init();
  });

  beforeEach(async () => {
    await ScheduledAnnouncement.deleteMany({});
    await PollSchedule.deleteMany({});
  });

  const announcement = (fields: Record<string, unknown>) =>
    ScheduledAnnouncement.create({
      guildId: "g1",
      channelId: "c1",
      cronSchedule: "0 9 * * *",
      message: "Hello",
      createdBy: "u1",
      ...fields,
    });
  const poll = (fields: Record<string, unknown>) =>
    PollSchedule.create({
      guildId: "g1",
      channelId: "p1",
      cronSchedule: "0 9 * * *",
      createdBy: "u1",
      ...fields,
    });

  it("returns the enabled announcements of one server only", async () => {
    await announcement({ channelId: "c1" });
    await announcement({ channelId: "c2", enabled: false });
    await announcement({ channelId: "other", guildId: "g2" });
    const rows = await readScheduleRows("g1", "announcements");
    expect(rows.map((r) => r.channelId)).toEqual(["c1"]);
  });

  it("reads an embed, and the pings in the text", async () => {
    await announcement({
      channelId: "c1",
      message: "Hi @everyone and <@&111>",
      embedData: { title: "News" },
    });
    await announcement({ channelId: "c2", message: "Plain" });
    const rows = await readScheduleRows("g1", "announcements");
    const byChannel = Object.fromEntries(rows.map((r) => [r.channelId, r]));
    expect(byChannel.c1).toEqual({
      channelId: "c1",
      embed: true,
      everyone: true,
      roleIds: ["111"],
    });
    expect(byChannel.c2).toEqual({
      channelId: "c2",
      embed: false,
      everyone: false,
      roleIds: [],
    });
  });

  it("agrees with the service on whether a row has an embed", async () => {
    await announcement({ channelId: "c1" });
    await announcement({ channelId: "c2", embedData: { title: "News" } });
    // The service loads full documents and tests `announcement.embedData`.
    const docs = await ScheduledAnnouncement.find({ guildId: "g1" });
    const rows = await readScheduleRows("g1", "announcements");
    for (const doc of docs) {
      const mine = rows.find((r) => r.channelId === doc.channelId);
      expect(mine?.embed).toBe(!!doc.embedData);
    }
  });

  it("matches the service's filter on a row saved without an enabled field", async () => {
    const now = new Date();
    await ScheduledAnnouncement.collection.insertOne({
      guildId: "g1",
      channelId: "raw",
      cronSchedule: "0 9 * * *",
      message: "Hello",
      createdBy: "u1",
      createdAt: now,
      updatedAt: now,
    });
    const viaService = await ScheduledAnnouncement.find({
      guildId: "g1",
      enabled: true,
    });
    const rows = await readScheduleRows("g1", "announcements");
    expect(rows.map((r) => r.channelId)).toEqual(
      viaService.map((d) => d.channelId),
    );
    expect(rows).toHaveLength(0);
  });

  it("returns the enabled poll schedules with the role to ping", async () => {
    await poll({ channelId: "p1", roleIdToPing: "222" });
    await poll({ channelId: "p2" });
    await poll({ channelId: "p3", enabled: false });
    await poll({ channelId: "other", guildId: "g2" });
    const rows = await readScheduleRows("g1", "polls");
    const byChannel = Object.fromEntries(rows.map((r) => [r.channelId, r]));
    expect(Object.keys(byChannel).sort()).toEqual(["p1", "p2"]);
    expect(byChannel.p1.roleIds).toEqual(["222"]);
    expect(byChannel.p2.roleIds).toEqual([]);
    expect(byChannel.p1.embed).toBe(false);
  });
});
