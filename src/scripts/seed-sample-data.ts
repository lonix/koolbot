/**
 * Sample-data seeder (dev/test only).
 *
 * Populates a NON-PRODUCTION MongoDB with realistic, deterministic fake users
 * and a year's worth of activity so the data-heavy surfaces — Rewind /
 * year-in-review, leaderboards, weekly digests, achievements, `/stats` and the
 * WebUI stats pages — can be exercised locally without waiting for a real
 * Discord server to accumulate history. See issue #667.
 *
 * This is an operational script in the same family as `validate-config` /
 * `migrate-config`: it is NOT a Discord command or a config-gated runtime
 * service. Run it against compiled output (`npm run build` first):
 *
 *   npm run seed-sample-data -- --yes               # seed defaults (~10 users)
 *   npm run seed-sample-data -- --users 25 --yes    # more users
 *   npm run seed-sample-data -- --seed 42 --yes     # reproducible run
 *   npm run seed-sample-data -- --clean --yes       # remove ONLY seeded data
 *
 * Safety: every seeded document is namespaced behind a fixed fake-user-id
 * prefix (`seed-`), so `--clean` removes exactly the seeded rows and never
 * touches real records. The script refuses to write anything without the
 * explicit `--yes` opt-in, and loudly logs the target database before any
 * write.
 */
import { parseArgs } from "node:util";
import mongoose from "mongoose";
import { faker } from "@faker-js/faker";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import { MessageActivityTracking } from "../models/message-activity-tracking.js";
import { UserAchievements } from "../models/user-achievements.js";
import { ReactionActivityTracking } from "../models/reaction-activity-tracking.js";
import { PollParticipationTracking } from "../models/poll-participation-tracking.js";
import { UserNotificationPrefs } from "../models/user-notification-prefs.js";
import { UserVoicePreferences } from "../models/user-voice-preferences.js";
import { ACCOLADE_METADATA } from "../content/accolades.js";

// All seeded fake users share this id prefix. `--clean` matches on it, so it
// must be something a real Discord snowflake (a numeric string) can never be.
export const SEED_USER_PREFIX = "seed-";

const DEFAULT_USERS = 10;
const DEFAULT_SEED = 1337;

// Time-based achievement ids (the `AchievementType` union in
// `src/content/achievements.ts`). Only `type` is needed at the model level.
const ACHIEVEMENT_TYPES = [
  "weekly_champion",
  "weekly_night_owl",
  "weekly_marathon",
  "weekly_social_butterfly",
  "weekly_active",
  "weekly_consistent",
] as const;

// A small pool of IANA zones so timezone-aware bucketing (#524) has something
// to exercise. `undefined` means "use the server timezone".
const TIMEZONE_POOL = [
  undefined,
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
];

// Shared voice channels every fake user might pass through, in addition to
// their own personal room. Gives companions/overlap stats realistic clustering.
const SHARED_VOICE_CHANNELS = [
  "General",
  "Gaming",
  "Music",
  "AFK",
  "Late Night",
];

const TEXT_CHANNELS = [
  "general",
  "off-topic",
  "memes",
  "gaming",
  "music",
  "bot-spam",
];

export interface SeedOptions {
  users: number;
  guildId: string;
  seed: number;
  from: Date;
  to: Date;
}

export interface SeedIdentity {
  userId: string;
  username: string;
}

// Lean (plain-object) shapes of the documents we write. They intentionally
// omit Mongoose `Document` machinery so the generation helpers stay pure and
// trivially testable.
export interface SeededDataset {
  identities: SeedIdentity[];
  voiceTracking: SeededVoiceDoc[];
  messageActivity: SeededMessageDoc[];
  achievements: SeededAchievementsDoc[];
  reactions: SeededReactionDoc[];
  polls: SeededPollDoc[];
  notificationPrefs: SeededNotificationPrefsDoc[];
  voicePreferences: SeededVoicePrefsDoc[];
}

