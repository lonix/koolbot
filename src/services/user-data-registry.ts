/**
 * The per-user data registry (#719).
 *
 * This module is the allowlist that decides what a member gets when they
 * download their data from `/me/privacy`. It is deliberately a *declaration*
 * rather than a query: enumerating collections by hand inside the export
 * service rots the moment a new model lands, and the failure is silent in
 * both directions — a new model either leaks into a member's export or is
 * quietly missed.
 *
 * Every field in the codebase that carries a Discord user id is listed here
 * exactly once, classified as `exportable` (it is the member's own data) or
 * not (moderation/admin surface, session infrastructure, or an admin-authored
 * object that merely records who created it). `__tests__/config/user-data-registry-drift.test.ts`
 * scans `src/models/*.ts` and `src/database/schema.ts` for user-id-shaped
 * fields and fails the build when one is missing here — so a new per-user
 * model *has* to be triaged before it ships, the same way
 * `settings-doc-drift.test.ts` forces a new config key to be documented.
 *
 * Deletion (#906) consumes this same registry; keep the classifications
 * honest rather than convenient.
 */

/** Where a registry entry's schema is declared, repo-relative. */
export type UserDataSource = `src/${string}.ts`;

export interface UserDataField {
  /** File declaring the schema, repo-relative (the drift scan reads it). */
  source: UserDataSource;
  /**
   * Logical collection label. Doubles as the key this collection's rows
   * appear under in a member's export payload, so it is kebab-case and
   * stable — renaming one changes the shape of every future export.
   */
  collection: string;
  /** The schema field carrying a Discord user id. */
  field: string;
  /**
   * True when rows matched by this field are the member's own data and
   * belong in their export. False marks a deliberate exclusion; `note`
   * then has to say why.
   */
  exportable: boolean;
  /**
   * Whether rows are scoped by `guildId`. `false` means the collection is
   * keyed on the user id alone: moot while the bot is single-guild via
   * `GUILD_ID`, but recorded so a future multi-guild change surfaces every
   * cross-guild read in one place instead of one model at a time.
   */
  guildScoped: boolean;
  /** Why this field is classified the way it is. Required on every entry. */
  note: string;
}

/**
 * The registry. Grouped by classification, then by model, so a reviewer can
 * read the "what does a member get" half without the exclusions in between.
 */
