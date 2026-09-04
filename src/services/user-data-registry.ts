/**
 * The per-user data registry (#719, #913).
 *
 * This module is the allowlist that decides what a member gets when they
 * download their data from `/me/privacy`, and how a purge treats each of
 * those rows. It is deliberately a *declaration* rather than a query:
 * enumerating collections by hand inside the export service rots the moment a
 * new model lands, and the failure is silent in both directions — a new model
 * either leaks into a member's export or is quietly missed.
 *
 * Every field in the codebase that carries a Discord user id is listed here
 * exactly once, classified as `exportable` (it is the member's own data) or
 * not (moderation/admin surface, session infrastructure, or an admin-authored
 * object that merely records who created it), and — since #913 — with an
 * `onDelete` policy plus a `subject` saying whether the field makes the member
 * the row's subject or merely mentions them inside someone else's row.
 * `__tests__/config/user-data-registry-drift.test.ts` scans `src/models/*.ts`
 * and `src/database/schema.ts` for user-id-shaped fields and fails the build
 * when one is missing here — so a new per-user model *has* to be triaged on
 * both axes before it ships, the same way `settings-doc-drift.test.ts` forces
 * a new config key to be documented.
 *
 * Deletion (#906) consumes this same registry; keep the classifications
 * honest rather than convenient.
 */

/** Where a registry entry's schema is declared, repo-relative. */
export type UserDataSource = `src/${string}.ts`;

/**
 * How a purge treats rows matched by a field.
 *
 * - `hard-delete` — the row is the member's; delete the document.
 * - `pull-member` — the row is a shared aggregate; `$pull` the member's id
 *   and leave the rest of the row standing.
 * - `anonymise`   — the row belongs to someone else but attributes an action
 *   to the member; clear the attribution, keep the row.
 * - `retain`      — deliberately kept: moderation record, audit trail,
 *   infrastructure, admin-authored config, or another member's data.
 * - `expires`     — nothing to do; the row ages out on its own.
 */
export type UserDataDeletePolicy =
  "hard-delete" | "pull-member" | "anonymise" | "retain" | "expires";

/**
 * Whether a field makes the member the row's *subject*, or merely mentions
 * them inside a row that belongs to someone else.
 */
