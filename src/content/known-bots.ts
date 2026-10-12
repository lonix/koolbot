/**
 * Static catalogue of well-known Discord bots and what KoolBot can replace
 * (#1026, part of the server adoption epic #1017).
 *
 * Shipped in the repo on purpose: KoolBot is self-hosted and never calls a
 * central service to look bots up. The adoption scan matches the bots found
 * in a guild against `ids`; anything that is not listed here is reported as
 * "custom" or "unknown" with no claims made.
 *
 * Rules for entries (see `CONTRIBUTING.md`, "Adding a known-bot entry"):
 *
 * - `ids` are Discord **user ids of the bot**. For almost every bot that
 *   equals its application id. Detection never uses the name, which a
 *   server can change. A bot may list several ids (e.g. a premium build).
 * - Every capability states what KoolBot offers. `partial` must say what is
 *   missing, `planned` must link the KoolBot issue, `keep` must say why
 *   KoolBot will not replace it. Never claim coverage KoolBot does not have.
 * - Capabilities that KoolBot covers point at a feature in
 *   `KOOLBOT_FEATURES`, which owns the enabling config key, the Web UI page
 *   and the switch-over steps, so they are written once.
 */

/** A KoolBot feature a bot capability can map to. */
export interface KoolBotFeature {
  label: string;
  /** Config key that switches the feature on. Must exist in `defaultConfig`. */
  enabledKey: string;
  /** Admin Web UI page for the feature. */
  webPath: string;
  /** Switch-over steps, in order. */
  steps: readonly string[];
}

export const KOOLBOT_FEATURES = {
  voicechannels: {
    label: "Temporary voice channels",
    enabledKey: "voicechannels.enabled",
    webPath: "/admin/voice-channels",
    steps: [
      "Turn on voicechannels.enabled.",
      "Set the lobby channel and category, or claim the existing category on the adoption page.",
      "Join the lobby once to check that a room is created and cleaned up.",
    ],
  },
  voicestats: {
    label: "Voice activity stats and leaderboards",
    enabledKey: "voicetracking.enabled",
    webPath: "/admin/analytics",
    steps: [
      "Turn on voicetracking.enabled. History starts from that moment; the old bot's data is not imported.",
      "Optionally enable leaderboard roles for top members.",
    ],
  },
  reactionroles: {
    label: "Reaction and button roles",
    enabledKey: "reactionroles.enabled",
    webPath: "/admin/reaction-roles",
    steps: [
      "Turn on reactionroles.enabled.",
      "Recreate each role message on the Reaction Roles page; messages from the old bot cannot be imported.",
      "Remove the old bot's role messages once the new ones work.",
    ],
  },
  polls: {
    label: "Polls",
    enabledKey: "polls.enabled",
    webPath: "/admin/polls",
    steps: [
      "Turn on polls.enabled.",
      "Set the polls channel on the Polls page.",
    ],
  },
  birthdays: {
    label: "Birthdays",
    enabledKey: "birthdays.enabled",
    webPath: "/admin/birthdays",
    steps: [
      "Turn on birthdays.enabled and set the announcement channel.",
      "Members re-enter their birthday themselves; dates are not imported.",
    ],
  },
  events: {
    label: "Events and RSVP",
    enabledKey: "events.enabled",
    webPath: "/admin/events",
    steps: [
      "Turn on events.enabled.",
      "Recreate recurring events on the Events page.",
    ],
  },
  reminders: {
    label: "Reminders",
    enabledKey: "reminders.enabled",
    webPath: "/admin/settings#section-reminders",
    steps: ["Turn on reminders.enabled. Members then use /remind."],
  },
  moderation: {
    label: "Moderation (warn, timeout, ban, modlog)",
    enabledKey: "moderation.enabled",
    webPath: "/admin/moderation",
    steps: [
      "Turn on moderation.enabled and choose how long to keep the log (moderation.retention_days).",
      "Give your moderators the right role; they then use /warn, /timeout, /ban and /modlog.",
      "Old warn history is not imported.",
    ],
  },
  announcements: {
    label: "Scheduled announcements and notices",
    enabledKey: "announcements.enabled",
    webPath: "/admin/announcements",
    steps: [
      "Turn on announcements.enabled.",
      "Recreate each scheduled message on the Announcements page.",
    ],
  },
  welcome: {
    label: "Welcome messages",
    enabledKey: "welcome.enabled",
    webPath: "/admin/settings#section-welcome",
    steps: [
      "Turn on welcome.enabled and set welcome.channel_id and the message.",
      "Needs the Server Members intent. Switch it on in the Discord developer portal first.",
    ],
  },
  tickets: {
    label: "Support tickets",
    enabledKey: "tickets.enabled",
    webPath: "/admin/tickets",
    steps: [
      "Turn on tickets.enabled.",
      "Set the ticket category and the staff role.",
      "Open tickets in the old bot stay there; finish them before removing it.",
    ],
  },
} as const satisfies Record<string, KoolBotFeature>;