export const USER_DATA_REGISTRY: readonly UserDataField[] = [
  // ---------------------------------------------------------------
  // Included — the member's own data
  // ---------------------------------------------------------------
  {
    source: "src/models/voice-channel-tracking.ts",
    collection: "voice-channel-tracking",
    field: "userId",
    exportable: true,
    guildScoped: false,
    note: "The member's voice history: totals, per-session detail, monthly/yearly rollups.",
  },
  {
    source: "src/models/voice-channel-tracking.ts",
    collection: "voice-channel-tracking",
    field: "otherUsers",
    exportable: true,
    guildScoped: false,
    note: "Co-present member ids stored inside the member's own session rows; already surfaced to them on Rewind.",
  },
  {
    source: "src/models/voice-channel-tracking.ts",
    collection: "voice-channel-tracking",
    field: "companions",
    exportable: true,
    guildScoped: false,
    note: "Per-companion overlap seconds on the member's own sessions (#570); same visibility as `otherUsers`.",
  },
  {
    source: "src/models/voice-channel-tracking.ts",
    collection: "voice-channel-tracking",
    field: "joinedExisting",
    exportable: true,
    guildScoped: false,
    note: "Who was already in the channel when the member joined (#570); part of their own session row.",
  },
  {
    source: "src/models/message-activity-tracking.ts",
    collection: "message-activity-tracking",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Per-channel message counts plus the thin recent-message detail retained for recaps.",
  },
  {
    source: "src/models/reaction-activity-tracking.ts",
    collection: "reaction-activity-tracking",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Lifetime and per-year reaction counters (given and received).",
  },
  {
    source: "src/models/poll-participation-tracking.ts",
    collection: "poll-participation-tracking",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "The member's poll-vote counters (lifetime, per-year, per-week).",
  },
  {
    source: "src/models/poll-turnout.ts",
    collection: "poll-turnout",
    field: "voterIds",
    exportable: true,
    guildScoped: true,
    note: "Shared per-poll aggregate: the export lists only the polls the member voted on, never the other voter ids on those rows.",
  },
  {
    source: "src/models/user-achievements.ts",
    collection: "user-achievements",
    field: "userId",
    exportable: true,
    guildScoped: false,
    note: "Accolades and achievements earned, with the values that earned them.",
  },
  {
    source: "src/models/user-birthday.ts",
    collection: "user-birthday",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "The birthday the member set on /me/birthday, including the optional year.",
  },
  {
    source: "src/models/user-notification-prefs.ts",
    collection: "user-notification-prefs",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "DM opt-ins and the member's chosen display timezone.",
  },
  {
    source: "src/models/user-voice-preferences.ts",
    collection: "user-voice-preferences",
    field: "userId",
    exportable: true,
    guildScoped: false,
    note: "Channel name pattern and saved voice presets.",
  },
  {
    source: "src/models/rewind-snapshot.ts",
    collection: "rewind-snapshot",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Frozen year-in-review summaries — the same recap the member already reads at /me/rewind.",
  },
  {
    source: "src/models/rewind-nudge-state.ts",
    collection: "rewind-nudge-state",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Which years the end-of-year Rewind DM was sent for.",
  },
  {
    source: "src/models/digest-state.ts",
    collection: "digest-state",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Weekly-digest delivery state: last send, last week's total and rank, streak.",
  },
  {
    source: "src/models/reminder.ts",
    collection: "reminder",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Reminders the member set for themselves, pending and recently delivered.",
  },
  {
    source: "src/models/event.ts",
    collection: "event-rsvp",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Nested `rsvps[].userId`: the export carries the event and the member's own RSVP, not the other attendees'.",
  },
  {
    source: "src/models/leaderboard-role-assignment.ts",
    collection: "leaderboard-role-assignment",
    field: "userIds",
    exportable: true,
    guildScoped: true,
    note: "Shared roster row: the export says which reward roles currently list the member, never who else is on them.",
  },
  {
    // Quotes are defined outside `src/models/` — easy to miss when
    // enumerating by hand, and they carry two distinct user fields.
    source: "src/database/schema.ts",
    collection: "quote",
    field: "authorId",
    exportable: true,
    guildScoped: false,
    note: "Quotes attributed to the member (what they were quoted as saying). No guildId on the schema.",
  },
  {
    source: "src/database/schema.ts",
    collection: "quote",
    field: "addedById",
    exportable: true,
    guildScoped: false,
    note: "Quotes the member saved for someone else. Distinct from `authorId` — same row, different person.",
  },
  {
    source: "src/models/channel-invite.ts",
    collection: "channel-invite",
    field: "userId",
    exportable: true,
    guildScoped: false,
    note: "Voice-channel invites the member received. No guildId on the schema.",
  },
  {
    source: "src/models/channel-invite.ts",
    collection: "channel-invite",
    field: "invitedBy",
    exportable: true,
    guildScoped: false,
    note: "The other half of the same row — invites the member sent. Both sides are the member's own activity.",
  },

  // ---------------------------------------------------------------
  // Excluded — moderation, audit, infrastructure, admin-authored config
  // ---------------------------------------------------------------
  {
    source: "src/models/moderation-log.ts",
    collection: "moderation-log",
    field: "userId",
    exportable: false,
    guildScoped: true,
    note: "Moderation record. A warned member must not be able to read their own moderation history out of a self-service endpoint.",
  },
  {
    source: "src/models/moderation-log.ts",
    collection: "moderation-log",
    field: "moderatorId",
    exportable: false,
    guildScoped: true,
    note: "Exposes which moderator acted — an abuse surface on top of the record itself.",
  },
  {
    source: "src/models/discord-command-audit-log.ts",
    collection: "discord-command-audit-log",
    field: "discordUserId",
    exportable: false,
    guildScoped: true,
    note: "Admin audit trail, not member data.",
  },
  {
    source: "src/models/web-audit-log.ts",
    collection: "web-audit-log",
    field: "discordUserId",
    exportable: false,
    guildScoped: true,
    note: "Admin audit trail, not member data. (The export itself writes a row here.)",
  },
  {
    source: "src/models/web-session.ts",
    collection: "web-session",
    field: "discordUserId",
    exportable: false,
    guildScoped: true,
    note: "Session infrastructure — token hashes and expiry, not user data.",
  },
  {
    source: "src/models/voice-channel-ownership.ts",
    collection: "voice-channel-ownership",
    field: "ownerId",
    exportable: false,
    guildScoped: true,
    note: "Ephemeral runtime state; the row is gone as soon as the channel is cleaned up.",
  },
  {
    source: "src/models/bot-status-message.ts",
    collection: "bot-status-message",
    field: "createdBy",
    exportable: false,
    guildScoped: true,
    note: "Admin-authored config object; records only who created it.",
  },
  {
    source: "src/models/notice.ts",
    collection: "notice",
    field: "createdBy",
    exportable: false,
    guildScoped: true,
    note: "Admin-authored config object; records only who created it.",
  },
  {
    source: "src/models/poll-item.ts",
    collection: "poll-item",
    field: "createdBy",
    exportable: false,
    guildScoped: true,
    note: "Admin-authored poll-library entry; records only who imported it.",
  },
  {
    source: "src/models/poll-schedule.ts",
    collection: "poll-schedule",
    field: "createdBy",
    exportable: false,
    guildScoped: true,
    note: "Admin-authored schedule; records only who created it.",
  },
  {
    source: "src/models/scheduled-announcement.ts",
    collection: "scheduled-announcement",
    field: "createdBy",
    exportable: false,
    guildScoped: true,
    note: "Admin-authored announcement; records only who created it.",
  },
  {
    source: "src/models/event.ts",
    collection: "event",
    field: "createdBy",
    exportable: false,
    guildScoped: true,
    note: "Admin-authored event object; records only who scheduled it. The member's RSVP on the same row IS exported (see `event-rsvp`).",
  },
];