export type UserDataSubject = "self" | "mention";

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
  /** How a purge treats rows matched by this field. */
  onDelete: UserDataDeletePolicy;
  /**
   * Whether this field makes the member the row's *subject*, or merely
   * mentions them inside a row that belongs to someone else. Export never had
   * to care; delete does, because the second kind is not the member's to
   * erase.
   */
  subject: UserDataSubject;
  /** Why this delete policy, in the registry's own words. Required on every entry. */
  deleteNote: string;
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
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "The member's own tracking document — totals, sessions and rollups all live on it, so the whole row goes.",
  },
  {
    source: "src/models/voice-channel-tracking.ts",
    collection: "voice-channel-tracking",
    field: "otherUsers",
    exportable: true,
    guildScoped: false,
    note: "Co-present member ids stored inside the member's own session rows; already surfaced to them on Rewind.",
    onDelete: "retain",
    subject: "mention",
    deleteNote:
      "Matched here, this field names the member inside *other* members' session rows. Scrubbing it means an unbounded updateMany with arrayFilters and destroys other members' companion statistics — not this member's data to erase.",
  },
  {
    source: "src/models/voice-channel-tracking.ts",
    collection: "voice-channel-tracking",
    field: "companions",
    exportable: true,
    guildScoped: false,
    note: "Per-companion overlap seconds on the member's own sessions (#570); same visibility as `otherUsers`.",
    onDelete: "retain",
    subject: "mention",
    deleteNote:
      "Per-companion overlap seconds on *other* members' sessions (#570). Same reasoning as `otherUsers`: it is their statistic, not this member's row.",
  },
  {
    source: "src/models/voice-channel-tracking.ts",
    collection: "voice-channel-tracking",
    field: "joinedExisting",
    exportable: true,
    guildScoped: false,
    note: "Who was already in the channel when the member joined (#570); part of their own session row.",
    onDelete: "retain",
    subject: "mention",
    deleteNote:
      "Records that the member was already in the channel when *someone else* joined (#570) — part of that other member's session row, so it stays.",
  },
  {
    source: "src/models/message-activity-tracking.ts",
    collection: "message-activity-tracking",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Per-channel message counts plus the thin recent-message detail retained for recaps.",
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "One row per (userId, guildId) holding only the member's own counts and recent-message detail.",
  },
  {
    source: "src/models/reaction-activity-tracking.ts",
    collection: "reaction-activity-tracking",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Lifetime and per-year reaction counters (given and received).",
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "The member's own reaction counters; nothing on the row belongs to anyone else.",
  },
  {
    source: "src/models/poll-participation-tracking.ts",
    collection: "poll-participation-tracking",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "The member's poll-vote counters (lifetime, per-year, per-week).",
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "The member's own vote counters; the shared per-poll aggregate lives in `poll-turnout`, not here.",
  },
  {
    source: "src/models/poll-turnout.ts",
    collection: "poll-turnout",
    field: "voterIds",
    exportable: true,
    guildScoped: true,
    note: "Shared per-poll aggregate: the export lists only the polls the member voted on, never the other voter ids on those rows.",
    onDelete: "pull-member",
    subject: "self",
    deleteNote:
      "Shared per-poll row: $pull the member's id only. `getTopPollTurnout` counts distinct voters as `$size: voterIds` at read time, so this retroactively lowers the public weekly recap — accepted, and the rows age out anyway via `polls.turnout.retention_days`. `votesCast` counts vote *events*, not people, and must NOT be decremented to compensate.",
  },
  {
    source: "src/models/user-achievements.ts",
    collection: "user-achievements",
    field: "userId",
    exportable: true,
    guildScoped: false,
    note: "Accolades and achievements earned, with the values that earned them.",
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "The member's own accolade/achievement row, including the values that earned them.",
  },
  {
    source: "src/models/user-birthday.ts",
    collection: "user-birthday",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "The birthday the member set on /me/birthday, including the optional year.",
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "Self-declared personal data the member entered themselves; the clearest possible hard delete.",
  },
  {
    source: "src/models/user-notification-prefs.ts",
    collection: "user-notification-prefs",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "DM opt-ins and the member's chosen display timezone.",
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "The member's own preference row; removing it returns them to the configured defaults.",
  },
  {
    source: "src/models/user-voice-preferences.ts",
    collection: "user-voice-preferences",
    field: "userId",
    exportable: true,
    guildScoped: false,
    note: "Channel name pattern and saved voice presets.",
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "Preferences the member set for their own channel; nothing else reads the row.",
  },
  {
    source: "src/models/rewind-snapshot.ts",
    collection: "rewind-snapshot",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Frozen year-in-review summaries — the same recap the member already reads at /me/rewind.",
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "Frozen per-member recaps. They are derived data, but they are derived from *this* member's history, so they go with it.",
  },
  {
    source: "src/models/rewind-nudge-state.ts",
    collection: "rewind-nudge-state",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Which years the end-of-year Rewind DM was sent for.",
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "Per-member delivery bookkeeping. Deleting it can re-send a Rewind DM for an already-nudged year; the notification opt-in still gates that.",
  },
  {
    source: "src/models/digest-state.ts",
    collection: "digest-state",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Weekly-digest delivery state: last send, last week's total and rank, streak.",
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "Per-member delivery state; deleting it resets their streak and the last-send guard, which is the expected outcome of a reset.",
  },
  {
    source: "src/models/reminder.ts",
    collection: "reminder",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Reminders the member set for themselves, pending and recently delivered.",
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "Reminders the member created for themselves; pending ones simply never fire.",
  },
  {
    source: "src/models/event.ts",
    collection: "event-rsvp",
    field: "userId",
    exportable: true,
    guildScoped: true,
    note: "Nested `rsvps[].userId`: the export carries the event and the member's own RSVP, not the other attendees'.",
    onDelete: "pull-member",
    subject: "self",
    deleteNote:
      "Nested `rsvps[]` on an admin-authored event: $pull the member's own RSVP and leave the event and the other attendees' RSVPs standing.",
  },
  {
    source: "src/models/leaderboard-role-assignment.ts",
    collection: "leaderboard-role-assignment",
    field: "userIds",
    exportable: true,
    guildScoped: true,
    note: "Shared roster row: the export says which reward roles currently list the member, never who else is on them.",
    onDelete: "pull-member",
    subject: "self",
    deleteNote:
      "Shared roster row: $pull the member's id so the next reconcile stops treating the role as already granted. The other members on the row are untouched.",
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
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "The quote is a record of what the member said; a reset removes the quotes attributed to them outright, whoever saved them.",
  },
  {
    source: "src/database/schema.ts",
    collection: "quote",
    field: "addedById",
    exportable: true,
    guildScoped: false,
    note: "Quotes the member saved for someone else. Distinct from `authorId` — same row, different person.",
    onDelete: "anonymise",
    subject: "self",
    deleteNote:
      "Same row, different person: the quote belongs to its author, so only the member's attribution as the saver is cleared.",
  },
  {
    source: "src/models/channel-invite.ts",
    collection: "channel-invite",
    field: "userId",
    exportable: true,
    guildScoped: false,
    note: "Voice-channel invites the member received. No guildId on the schema.",
    onDelete: "hard-delete",
    subject: "self",
    deleteNote:
      "Invites addressed to the member; the row exists only to let them into a channel, so it goes with them.",
  },
  {
    source: "src/models/channel-invite.ts",
    collection: "channel-invite",
    field: "invitedBy",
    exportable: true,
    guildScoped: false,
    note: "The other half of the same row — invites the member sent. Both sides are the member's own activity.",
    onDelete: "anonymise",
    subject: "self",
    deleteNote:
      "Invites the member sent to someone else: the recipient's access must survive, so only the inviter attribution is cleared.",
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
    onDelete: "retain",
    subject: "self",
    deleteNote:
      "Moderation record. A warned member erasing their own warnings from a self-service endpoint would defeat the point of keeping them.",
  },
  {
    source: "src/models/moderation-log.ts",
    collection: "moderation-log",
    field: "moderatorId",
    exportable: false,
    guildScoped: true,
    note: "Exposes which moderator acted — an abuse surface on top of the record itself.",
    onDelete: "retain",
    subject: "mention",
    deleteNote:
      "Names the moderator inside another member's record; the record is not theirs to erase, and who acted is part of it.",
  },
  {
    source: "src/models/discord-command-audit-log.ts",
    collection: "discord-command-audit-log",
    field: "discordUserId",
    exportable: false,
    guildScoped: true,
    note: "Admin audit trail, not member data.",
    onDelete: "retain",
    subject: "self",
    deleteNote:
      "Admin audit trail. An audit log a subject can erase is not an audit log; it ages out on its own retention instead.",
  },
  {
    source: "src/models/web-audit-log.ts",
    collection: "web-audit-log",
    field: "discordUserId",
    exportable: false,
    guildScoped: true,
    note: "Admin audit trail, not member data. (The export itself writes a row here.)",
    onDelete: "retain",
    subject: "self",
    deleteNote:
      "Admin audit trail — and the purge itself writes a row here, so erasing it would erase the record of the reset.",
  },
  {
    source: "src/models/web-session.ts",
    collection: "web-session",
    field: "discordUserId",
    exportable: false,
    guildScoped: true,
    note: "Session infrastructure — token hashes and expiry, not user data.",
    onDelete: "retain",
    subject: "self",
    deleteNote:
      "Session infrastructure. `WebSessionService.revokeForUser` soft-revokes ($set revokedAt) rather than destroying rows, which is the right behaviour and matches the export's classification.",
  },
  {
    source: "src/models/voice-channel-ownership.ts",
    collection: "voice-channel-ownership",
    field: "ownerId",
    exportable: false,
    guildScoped: true,
    note: "Ephemeral runtime state; the row is gone as soon as the channel is cleaned up.",
    onDelete: "expires",
    subject: "self",
    deleteNote:
      "Ephemeral runtime state: the row disappears when the channel is cleaned up, so a purge has nothing to do and deleting it mid-session would orphan a live channel.",
  },
  {
    source: "src/models/bot-status-message.ts",
    collection: "bot-status-message",
    field: "createdBy",
    exportable: false,
    guildScoped: true,
    note: "Admin-authored config object; records only who created it.",
    onDelete: "retain",
    subject: "mention",
    deleteNote:
      "Admin-authored config object belonging to the guild; it merely records who created it.",
  },
  {
    source: "src/models/notice.ts",
    collection: "notice",
    field: "createdBy",
    exportable: false,
    guildScoped: true,
    note: "Admin-authored config object; records only who created it.",
    onDelete: "retain",
    subject: "mention",
    deleteNote:
      "Admin-authored config object belonging to the guild; it merely records who created it.",
  },
  {
    source: "src/models/poll-item.ts",
    collection: "poll-item",
    field: "createdBy",
    exportable: false,
    guildScoped: true,
    note: "Admin-authored poll-library entry; records only who imported it.",
    onDelete: "retain",
    subject: "mention",
    deleteNote:
      "Admin-authored poll-library entry belonging to the guild; it merely records who imported it.",
  },
  {
    source: "src/models/poll-schedule.ts",
    collection: "poll-schedule",
    field: "createdBy",
    exportable: false,
    guildScoped: true,
    note: "Admin-authored schedule; records only who created it.",
    onDelete: "retain",
    subject: "mention",
    deleteNote:
      "Admin-authored schedule belonging to the guild; erasing it would break a running configuration.",
  },
  {
    source: "src/models/scheduled-announcement.ts",
    collection: "scheduled-announcement",
    field: "createdBy",
    exportable: false,
    guildScoped: true,
    note: "Admin-authored announcement; records only who created it.",
    onDelete: "retain",
    subject: "mention",
    deleteNote:
      "Admin-authored announcement belonging to the guild; erasing it would break a running configuration.",
  },
  {
    source: "src/models/event.ts",
    collection: "event",
    field: "createdBy",
    exportable: false,
    guildScoped: true,
    note: "Admin-authored event object; records only who scheduled it. The member's RSVP on the same row IS exported (see `event-rsvp`).",
    onDelete: "retain",
    subject: "mention",
    deleteNote:
      "Admin-authored event belonging to the guild; the member's own RSVP on the same row IS purged (see `event-rsvp`).",
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

/** The policies that give a purge something to do. */
const ACTIONABLE_DELETE_POLICIES: readonly UserDataDeletePolicy[] = [
  "hard-delete",
  "pull-member",
  "anonymise",
];

/**
 * Whether a purge acts on this entry at all. `retain` and `expires` are the
 * two "nothing happens" policies, and a `mention` is never the requesting
 * member's to erase however its collection is otherwise classified.
 */
export function isDeletable(entry: UserDataField): boolean {
  return (
    entry.subject === "self" &&
    ACTIONABLE_DELETE_POLICIES.includes(entry.onDelete)
  );
}

/** Registry entries a purge acts on, in registry order. */
export const DELETABLE_USER_DATA: readonly UserDataField[] =
  USER_DATA_REGISTRY.filter(isDeletable);

/** Distinct collection labels a purge touches. */
export const DELETABLE_COLLECTIONS: readonly string[] = [
  ...new Set(DELETABLE_USER_DATA.map((entry) => entry.collection)),
];

/**
 * Entries a purge deliberately leaves alone, for the "what a reset does not
 * remove" copy on /me/privacy — the delete-side counterpart of
 * `EXCLUDED_USER_DATA`.
 */
export const RETAINED_USER_DATA: readonly UserDataField[] =
  USER_DATA_REGISTRY.filter((entry) => !isDeletable(entry));

/** Registry entries carrying one particular delete policy, in registry order. */
export function userDataForDeletePolicy(
  policy: UserDataDeletePolicy,
): readonly UserDataField[] {
  return USER_DATA_REGISTRY.filter(
    (entry) => entry.subject === "self" && entry.onDelete === policy,
  );
}

/**
 * Collapse the registry's per-field rows into one row per collection,
 * joining the notes so a collection classified through two fields keeps both
 * rationales — `moderation-log` is excluded for the record *and* for
 * exposing which moderator acted; a quote row matches as `authorId` or
 * `addedById`. Dropping the second note would state a different reason
 * depending on where a member read it.
 *
 * The `/me/privacy` tables and the export payload's `excluded` list both
 * render from this, so the page and the file can never disagree. Pass
 * `"deleteNote"` to summarise the delete rationales the same way.
 */
export function summariseByCollection(
  entries: readonly UserDataField[],
  noteKey: "note" | "deleteNote" = "note",
): Array<{ collection: string; note: string }> {
  const byCollection = new Map<string, string[]>();
  for (const entry of entries) {
    const notes = byCollection.get(entry.collection) ?? [];
    if (!notes.includes(entry[noteKey])) notes.push(entry[noteKey]);
    byCollection.set(entry.collection, notes);
  }
  return [...byCollection].map(([collection, notes]) => ({
    collection,
    note: notes.join(" "),
  }));
}

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