export type KoolBotFeatureId = keyof typeof KOOLBOT_FEATURES;

/** How well KoolBot covers one capability of a bot. */
export type CapabilityCoverage =
  | { level: "full"; note?: string }
  /** `missing` says what KoolBot does not do. */
  | { level: "partial"; missing: string }
  /** `issue` is the KoolBot issue that tracks it. */
  | { level: "planned"; issue: number }
  /** Nothing in KoolBot and none planned. Never claim these. */
  | { level: "none" }
  /** KoolBot will not replace it, for the stated `reason`. */
  | { level: "keep"; reason: string };

export type CoverageLevel = CapabilityCoverage["level"];

export interface KnownBotCapability {
  /** Stable id shared across bots, so the combined view can group them. */
  id: string;
  label: string;
  /** The KoolBot feature that covers it. Required for `full` and `partial`. */
  feature?: KoolBotFeatureId;
  coverage: CapabilityCoverage;
}

export interface KnownBot {
  /** Stable catalogue key. */
  key: string;
  name: string;
  description: string;
  /** Bot user ids (usually the application ids). May be empty until confirmed. */
  ids: readonly string[];
  /**
   * Where the **ids** were checked, and when: a source URL (the bot's own
   * invite link or docs, Discord's app directory, or a directory listing
   * keyed by the id) plus the date. It covers ids only, never the capability
   * list. Absent while the ids are unconfirmed; the report then shows an
   * "unverified entry" note on the card.
   */
  verifiedAgainst?: string;
  capabilities: readonly KnownBotCapability[];
}

const MUSIC_REASON =
  "Music and video playback is out of scope by policy: KoolBot does not ship features that stream copyrighted media.";

const AUTOMOD: KnownBotCapability = {
  id: "auto-mod",
  label: "Auto-moderation filters",
  coverage: { level: "none" },
};

const EVENT_LOG: KnownBotCapability = {
  id: "event-log",
  label: "Server event log (edits, deletes, joins, role changes)",
  coverage: { level: "planned", issue: 1027 },
};

const MODERATION_PARTIAL: KnownBotCapability = {
  id: "moderation",
  label: "Moderation commands and modlog",
  feature: "moderation",
  coverage: {
    level: "partial",
    missing:
      "No auto-moderation filters and no server event log yet. Warn, timeout, ban and the case history are covered.",
  },
};

const REACTION_ROLES: KnownBotCapability = {
  id: "reaction-roles",
  label: "Reaction and button roles",
  feature: "reactionroles",
  coverage: { level: "full" },
};

const WELCOME: KnownBotCapability = {
  id: "welcome",
  label: "Welcome messages",
  feature: "welcome",
  coverage: { level: "full" },
};

const SCHEDULED: KnownBotCapability = {
  id: "scheduled-announcements",
  label: "Scheduled announcements",
  feature: "announcements",
  coverage: { level: "full" },
};

/*
 * Ids: an entry with `verifiedAgainst` had its id confirmed on 2026-10-12
 * against a third-party directory listing keyed by that id (top.gg or
 * discordbotlist.com). That is good evidence but not primary-source proof: a
 * listing can in principle be wrong or point at a renamed bot. An id with an
 * `// UNVERIFIED` comment has no confirmation at all. Entries with an empty
 * `ids` list are never detected until an id is confirmed.
 *
 * Capability lists: UNVERIFIED for every entry. They were written without
 * checking each bot's current features, and `verifiedAgainst` does not cover
 * them. A maintainer must confirm them; see `CONTRIBUTING.md`.
 */
