import { describe, it, expect, beforeEach, jest } from "@jest/globals";

/**
 * Unit tests for the self-service data export (#719).
 *
 * The registry drift test guards *what* is classified; this suite guards the
 * three properties the readers themselves have to hold to:
 *
 *  - self-scope — guild-scoped collections are queried with the session's
 *    guild, the three keyed on `userId` alone are not (and the payload is
 *    still only the member's own rows);
 *  - no third-party leakage — the shared aggregates (poll turnout, event
 *    RSVPs, leaderboard rosters) are projected down to the member's slice;
 *  - bounded output — append-only histories are capped and the payload says
 *    what it clipped.
 *
 * Every model is mocked, so nothing here needs Mongo.
 */

/** Per-collection fixtures, reset in `beforeEach` and set per test. */
const DATA: Record<string, unknown> = {};
/** The filter each model was queried with, for the self-scope assertions. */
const FILTERS: Record<string, unknown> = {};
/** The `limit()` each list read asked for, for the ceiling assertions. */
const LIMITS: Record<string, number> = {};

function docModel(name: string): Record<string, unknown> {
  return {
    findOne: (filter: unknown) => {
      FILTERS[name] = filter;
      return { lean: async () => DATA[name] ?? null };
    },
  };
}

function listModel(name: string): Record<string, unknown> {
  return {
    find: (filter: unknown) => {
      FILTERS[name] = filter;
      const query = {
        sort: () => query,
        limit: (n: number) => {
          LIMITS[name] = n;
          return query;
        },
        lean: async () => (DATA[name] as unknown[]) ?? [],
      };
      return query;
    },
  };
}

const mockGetNumber = jest.fn<(key: string, fallback: number) => Promise<number>>();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: jest.fn(() => ({ getNumber: mockGetNumber })) },
}));

// `mongoose` is only reached for the quote model, which `QuoteService`
// registers at import time in production. Stub the registry so the export
// service finds a compiled model without touching a real connection.
jest.unstable_mockModule("mongoose", () => ({
  default: {
    models: { Quote: listModel("quote") },
    model: jest.fn(() => listModel("quote")),
  },
  Schema: class {},
}));

jest.unstable_mockModule("../../src/models/voice-channel-tracking.js", () => ({
  VoiceChannelTracking: docModel("voice-channel-tracking"),
}));
jest.unstable_mockModule(
  "../../src/models/message-activity-tracking.js",
  () => ({
    MessageActivityTracking: docModel("message-activity-tracking"),
  }),
);
jest.unstable_mockModule(
  "../../src/models/reaction-activity-tracking.js",
  () => ({
    ReactionActivityTracking: docModel("reaction-activity-tracking"),
  }),
);
jest.unstable_mockModule(
  "../../src/models/poll-participation-tracking.js",
  () => ({
    PollParticipationTracking: docModel("poll-participation-tracking"),
  }),
);
jest.unstable_mockModule("../../src/models/poll-turnout.js", () => ({
  PollTurnout: listModel("poll-turnout"),
}));
jest.unstable_mockModule("../../src/models/user-achievements.js", () => ({
  UserAchievements: docModel("user-achievements"),
}));
jest.unstable_mockModule("../../src/models/user-birthday.js", () => ({
  UserBirthday: docModel("user-birthday"),
}));
jest.unstable_mockModule("../../src/models/user-notification-prefs.js", () => ({
  UserNotificationPrefs: docModel("user-notification-prefs"),
}));
jest.unstable_mockModule("../../src/models/user-voice-preferences.js", () => ({
  UserVoicePreferences: docModel("user-voice-preferences"),
}));
jest.unstable_mockModule("../../src/models/rewind-snapshot.js", () => ({
  RewindSnapshot: listModel("rewind-snapshot"),
}));
jest.unstable_mockModule("../../src/models/rewind-nudge-state.js", () => ({
  RewindNudgeState: listModel("rewind-nudge-state"),
}));
jest.unstable_mockModule("../../src/models/digest-state.js", () => ({
  DigestState: docModel("digest-state"),
}));
jest.unstable_mockModule("../../src/models/reminder.js", () => ({
  Reminder: listModel("reminder"),
}));
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: listModel("event"),
}));
jest.unstable_mockModule(
  "../../src/models/leaderboard-role-assignment.js",
  () => ({
    LeaderboardRoleAssignment: listModel("leaderboard-role-assignment"),
  }),
);
jest.unstable_mockModule("../../src/models/channel-invite.js", () => ({
  ChannelInvite: listModel("channel-invite"),
}));

