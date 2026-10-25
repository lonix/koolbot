/**
 * The rows of the scheduled announcements and the poll schedules that the bot
 * permission check reads (#1481): which channel each one posts to, whether it
 * sends an embed, and whom its text pings. Read-only, one query per collection,
 * and with the same filter the services load their schedules with
 * (`{ guildId, enabled: true }`), so the check and the poster agree on which
 * rows are live. Only the four fields the check needs are fetched.
 */

export type ScheduleSource = "announcements" | "polls";

/** What the permission check needs to know about one schedule. */
export interface ScheduleRow {
  channelId: string;
  /** The row sends an embed (an announcement with `embedData`). */
  embed: boolean;
  /** The text pings `@everyone` or `@here`. */
  everyone: boolean;
  /** Roles the text pings (`<@&id>`, or a poll's role to ping). */
  roleIds: string[];
}

/** An `@everyone` or `@here` in the text. */
const EVERYONE = /@(?:everyone|here)\b/;
const ROLE_MENTION = /<@&(\d+)>/g;

/**
 * What a message text pings. Only the text counts: an embed never notifies
 * anyone. A placeholder that expands to a mention is not seen (it is expanded
 * at send time).
 */
export function mentionsIn(text: string): {
  everyone: boolean;
  roleIds: string[];
} {
  return {
    everyone: EVERYONE.test(text),
    roleIds: [...new Set([...text.matchAll(ROLE_MENTION)].map((m) => m[1]))],
  };
}

/** The enabled schedules of one server. Rejects when Mongo cannot be read. */
export async function readScheduleRows(
  guildId: string,
  source: ScheduleSource,
): Promise<ScheduleRow[]> {
  if (source === "announcements") {
    const { ScheduledAnnouncement } =
      await import("../models/scheduled-announcement.js");
    const rows = await ScheduledAnnouncement.find(
      { guildId, enabled: true },
      { channelId: 1, message: 1, embedData: 1 },
    ).lean();
    return rows.map((row) => ({
      channelId: row.channelId,
      embed: !!row.embedData,
      ...mentionsIn(row.message ?? ""),
    }));
  }
  const { PollSchedule } = await import("../models/poll-schedule.js");
  const rows = await PollSchedule.find(
    { guildId, enabled: true },
    { channelId: 1, roleIdToPing: 1 },
  ).lean();
  return rows.map((row) => ({
    channelId: row.channelId,
    embed: false,
    everyone: false,
    roleIds: row.roleIdToPing ? [row.roleIdToPing] : [],
  }));
}