export const KNOWN_BOTS: readonly KnownBot[] = [
  {
    key: "dyno",
    name: "Dyno",
    description: "Moderation, logging, announcements and welcome messages.",
    ids: ["155149108183695360"],
    verifiedAgainst:
      "id only: https://top.gg/bot/155149108183695360 (third-party directory listing), 2026-10-12",
    capabilities: [MODERATION_PARTIAL, EVENT_LOG, AUTOMOD, WELCOME, SCHEDULED],
  },
  {
    key: "carlbot",
    name: "Carl-bot",
    description: "Reaction roles, moderation, logging and custom tags.",
    ids: ["235148962103951360"],
    verifiedAgainst:
      "id only: https://discordbotlist.com/bots/235148962103951360 (third-party directory listing), 2026-10-12",
    capabilities: [
      REACTION_ROLES,
      MODERATION_PARTIAL,
      EVENT_LOG,
      AUTOMOD,
      WELCOME,
      {
        id: "custom-commands",
        label: "Custom commands and tags",
        coverage: { level: "none" },
      },
    ],
  },
  {
    key: "mee6",
    name: "MEE6",
    description:
      "Moderation, welcome messages, announcements and message XP levelling.",
    ids: ["159985870458322944"],
    verifiedAgainst:
      "id only: https://discordbotlist.com/bots/159985870458322944 (third-party directory listing), 2026-10-12",
    capabilities: [
      MODERATION_PARTIAL,
      WELCOME,
      SCHEDULED,
      REACTION_ROLES,
      {
        id: "message-xp",
        label: "Message XP levelling and rank cards",
        coverage: { level: "none" },
      },
    ],
  },
  {
    key: "yagpdb",
    name: "YAGPDB",
    description:
      "Moderation, logging, reaction roles, custom commands, feeds and auto-moderation.",
    ids: ["204255221017214977"], // UNVERIFIED
    capabilities: [
      MODERATION_PARTIAL,
      EVENT_LOG,
      REACTION_ROLES,
      AUTOMOD,
      {
        id: "custom-commands",
        label: "Custom commands",
        coverage: { level: "none" },
      },
      {
        id: "feeds",
        label: "RSS, YouTube and Twitch feeds",
        coverage: { level: "none" },
      },
    ],
  },
  {
    key: "zira",
    name: "Zira",
    description: "Reaction roles.",
    ids: ["275813801792634880"],
    verifiedAgainst:
      "id only: https://discordbotlist.com/bots/275813801792634880 (third-party directory listing), 2026-10-12",
    capabilities: [REACTION_ROLES],
  },
  {
    key: "color-chan",
    name: "Color-Chan",
    description: "Colour roles members pick for themselves.",
    ids: [],
    capabilities: [
      {
        id: "colour-roles",
        label: "Colour roles",
        feature: "reactionroles",
        coverage: {
          level: "partial",
          missing:
            "A Reaction Roles select menu covers a fixed palette. Free-form per-member hex colours are not supported.",
        },
      },
    ],
  },
  {
    key: "tempvoice",
    name: "TempVoice",
    description:
      "Join-to-create temporary voice channels with a control panel.",
    ids: [],
    capabilities: [
      {
        id: "temp-voice",
        label: "Temporary voice channels",
        feature: "voicechannels",
        coverage: {
          level: "full",
          note: "Hand over the existing category through the adoption claims page (#1022), and see #1032 for voice cleanup.",
        },
      },
    ],
  },
  {
    key: "jockie-music",
    name: "Jockie Music",
    description: "Music playback.",
    ids: ["411916947773587456"],
    verifiedAgainst:
      "id only: https://top.gg/bot/411916947773587456 (third-party directory listing), 2026-10-12",
    capabilities: [
      {
        id: "music",
        label: "Music playback",
        coverage: { level: "keep", reason: MUSIC_REASON },
      },
    ],
  },
  {
    key: "lara",
    name: "Lara",
    description: "Music playback.",
    ids: [],
    capabilities: [
      {
        id: "music",
        label: "Music playback",
        coverage: { level: "keep", reason: MUSIC_REASON },
      },
    ],
  },
  {
    key: "emoji-gg",
    name: "Emoji.gg",
    description: "Emoji library browsing and adding.",
    ids: [],
    capabilities: [
      {
        id: "emoji-library",
        label: "Hosted emoji library",
        coverage: {
          level: "keep",
          reason:
            "It relies on its own hosted emoji library. Replicating it would mean depending on a third-party service.",
        },
      },
    ],
  },
  {
    key: "notifiarr",
    name: "Notifiarr",
    description: "Bridges an external self-hosted media service to Discord.",
    ids: [],
    capabilities: [
      {
        id: "external-bridge",
        label: "Notifications from an external service",
        coverage: {
          level: "keep",
          reason:
            "It bridges an external service that KoolBot does not run. There is nothing to replace.",
        },
      },
    ],
  },
];

/** Find the catalogue entry that lists a bot id, or null. */
export function findKnownBot(
  userId: string,
  catalog: readonly KnownBot[] = KNOWN_BOTS,
): KnownBot | null {
  return catalog.find((b) => b.ids.includes(userId)) ?? null;
}