/** Registry entries that belong in a member's export, in registry order. */
export const EXPORTABLE_USER_DATA: readonly UserDataField[] =
  USER_DATA_REGISTRY.filter((entry) => entry.exportable);

/** Distinct collection labels appearing in a member's export. */
export const EXPORTABLE_COLLECTIONS: readonly string[] = [
  ...new Set(EXPORTABLE_USER_DATA.map((entry) => entry.collection)),
];

/** Deliberate exclusions, for the "what isn't in here" copy on /me/privacy. */
export const EXCLUDED_USER_DATA: readonly UserDataField[] =
  USER_DATA_REGISTRY.filter((entry) => !entry.exportable);

/**
 * Words that mark a schema field as pointing at a *person* rather than a
 * channel, message, guild or role. Used by `isUserIdFieldName` below, which
 * the drift test runs over every schema source file.
 */
const PERSON_TOKENS = [
  "user",
  "member",
  "owner",
  "author",
  "moderator",
  "voter",
  "creator",
  "recipient",
  "sender",
  "assignee",
  "invited",
  "added",
];

/**
 * Whether a schema field name looks like it holds a Discord user id.
 *
 * Three shapes count:
 *   - anything ending in `By` (`createdBy`, `invitedBy`) — those only ever
 *     name a person;
 *   - an `…Id`/`…Ids` name whose prefix contains a person word
 *     (`userId`, `voterIds`, `discordUserId`, `addedById`);
 *   - a bare `…Users`/`…Members` collection field (`otherUsers`).
 *
 * `channelId`, `messageId`, `guildId`, `roleId` and friends deliberately do
 * not match. The heuristic cannot be exhaustive — a future `subscriberId`
 * would slip past it — but it catches every naming convention the codebase
 * actually uses, and the drift test's reverse check (every registry entry
 * must name a field that still exists) keeps the two halves honest.
 */
export function isUserIdFieldName(name: string): boolean {
  if (/^[A-Za-z]+By$/.test(name)) return true;
  const idMatch = /^([A-Za-z]*?)Ids?$/i.exec(name);
  if (idMatch && idMatch[1].length > 0) {
    const prefix = idMatch[1].toLowerCase();
    if (PERSON_TOKENS.some((token) => prefix.includes(token))) return true;
  }
  return /(?:^|[a-z])(?:Users|Members|users|members)$/.test(name);
}