interface SeededSession {
  startTime: Date;
  endTime: Date;
  duration: number;
  channelId: string;
  channelName: string;
  otherUsers: string[];
  companions: Array<{ userId: string; seconds: number }>;
  wasFirst: boolean;
  joinedExisting: string[];
}

interface SeededPeriodTotals {
  totalTime: number;
  sessionCount: number;
  channels: string[];
  averageSessionLength: number;
}

export interface SeededVoiceDoc {
  userId: string;
  username: string;
  totalTime: number;
  lastSeen: Date;
  sessions: SeededSession[];
  excludedChannels: string[];
  monthlyTotals: Array<SeededPeriodTotals & { month: string }>;
  yearlyTotals: Array<SeededPeriodTotals & { year: string }>;
}

export interface SeededMessageDoc {
  userId: string;
  guildId: string;
  username: string;
  channels: Array<{ channelId: string; count: number }>;
  recentMessages: Array<{ sentAt: Date; channelId: string }>;
  totalCount: number;
  lastMessageAt: Date | null;
}

export interface SeededAchievementsDoc {
  userId: string;
  username: string;
  accolades: Array<{
    type: string;
    earnedAt: Date;
    metadata?: { value?: number; description?: string; unit?: string };
  }>;
  achievements: Array<{
    type: string;
    earnedAt: Date;
    period: string;
    rank?: number;
    metadata?: { value?: number; description?: string; unit?: string };
  }>;
  lastChecked: Date;
  statistics: { totalAccolades: number; totalAchievements: number };
}

export interface SeededReactionDoc {
  userId: string;
  guildId: string;
  username: string;
  totalGiven: number;
  totalReceived: number;
  yearlyGiven: Record<string, number>;
  yearlyReceived: Record<string, number>;
  lastReactionAt: Date | null;
}

export interface SeededPollDoc {
  userId: string;
  guildId: string;
  username: string;
  totalVotes: number;
  yearlyVotes: Record<string, number>;
  lastVoteAt: Date | null;
}

export interface SeededNotificationPrefsDoc {
  userId: string;
  guildId: string;
  achievements: boolean;
  digest: boolean;
  rewind: boolean;
  timezone?: string;
  updatedAt: Date;
}

export interface SeededVoicePrefsDoc {
  userId: string;
  namePattern: string;
  userLimit: number;
  bitrate: number;
  presets: Array<{
    name: string;
    channelName?: string;
    userLimit?: number;
    bitrate?: number;
    isDefault?: boolean;
  }>;
}