const { UserDataExportService, createExportProgress, DEFAULT_MAX_ITEMS } =
  await import("../../src/services/user-data-export-service.js");
const { EXPORTABLE_COLLECTIONS, EXCLUDED_USER_DATA } = await import(
  "../../src/services/user-data-registry.js"
);

const USER = "member-1";
const GUILD = "guild-1";

interface ExportPayload {
  schemaVersion: number;
  generatedAt: string;
  userId: string;
  guildId: string;
  maxItemsPerCollection: number;
  about: string;
  excluded: Array<{ collection: string; reason: string }>;
  data: Record<string, unknown>;
  truncated: string[];
}

async function runExport(): Promise<{
  payload: ExportPayload;
  progress: { collections: string[]; truncated: string[] };
  raw: string;
  chunkCount: number;
}> {
  const progress = createExportProgress();
  const chunks: string[] = [];
  for await (const chunk of UserDataExportService.getInstance().streamJson(
    USER,
    GUILD,
    progress,
  )) {
    chunks.push(chunk);
  }
  const raw = chunks.join("");
  return {
    payload: JSON.parse(raw) as ExportPayload,
    progress,
    raw,
    chunkCount: chunks.length,
  };
}

describe("UserDataExportService", () => {
  beforeEach(() => {
    for (const key of Object.keys(DATA)) delete DATA[key];
    for (const key of Object.keys(FILTERS)) delete FILTERS[key];
    for (const key of Object.keys(LIMITS)) delete LIMITS[key];
    mockGetNumber.mockReset();
    mockGetNumber.mockResolvedValue(100);
    (
      UserDataExportService as unknown as { instance: unknown }
    ).instance = null;
  });

  it("emits a parseable envelope with one key per exportable collection", async () => {
    const { payload, chunkCount } = await runExport();

    expect(payload.schemaVersion).toBe(1);
    expect(payload.userId).toBe(USER);
    expect(payload.guildId).toBe(GUILD);
    expect(payload.maxItemsPerCollection).toBe(100);
    expect(Date.parse(payload.generatedAt)).not.toBeNaN();
    expect(Object.keys(payload.data).sort()).toEqual(
      [...EXPORTABLE_COLLECTIONS].sort(),
    );
    // Header, one chunk per collection, trailer — the payload is never
    // assembled as a single buffered string (#719).
    expect(chunkCount).toBe(EXPORTABLE_COLLECTIONS.length + 2);
  });

  it("lists the deliberate exclusions and never their rows", async () => {
    const { payload } = await runExport();

    const excluded = payload.excluded.map((row) => row.collection);
    expect(excluded).toContain("moderation-log");
    expect(excluded).toContain("web-audit-log");
    expect(excluded).toContain("discord-command-audit-log");
    for (const entry of EXCLUDED_USER_DATA) {
      expect(payload.data).not.toHaveProperty(entry.collection);
    }
    // Every exclusion carries the reason a member is shown on /me/privacy.
    for (const row of payload.excluded) {
      expect(row.reason.length).toBeGreaterThan(0);
    }
  });

  it("states every ground for excluding a collection, not just the first", async () => {
    // `moderation-log` is excluded twice over — for the record itself
    // (`userId`) and for exposing which moderator acted (`moderatorId`).
    // The file and the /me/privacy table render from the same collapse, so
    // keeping only the first note would have the two state different
    // reasons depending on where a member read them.
    const { payload } = await runExport();
    const notes = EXCLUDED_USER_DATA.filter(
      (entry) => entry.collection === "moderation-log",
    ).map((entry) => entry.note);
    expect(notes.length).toBeGreaterThan(1);

    const reason = payload.excluded.find(
      (row) => row.collection === "moderation-log",
    )?.reason;
    for (const note of notes) {
      expect(reason).toContain(note);
    }
  });

  it("lists each excluded collection once", async () => {
    const { payload } = await runExport();
    const collections = payload.excluded.map((row) => row.collection);
    expect(collections).toEqual([...new Set(collections)]);
  });

  it("scopes guild-scoped reads to the session's guild", async () => {
    await runExport();

    expect(FILTERS["message-activity-tracking"]).toEqual({
      userId: USER,
      guildId: GUILD,
    });
    expect(FILTERS["user-birthday"]).toEqual({ userId: USER, guildId: GUILD });
    expect(FILTERS["digest-state"]).toEqual({ userId: USER, guildId: GUILD });
    expect(FILTERS.reminder).toEqual({ userId: USER, guildId: GUILD });
    expect(FILTERS.event).toEqual({
      guildId: GUILD,
      "rsvps.userId": USER,
    });
  });

  it("queries the three user-keyed collections without a guild filter", async () => {
    // Recorded in the registry as `guildScoped: false`: moot today (single
    // guild via GUILD_ID) but this is the cross-guild read a future
    // multi-guild change has to revisit.
    await runExport();

    expect(FILTERS["voice-channel-tracking"]).toEqual({ userId: USER });
    expect(FILTERS["user-achievements"]).toEqual({ userId: USER });
    expect(FILTERS["user-voice-preferences"]).toEqual({ userId: USER });
  });

  it("returns null for a collection the member has no row in", async () => {
    const { payload, progress } = await runExport();

    expect(payload.data["voice-channel-tracking"]).toBeNull();
    expect(payload.data["user-birthday"]).toBeNull();
    expect(payload.data.reminder).toEqual([]);
    // Nothing was found, so nothing is reported as served.
    expect(progress.collections).toEqual([]);
  });

  it("keeps the member's own voice document, minus Mongo bookkeeping", async () => {
    DATA["voice-channel-tracking"] = {
      _id: "abc",
      __v: 0,
      userId: USER,
      username: "member",
      totalTime: 3600,
      sessions: [{ startTime: "2026-01-01", channelId: "c1" }],
    };

    const { payload, progress } = await runExport();
    const voice = payload.data["voice-channel-tracking"] as Record<
      string,
      unknown
    >;

    expect(voice._id).toBeUndefined();
    expect(voice.__v).toBeUndefined();
    expect(voice.totalTime).toBe(3600);
    expect(voice.totalSessionsStored).toBe(1);
    expect(progress.collections).toContain("voice-channel-tracking");
  });

  it("strips Mongo bookkeeping from nested subdocuments too", async () => {
    // `sessions[]` and the rollup arrays are inline subdocument schemas, so
    // Mongoose stamps every entry with its own `_id`. Removing only the outer
    // one left those internal ids in a member's download.
    DATA["voice-channel-tracking"] = {
      _id: "doc-id",
      __v: 3,
      userId: USER,
      sessions: [
        { _id: "session-id", channelId: "c1", companions: [{ _id: "x", userId: "friend-1" }] },
      ],
      monthlyTotals: [{ _id: "month-id", month: "2026-01", totalTime: 60 }],
    };

    const { payload, raw } = await runExport();
    const voice = payload.data["voice-channel-tracking"] as {
      sessions: Array<Record<string, unknown>>;
      monthlyTotals: Array<Record<string, unknown>>;
    };

    expect(raw).not.toContain("session-id");
    expect(raw).not.toContain("month-id");
    expect(raw).not.toContain("doc-id");
    expect(raw).not.toContain("__v");
    expect(voice.sessions[0]).not.toHaveProperty("_id");
    expect(voice.monthlyTotals[0]).not.toHaveProperty("_id");
    // Only the bookkeeping goes — the member's own data survives at depth.
    expect(voice.sessions[0].channelId).toBe("c1");
    expect(voice.sessions[0].companions).toEqual([{ userId: "friend-1" }]);
    expect(voice.monthlyTotals[0].month).toBe("2026-01");
  });

  it("keeps non-plain values (dates) intact while stripping ids", async () => {
    // Recursing into a Date would rebuild it as `{}`. Guard the distinction.
    const lastSeen = new Date("2026-05-01T12:00:00.000Z");
    DATA["voice-channel-tracking"] = {
      _id: "doc-id",
      userId: USER,
      lastSeen,
      sessions: [{ _id: "s1", startTime: lastSeen }],
    };

    const { payload } = await runExport();
    const voice = payload.data["voice-channel-tracking"] as {
      lastSeen: string;
      sessions: Array<{ startTime: string }>;
    };

    expect(voice.lastSeen).toBe("2026-05-01T12:00:00.000Z");
    expect(voice.sessions[0].startTime).toBe("2026-05-01T12:00:00.000Z");
  });

  it("caps append-only voice history and reports the truncation", async () => {
    mockGetNumber.mockResolvedValue(2);
    DATA["voice-channel-tracking"] = {
      userId: USER,
      sessions: [
        { channelId: "oldest" },
        { channelId: "middle" },
        { channelId: "newest" },
      ],
    };

    const { payload, progress } = await runExport();
    const voice = payload.data["voice-channel-tracking"] as {
      sessions: Array<{ channelId: string }>;
      totalSessionsStored: number;
    };

    // The most RECENT window survives, and the member is told the count they
    // actually have so a partial file is never mistaken for the whole thing.
    expect(voice.sessions.map((s) => s.channelId)).toEqual([
      "middle",
      "newest",
    ]);
    expect(voice.totalSessionsStored).toBe(3);
    expect(payload.truncated).toContain("voice-channel-tracking");
    expect(progress.truncated).toContain("voice-channel-tracking");
  });

  it("caps message detail the same way", async () => {
    mockGetNumber.mockResolvedValue(1);
    DATA["message-activity-tracking"] = {
      userId: USER,
      guildId: GUILD,
      totalCount: 9,
      recentMessages: [{ channelId: "a" }, { channelId: "b" }],
    };

    const { payload } = await runExport();
    const messages = payload.data["message-activity-tracking"] as {
      recentMessages: Array<{ channelId: string }>;
      totalRecentMessagesStored: number;
    };

    expect(messages.recentMessages).toEqual([{ channelId: "b" }]);
    expect(messages.totalRecentMessagesStored).toBe(2);
    expect(payload.truncated).toContain("message-activity-tracking");
  });

  it("caps list collections and asks Mongo for one row past the ceiling", async () => {
    mockGetNumber.mockResolvedValue(2);
    DATA.reminder = [{ message: "a" }, { message: "b" }, { message: "c" }];

    const { payload } = await runExport();

    // limit(maxItems + 1) is how truncation is detected without a count().
    expect(LIMITS.reminder).toBe(3);
    expect((payload.data.reminder as unknown[]).length).toBe(2);
    expect(payload.truncated).toContain("reminder");
  });

  it("never leaks the other voters on a shared poll-turnout row", async () => {
    DATA["poll-turnout"] = [
      {
        messageId: "m1",
        channelId: "c1",
        question: "Pizza?",
        postedAt: "2026-02-01T00:00:00.000Z",
        votesCast: 7,
        voterIds: [USER, "someone-else", "third-party"],
      },
    ];

    const { payload, raw } = await runExport();

    expect(payload.data["poll-turnout"]).toEqual([
      {
        messageId: "m1",
        channelId: "c1",
        question: "Pizza?",
        postedAt: "2026-02-01T00:00:00.000Z",
        youVoted: true,
        totalVoters: 3,
      },
    ]);
    expect(raw).not.toContain("someone-else");
    expect(raw).not.toContain("third-party");
  });

  it("returns only the member's own RSVP from a shared event row", async () => {
    DATA.event = [
      {
        title: "Game night",
        startTime: "2026-03-01T18:00:00.000Z",
        timezone: "Europe/Stockholm",
        state: "ended",
        createdBy: "organiser-9",
        rsvps: [
          { userId: "attendee-2", status: "maybe", respondedAt: "2026-02-01" },
          { userId: USER, status: "going", respondedAt: "2026-02-02" },
        ],
      },
    ];

    const { payload, raw } = await runExport();

    expect(payload.data["event-rsvp"]).toEqual([
      {
        title: "Game night",
        startTime: "2026-03-01T18:00:00.000Z",
        timezone: "Europe/Stockholm",
        state: "ended",
        yourRsvp: { status: "going", respondedAt: "2026-02-02" },
      },
    ]);
    expect(raw).not.toContain("attendee-2");
    // The organiser is classified as excluded (admin-authored field), so it
    // must not ride along on the RSVP the member IS entitled to.
    expect(raw).not.toContain("organiser-9");
  });

  it("returns only which reward roles list the member, not the roster", async () => {
    DATA["leaderboard-role-assignment"] = [
      {
        roleId: "role-1",
        topN: 3,
        updatedAt: "2026-01-01T00:00:00.000Z",
        userIds: [USER, "rival-1", "rival-2"],
      },
    ];

    const { payload, raw } = await runExport();

    expect(payload.data["leaderboard-role-assignment"]).toEqual([
      { roleId: "role-1", topN: 3, updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(raw).not.toContain("rival-1");
  });

  it("marks which side of a quote row matched the member", async () => {
    DATA.quote = [
      { content: "said it", authorId: USER, addedById: "curator-1" },
      { content: "saved it", authorId: "speaker-1", addedById: USER },
      { content: "both", authorId: USER, addedById: USER },
    ];

    const { payload } = await runExport();
    const quotes = payload.data.quote as Array<{
      content: string;
      yourRole: string;
    }>;

    expect(quotes.map((q) => q.yourRole)).toEqual([
      "said",
      "added",
      "said-and-added",
    ]);
    expect(FILTERS.quote).toEqual({
      $or: [{ authorId: USER }, { addedById: USER }],
    });
  });

  it("covers both sides of a channel invite", async () => {
    DATA["channel-invite"] = [
      { channelId: "c1", userId: USER, invitedBy: "host-1" },
      { channelId: "c2", userId: "guest-1", invitedBy: USER },
    ];

    const { payload } = await runExport();
    const invites = payload.data["channel-invite"] as Array<{
      yourRole: string;
    }>;

    expect(invites.map((i) => i.yourRole)).toEqual(["invited", "inviter"]);
  });

  it("falls back to the default ceiling on a nonsensical config value", async () => {
    mockGetNumber.mockResolvedValue(0);
    await expect(
      UserDataExportService.getInstance().getMaxItems(),
    ).resolves.toBe(DEFAULT_MAX_ITEMS);

    mockGetNumber.mockResolvedValue(Number.NaN);
    await expect(
      UserDataExportService.getInstance().getMaxItems(),
    ).resolves.toBe(DEFAULT_MAX_ITEMS);
  });

  it("rejects a read for a collection with no reader", async () => {
    await expect(
      UserDataExportService.getInstance().readCollection("moderation-log", {
        userId: USER,
        guildId: GUILD,
        maxItems: 10,
      }),
    ).rejects.toThrow(/No export reader/);
  });
});