/** Redact any password embedded in a mongodb connection URI for safe logging. */
export function redactUri(uri: string): string {
  return uri.replace(/(\/\/[^:/?#]+:)([^@]+)(@)/, "$1***$3");
}

/** Deterministic fake user id for the Nth seeded user (1-based). */
export function seedUserId(index: number): string {
  return `${SEED_USER_PREFIX}${String(index).padStart(4, "0")}`;
}

function pickSome<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  return faker.helpers.arrayElements(items, Math.min(count, items.length));
}

/** Build the deterministic id/username pairs for `count` fake users. */
export function buildIdentities(count: number): SeedIdentity[] {
  const identities: SeedIdentity[] = [];
  for (let i = 1; i <= count; i++) {
    identities.push({
      userId: seedUserId(i),
      username: faker.internet.username().slice(0, 32),
    });
  }
  return identities;
}

function yearKey(date: Date): string {
  return String(date.getUTCFullYear());
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function aggregatePeriods<K extends string>(
  sessions: SeededSession[],
  keyOf: (d: Date) => string,
  field: K,
): Array<SeededPeriodTotals & Record<K, string>> {
  const buckets = new Map<string, SeededSession[]>();
  for (const s of sessions) {
    const k = keyOf(s.startTime);
    const list = buckets.get(k) ?? [];
    list.push(s);
    buckets.set(k, list);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const totalTime = group.reduce((sum, s) => sum + s.duration, 0);
      const channels = Array.from(new Set(group.map((s) => s.channelName)));
      return {
        [field]: key,
        totalTime,
        sessionCount: group.length,
        channels,
        averageSessionLength: Math.round(totalTime / group.length),
      } as SeededPeriodTotals & Record<K, string>;
    });
}

/** Generate one user's voice-tracking document with spread-out sessions. */
export function generateVoiceTracking(
  identity: SeedIdentity,
  otherUserIds: string[],
  opts: SeedOptions,
): SeededVoiceDoc {
  const personalRoom = `${identity.username}'s Room`;
  const channelPool = [personalRoom, ...SHARED_VOICE_CHANNELS];
  const sessionCount = faker.number.int({ min: 20, max: 120 });

  const sessions: SeededSession[] = [];
  for (let i = 0; i < sessionCount; i++) {
    const startTime = faker.date.between({ from: opts.from, to: opts.to });
    // Weighted toward shorter sessions, with the occasional marathon.
    const duration = faker.number.int({ min: 5 * 60, max: 5 * 60 * 60 });
    const endTime = new Date(startTime.getTime() + duration * 1000);
    const channelName = faker.helpers.arrayElement(channelPool);
    const channelId = `seed-vc-${SHARED_VOICE_CHANNELS.indexOf(channelName) + 1}-${identity.userId}`;
    const others = pickSome(otherUserIds, faker.number.int({ min: 0, max: 4 }));
    const companions = others.map((userId) => ({
      userId,
      seconds: faker.number.int({ min: 60, max: duration }),
    }));

    sessions.push({
      startTime,
      endTime,
      duration,
      channelId,
      channelName,
      otherUsers: others,
      companions,
      wasFirst: faker.datatype.boolean(),
      joinedExisting: pickSome(others, faker.number.int({ min: 0, max: 2 })),
    });
  }

  sessions.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const totalTime = sessions.reduce((sum, s) => sum + s.duration, 0);
  const lastSeen = sessions.length
    ? sessions[sessions.length - 1].endTime
    : opts.to;

  return {
    userId: identity.userId,
    username: identity.username,
    totalTime,
    lastSeen,
    sessions,
    excludedChannels: [],
    monthlyTotals: aggregatePeriods(sessions, monthKey, "month"),
    yearlyTotals: aggregatePeriods(sessions, yearKey, "year"),
  };
}

/** Generate one user's text-message activity document. */
export function generateMessageActivity(
  identity: SeedIdentity,
  opts: SeedOptions,
): SeededMessageDoc {
  const messageCount = faker.number.int({ min: 50, max: 400 });
  const recentMessages: Array<{ sentAt: Date; channelId: string }> = [];
  const counts = new Map<string, number>();

  for (let i = 0; i < messageCount; i++) {
    const channelName = faker.helpers.arrayElement(TEXT_CHANNELS);
    const channelId = `seed-tc-${TEXT_CHANNELS.indexOf(channelName) + 1}`;
    recentMessages.push({
      sentAt: faker.date.between({ from: opts.from, to: opts.to }),
      channelId,
    });
    counts.set(channelId, (counts.get(channelId) ?? 0) + 1);
  }

  recentMessages.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

  return {
    userId: identity.userId,
    guildId: opts.guildId,
    username: identity.username,
    channels: Array.from(counts.entries()).map(([channelId, count]) => ({
      channelId,
      count,
    })),
    recentMessages,
    totalCount: messageCount,
    lastMessageAt: recentMessages.length
      ? recentMessages[recentMessages.length - 1].sentAt
      : null,
  };
}

function isoWeek(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Generate one user's achievements/accolades document. */
export function generateUserAchievements(
  identity: SeedIdentity,
  opts: SeedOptions,
): SeededAchievementsDoc {
  const accoladeKeys = Object.keys(ACCOLADE_METADATA);
  const chosenAccolades = pickSome(
    accoladeKeys,
    faker.number.int({ min: 2, max: 6 }),
  );
  const accolades = chosenAccolades.map((type) => {
    const earnedAt = faker.date.between({ from: opts.from, to: opts.to });
    return {
      type,
      earnedAt,
      metadata: {
        value: faker.number.int({ min: 1, max: 1000 }),
        unit: "hrs",
      },
    };
  });

  const chosenAchievements = pickSome(
    [...ACHIEVEMENT_TYPES],
    faker.number.int({ min: 1, max: 5 }),
  );
  const achievements = chosenAchievements.map((type) => {
    const earnedAt = faker.date.between({ from: opts.from, to: opts.to });
    return {
      type,
      earnedAt,
      period: isoWeek(earnedAt),
      rank: faker.number.int({ min: 1, max: 10 }),
      metadata: { value: faker.number.int({ min: 1, max: 50 }), unit: "hrs" },
    };
  });

  return {
    userId: identity.userId,
    username: identity.username,
    accolades,
    achievements,
    lastChecked: opts.to,
    statistics: {
      totalAccolades: accolades.length,
      totalAchievements: achievements.length,
    },
  };
}

function yearlyBuckets(
  opts: SeedOptions,
  min: number,
  max: number,
): Record<string, number> {
  const buckets: Record<string, number> = {};
  for (
    let year = opts.from.getUTCFullYear();
    year <= opts.to.getUTCFullYear();
    year++
  ) {
    buckets[String(year)] = faker.number.int({ min, max });
  }
  return buckets;
}

/** Generate one user's reaction-activity document (#653 capture). */
export function generateReactionActivity(
  identity: SeedIdentity,
  opts: SeedOptions,
): SeededReactionDoc {
  const yearlyGiven = yearlyBuckets(opts, 5, 800);
  const yearlyReceived = yearlyBuckets(opts, 5, 800);
  const sum = (b: Record<string, number>): number =>
    Object.values(b).reduce((a, c) => a + c, 0);
  return {
    userId: identity.userId,
    guildId: opts.guildId,
    username: identity.username,
    totalGiven: sum(yearlyGiven),
    totalReceived: sum(yearlyReceived),
    yearlyGiven,
    yearlyReceived,
    lastReactionAt: faker.date.between({ from: opts.from, to: opts.to }),
  };
}

/** Generate one user's poll-participation document (#655 capture). */
export function generatePollParticipation(
  identity: SeedIdentity,
  opts: SeedOptions,
): SeededPollDoc {
  const yearlyVotes = yearlyBuckets(opts, 0, 150);
  const total = Object.values(yearlyVotes).reduce((a, c) => a + c, 0);
  return {
    userId: identity.userId,
    guildId: opts.guildId,
    username: identity.username,
    totalVotes: total,
    yearlyVotes,
    lastVoteAt:
      total > 0 ? faker.date.between({ from: opts.from, to: opts.to }) : null,
  };
}

/** Generate one user's notification prefs (carries timezone for #524). */
export function generateNotificationPrefs(
  identity: SeedIdentity,
  opts: SeedOptions,
): SeededNotificationPrefsDoc {
  return {
    userId: identity.userId,
    guildId: opts.guildId,
    achievements: faker.datatype.boolean(),
    digest: faker.datatype.boolean(),
    rewind: faker.datatype.boolean(),
    timezone: faker.helpers.arrayElement(TIMEZONE_POOL),
    updatedAt: opts.to,
  };
}

/** Generate one user's voice preferences. */
export function generateVoicePreferences(
  identity: SeedIdentity,
): SeededVoicePrefsDoc {
  return {
    userId: identity.userId,
    namePattern: faker.helpers.arrayElement([
      "{username}'s Room",
      "🎮 {username}",
      "{username} HQ",
    ]),
    userLimit: faker.helpers.arrayElement([0, 2, 4, 6, 10]),
    bitrate: faker.helpers.arrayElement([64, 96, 128]),
    presets: [
      {
        name: "Squad night",
        channelName: `${identity.username}'s Squad`,
        userLimit: 6,
        bitrate: 96,
        isDefault: true,
      },
    ],
  };
}

/**
 * Build the full deterministic dataset for `opts`. Pure: no DB access. Calling
 * it twice with the same `seed`, `users` and date span yields identical output.
 */
export function generateSampleDataset(opts: SeedOptions): SeededDataset {
  faker.seed(opts.seed);

  const identities = buildIdentities(opts.users);
  const allIds = identities.map((i) => i.userId);

  const dataset: SeededDataset = {
    identities,
    voiceTracking: [],
    messageActivity: [],
    achievements: [],
    reactions: [],
    polls: [],
    notificationPrefs: [],
    voicePreferences: [],
  };

  for (const identity of identities) {
    const others = allIds.filter((id) => id !== identity.userId);
    dataset.voiceTracking.push(generateVoiceTracking(identity, others, opts));
    dataset.messageActivity.push(generateMessageActivity(identity, opts));
    dataset.achievements.push(generateUserAchievements(identity, opts));
    dataset.reactions.push(generateReactionActivity(identity, opts));
    dataset.polls.push(generatePollParticipation(identity, opts));
    dataset.notificationPrefs.push(generateNotificationPrefs(identity, opts));
    dataset.voicePreferences.push(generateVoicePreferences(identity));
  }

  return dataset;
}

/**
 * Write a dataset to MongoDB, upserting by the deterministic fake ids so
 * re-runs are idempotent (no duplicates). Assumes an open connection.
 */
export async function writeDataset(dataset: SeededDataset): Promise<void> {
  for (const doc of dataset.voiceTracking) {
    await VoiceChannelTracking.updateOne(
      { userId: doc.userId },
      { $set: doc },
      { upsert: true },
    );
  }
  for (const doc of dataset.messageActivity) {
    await MessageActivityTracking.updateOne(
      { userId: doc.userId, guildId: doc.guildId },
      { $set: doc },
      { upsert: true },
    );
  }
  for (const doc of dataset.achievements) {
    await UserAchievements.updateOne(
      { userId: doc.userId },
      { $set: doc },
      { upsert: true },
    );
  }
  for (const doc of dataset.reactions) {
    await ReactionActivityTracking.updateOne(
      { userId: doc.userId, guildId: doc.guildId },
      { $set: doc },
      { upsert: true },
    );
  }
  for (const doc of dataset.polls) {
    await PollParticipationTracking.updateOne(
      { userId: doc.userId, guildId: doc.guildId },
      { $set: doc },
      { upsert: true },
    );
  }
  for (const doc of dataset.notificationPrefs) {
    await UserNotificationPrefs.updateOne(
      { userId: doc.userId, guildId: doc.guildId },
      { $set: doc },
      { upsert: true },
    );
  }
  for (const doc of dataset.voicePreferences) {
    await UserVoicePreferences.updateOne(
      { userId: doc.userId },
      { $set: doc },
      { upsert: true },
    );
  }
}

/** Delete every seeded document (matched by the fake id prefix) and report counts. */
export async function cleanSampleData(): Promise<number> {
  const idFilter = { userId: { $regex: `^${SEED_USER_PREFIX}` } };
  const models: Array<
    [string, { deleteMany: (f: object) => Promise<{ deletedCount?: number }> }]
  > = [
    ["VoiceChannelTracking", VoiceChannelTracking],
    ["MessageActivityTracking", MessageActivityTracking],
    ["UserAchievements", UserAchievements],
    ["ReactionActivityTracking", ReactionActivityTracking],
    ["PollParticipationTracking", PollParticipationTracking],
    ["UserNotificationPrefs", UserNotificationPrefs],
    ["UserVoicePreferences", UserVoicePreferences],
  ];

  let total = 0;
  for (const [name, model] of models) {
    const res = await model.deleteMany(idFilter);
    const count = res.deletedCount ?? 0;
    total += count;
    logger.info(`  • ${name}: removed ${count} seeded document(s)`);
  }
  return total;
}

interface ParsedOptions extends SeedOptions {
  clean: boolean;
  yes: boolean;
}

/** Parse CLI flags / env vars into resolved options. Pure (no DB / no exit). */
export function parseOptions(argv: string[]): ParsedOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      users: { type: "string" },
      years: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      seed: { type: "string" },
      guild: { type: "string" },
      clean: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const now = new Date();
  let from: Date;
  let to: Date = now;

  if (values.from || values.to) {
    from = values.from
      ? new Date(values.from)
      : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    to = values.to ? new Date(values.to) : now;
  } else if (values.years) {
    const years = Number(values.years);
    from = new Date(now);
    from.setUTCFullYear(from.getUTCFullYear() - years);
  } else {
    // Default span: the current calendar year so far.
    from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  }

  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new Error("Invalid --from/--to date");
  }
  if (from >= to) {
    throw new Error("--from must be before --to");
  }

  const guildId = values.guild ?? env.guildId ?? "";

  return {
    users: values.users ? Math.max(1, Number(values.users)) : DEFAULT_USERS,
    guildId,
    seed: values.seed ? Number(values.seed) : DEFAULT_SEED,
    from,
    to,
    clean: values.clean,
    yes: values.yes,
  };
}

async function main(): Promise<void> {
  let opts: ParsedOptions;
  try {
    opts = parseOptions(process.argv.slice(2));
  } catch (error) {
    logger.error(
      `Invalid arguments: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  if (!opts.yes) {
    logger.error(
      "Refusing to run without explicit opt-in. Re-run with --yes once you have " +
        "confirmed MONGODB_URI points at a dev/test database.",
    );
    process.exitCode = 1;
    return;
  }

  if (!opts.clean && !opts.guildId) {
    logger.error(
      "No guild id available. Set GUILD_ID or pass --guild <id> so seeded " +
        "per-guild documents are written under the right server.",
    );
    process.exitCode = 1;
    return;
  }

  try {
    // Loudly log the target before touching anything (acceptance criterion).
    logger.warn("⚠️  Sample-data seeder — writing to a REAL database:");
    logger.warn(`    URI: ${redactUri(env.mongoUri)}`);

    await mongoose.connect(env.mongoUri);
    logger.warn(`    DB:  ${mongoose.connection.name}`);

    if (opts.clean) {
      logger.info(
        `Cleaning seeded data (ids matching "${SEED_USER_PREFIX}*")...`,
      );
      const removed = await cleanSampleData();
      logger.info(`✅ Removed ${removed} seeded document(s).`);
      return;
    }

    logger.info(
      `Seeding ${opts.users} fake user(s) for guild ${opts.guildId} ` +
        `(seed=${opts.seed}, ${opts.from.toISOString().slice(0, 10)} → ` +
        `${opts.to.toISOString().slice(0, 10)})...`,
    );

    const dataset = generateSampleDataset(opts);
    await writeDataset(dataset);

    logger.info(
      `✅ Seeded ${dataset.identities.length} users across voice, messages, ` +
        "achievements, reactions, polls, prefs.",
    );
    logger.info(
      `   Example seeded user: ${dataset.identities[0]?.userId} ` +
        `(${dataset.identities[0]?.username}).`,
    );
    logger.info(
      `   Remove later with: npm run seed-sample-data -- --clean --yes`,
    );
  } catch (error) {
    logger.error("Fatal error during sample-data seeding:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

// Run if invoked directly (mirrors the other operational scripts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main as seedSampleData };
