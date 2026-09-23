import { describe, it, expect, beforeEach, jest } from "@jest/globals";

/**
 * The coordinating per-user purge (#916).
 *
 * The registry drift test guards *which* collections are touched and under
 * which policy; this suite guards the four properties the coordinator itself
 * has to hold to, none of which a per-collection test can see:
 *
 *  - **order** — the in-memory voice eviction first, Discord side-effects
 *    before the rows that record them, the web session revoke last;
 *  - **independence** — one step throwing neither aborts the rest nor
 *    disappears from the report;
 *  - **idempotence** — there are no transactions, so a member who hits an
 *    error and clicks again must not be able to make things worse;
 *  - **scope** — guild-scoped collections are filtered on the guild, the
 *    five that have no `guildId` at all are not.
 *
 * Every model and owning service is mocked, so nothing here needs Mongo or a
 * gateway connection.
 */

/** Every model/service call in the order it happened, for the ordering tests. */
const CALLS: string[] = [];
/** Per-model filters, for the scope assertions. */
const FILTERS: Record<string, unknown> = {};
/** Per-model update documents, for the `$pull` assertions. */
const UPDATES: Record<string, unknown> = {};
/** Per-model results, set per test. */
const RESULTS: Record<string, unknown> = {};
/** Model names told to throw, and with what message. */
const THROWS: Record<string, string> = {};

function model(name: string): Record<string, unknown> {
  return {
    deleteMany: async (filter: unknown) => {
      CALLS.push(`${name}.deleteMany`);
      FILTERS[`${name}.deleteMany`] = filter;
      if (THROWS[`${name}.deleteMany`]) {
        throw new Error(THROWS[`${name}.deleteMany`]);
      }
      return RESULTS[`${name}.deleteMany`] ?? { deletedCount: 0 };
    },
    updateMany: async (filter: unknown, update: unknown) => {
      CALLS.push(`${name}.updateMany`);
      FILTERS[`${name}.updateMany`] = filter;
      UPDATES[`${name}.updateMany`] = update;
      if (THROWS[`${name}.updateMany`]) {
        throw new Error(THROWS[`${name}.updateMany`]);
      }
      return (
        RESULTS[`${name}.updateMany`] ?? { matchedCount: 0, modifiedCount: 0 }
      );
    },
  };
}

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

for (const [path, exportName, label] of [
  ["voice-channel-tracking", "VoiceChannelTracking", "voice-channel-tracking"],
  [
    "message-activity-tracking",
    "MessageActivityTracking",
    "message-activity-tracking",
  ],
  [
    "reaction-activity-tracking",
    "ReactionActivityTracking",
    "reaction-activity-tracking",
  ],
  [
    "poll-participation-tracking",
    "PollParticipationTracking",
    "poll-participation-tracking",
  ],
  ["poll-turnout", "PollTurnout", "poll-turnout"],
  ["user-achievements", "UserAchievements", "user-achievements"],
  [
    "user-notification-prefs",
    "UserNotificationPrefs",
    "user-notification-prefs",
  ],
  ["user-voice-preferences", "UserVoicePreferences", "user-voice-preferences"],
  ["rewind-snapshot", "RewindSnapshot", "rewind-snapshot"],
  ["rewind-nudge-state", "RewindNudgeState", "rewind-nudge-state"],
  ["digest-state", "DigestState", "digest-state"],
  ["reminder", "Reminder", "reminder"],
  ["channel-invite", "ChannelInvite", "channel-invite"],
] as const) {
  jest.unstable_mockModule(`../../src/models/${path}.js`, () => ({
    [exportName]: model(label),
  }));
}

const forgetActiveSession = jest.fn<
  (userId: string) => {
    discarded: boolean;
    drained: boolean;
    timedOut: boolean;
  }
>();
const revokeForUser =
  jest.fn<
    (
      guildId: string,
      userId: string,
    ) => Promise<{ revoked: string[]; retained: string[] }>
  >();
const removeRsvp = jest.fn<
  (
    guildId: string,
    userId: string,
  ) => Promise<{
    matched: number;
    removed: number;
    rendersFailed: number;
  }>
>();
const purgeForUser = jest.fn<
  (
    userId: string,
    messages: unknown,
  ) => Promise<{
    deleted: number;
    messagesAttempted: number;
    messagesDeleted: number;
    messagesFailed: number;
    anonymised: number;
  }>
>();
/** A birthday purge with no recorded posts to take down. */
const NO_BIRTHDAY_POSTS = {
  announcementsAttempted: 0,
  announcementsDeleted: 0,
  announcementsFailed: 0,
};

const birthdayPurgeForUser = jest.fn<
  (
    guildId: string,
    userId: string,
  ) => Promise<{
    matched: number;
    removed: number;
    roleRevoked: boolean;
    announcementsAttempted: number;
    announcementsDeleted: number;
    announcementsFailed: number;
    error?: string;
  }>
>();
const revokeSessionsForUser = jest.fn<(userId: string) => Promise<number>>();

jest.unstable_mockModule("../../src/services/voice-channel-tracker.js", () => ({
  VoiceChannelTracker: {
    getInstance: () => ({
      forgetActiveSession: async (userId: string) => {
        CALLS.push("voice.forgetActiveSession");
        return forgetActiveSession(userId);
      },
    }),
  },
}));

jest.unstable_mockModule(
  "../../src/services/leaderboard-role-service.js",
  () => ({
    LeaderboardRoleService: {
      getInstance: () => ({
        revokeForUser: async (guildId: string, userId: string) => {
          CALLS.push("leaderboard.revokeForUser");
          return revokeForUser(guildId, userId);
        },
      }),
    },
  }),
);

jest.unstable_mockModule("../../src/services/birthday-service.js", () => ({
  BirthdayService: {
    getInstance: () => ({
      purgeForUser: async (guildId: string, userId: string) => {
        CALLS.push("birthday.purgeForUser");
        return birthdayPurgeForUser(guildId, userId);
      },
    }),
  },
}));

jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  EventService: {
    getInstance: () => ({
      removeRsvp: async (guildId: string, userId: string) => {
        CALLS.push("event.removeRsvp");
        return removeRsvp(guildId, userId);
      },
    }),
  },
}));

jest.unstable_mockModule("../../src/services/quote-channel-manager.js", () => ({
  QuoteChannelManager: {
    getInstance: () => ({ deleteQuoteMessage: jest.fn() }),
  },
}));

jest.unstable_mockModule("../../src/services/quote-service.js", () => ({
  quoteService: {
    purgeForUser: async (userId: string, messages: unknown) => {
      CALLS.push("quote.purgeForUser");
      return purgeForUser(userId, messages);
    },
  },
}));

jest.unstable_mockModule("../../src/services/web-session-service.js", () => ({
  WebSessionService: {
    getInstance: () => ({
      revokeForUser: async (userId: string) => {
        CALLS.push("session.revokeForUser");
        return revokeSessionsForUser(userId);
      },
    }),
  },
}));

const {
  UserDataDeletionService,
  DELETER_COLLECTIONS,
  PURGE_ORDER,
  VOICE_SESSION_CACHE,
} = await import("../../src/services/user-data-deletion-service.js");
const { ANONYMISED_USER_ID } =
  await import("../../src/services/user-data-registry.js");

type PurgeStep = {
  collection: string;
  action: string;
  matched: number;
  removed: number;
  error?: string;
  note?: string;
};

const USER = "member-1";
const GUILD = "guild-1";

const client = {} as never;

function service(): {
  purge: (u: string, g: string) => Promise<{ steps: PurgeStep[]; ok: boolean }>;
} {
  UserDataDeletionService.reset();
  return UserDataDeletionService.getInstance(client) as never;
}

/** Steps for one collection, in emission order. */
function stepsFor(
  report: { steps: PurgeStep[] },
  collection: string,
): PurgeStep[] {
  return report.steps.filter((step) => step.collection === collection);
}

describe("UserDataDeletionService.purge", () => {
  beforeEach(() => {
    CALLS.length = 0;
    for (const store of [FILTERS, UPDATES, RESULTS, THROWS]) {
      for (const key of Object.keys(store)) delete store[key];
    }
    forgetActiveSession
      .mockReset()
      .mockReturnValue({ discarded: false, drained: false, timedOut: false });
    revokeForUser.mockReset().mockResolvedValue({ revoked: [], retained: [] });
    removeRsvp
      .mockReset()
      .mockResolvedValue({ matched: 0, removed: 0, rendersFailed: 0 });
    purgeForUser.mockReset().mockResolvedValue({
      authored: 0,
      deleted: 0,
      messagesAttempted: 0,
      messagesDeleted: 0,
      messagesFailed: 0,
      anonymised: 0,
      attributionsRerendered: 0,
      attributionsStale: 0,
    });
    birthdayPurgeForUser.mockReset().mockResolvedValue({
      matched: 0,
      removed: 0,
      roleRevoked: false,
      ...NO_BIRTHDAY_POSTS,
    });
    revokeSessionsForUser.mockReset().mockResolvedValue(0);
  });

  describe("step order", () => {
    it("evicts the in-memory voice session before anything is written", async () => {
      // `endTracking` persists with `upsert: true`, so a member still sitting
      // in a channel would have their tracking row recreated on disconnect —
      // carrying the whole session's total, purge included.
      const report = await service().purge(USER, GUILD);

      expect(CALLS[0]).toBe("voice.forgetActiveSession");
      expect(report.steps[0]).toMatchObject({
        collection: VOICE_SESSION_CACHE,
        action: "evict",
      });
    });

    it("revokes the leaderboard role on Discord before any collection is touched", async () => {
      // A Discord grant with no record that it is still owed is the one
      // failure a retry cannot see, so the side-effect goes first.
      await service().purge(USER, GUILD);

      const revoke = CALLS.indexOf("leaderboard.revokeForUser");
      const firstDelete = CALLS.findIndex((call) =>
        call.endsWith(".deleteMany"),
      );
      expect(revoke).toBeGreaterThan(-1);
      expect(revoke).toBeLessThan(firstDelete);
    });

    it("deletes quote-channel posts before the inert collections", async () => {
      await service().purge(USER, GUILD);

      expect(CALLS.indexOf("quote.purgeForUser")).toBeLessThan(
        CALLS.indexOf("voice-channel-tracking.deleteMany"),
      );
    });

    it("removes RSVPs after the Discord revokes and before the inert collections", async () => {
      await service().purge(USER, GUILD);

      expect(CALLS.indexOf("event.removeRsvp")).toBeGreaterThan(
        CALLS.indexOf("leaderboard.revokeForUser"),
      );
      expect(CALLS.indexOf("event.removeRsvp")).toBeLessThan(
        CALLS.indexOf("reminder.deleteMany"),
      );
    });

    it("re-checks the voice tracking row after the rest of the purge", async () => {
      // Belt and braces against a disconnect racing the eviction.
      const report = await service().purge(USER, GUILD);

      const indexes = CALLS.flatMap((call, index) =>
        call === "voice-channel-tracking.deleteMany" ? [index] : [],
      );
      expect(indexes).toHaveLength(2);
      expect(indexes[1]).toBeGreaterThan(
        CALLS.indexOf("channel-invite.updateMany"),
      );
      expect(stepsFor(report, "voice-channel-tracking")[1].note).toBe(
        "post-purge re-check",
      );
    });

    it("revokes web sessions last", async () => {
      // Any earlier and it kills the session the caller still needs to
      // render its own result.
      const report = await service().purge(USER, GUILD);

      expect(CALLS[CALLS.length - 1]).toBe("session.revokeForUser");
      expect(report.steps[report.steps.length - 1]).toMatchObject({
        collection: "web-session",
        action: "revoke",
      });
    });

    it("runs every declared deleter once, in the declared order", () => {
      expect([...PURGE_ORDER].sort()).toEqual([...DELETER_COLLECTIONS].sort());
    });
  });

  describe("scope", () => {
    it("filters guild-scoped collections on the guild", async () => {
      await service().purge(USER, GUILD);

      for (const name of [
        "message-activity-tracking",
        "reaction-activity-tracking",
        "poll-participation-tracking",
        "user-notification-prefs",
        "rewind-snapshot",
        "rewind-nudge-state",
        "digest-state",
        "reminder",
      ]) {
        expect(FILTERS[`${name}.deleteMany`]).toEqual({
          userId: USER,
          guildId: GUILD,
        });
      }
      expect(FILTERS["poll-turnout.updateMany"]).toEqual({
        guildId: GUILD,
        voterIds: USER,
      });
    });

    it("keys the collections with no guildId on the user id alone", async () => {
      // The registry's `guildScoped: false` entries: moot while the bot is
      // single-guild, and the exact list a multi-guild change has to revisit.
      await service().purge(USER, GUILD);

      for (const name of [
        "voice-channel-tracking",
        "user-achievements",
        "user-voice-preferences",
        "channel-invite",
      ]) {
        expect(FILTERS[`${name}.deleteMany`]).toEqual({ userId: USER });
      }
    });
  });

  describe("policies", () => {
    it("pulls the member out of the shared poll turnout without touching votesCast", async () => {
      // `votesCast` counts vote *events*, not people, and is legitimately
      // higher than the voter count on a multiselect poll.
      RESULTS["poll-turnout.updateMany"] = {
        matchedCount: 3,
        modifiedCount: 3,
      };

      const report = await service().purge(USER, GUILD);

      expect(UPDATES["poll-turnout.updateMany"]).toEqual({
        $pull: { voterIds: USER },
      });
      expect(JSON.stringify(UPDATES["poll-turnout.updateMany"])).not.toContain(
        "votesCast",
      );
      expect(stepsFor(report, "poll-turnout")[0]).toMatchObject({
        action: "pull-member",
        matched: 3,
        removed: 3,
      });
    });

    it("deletes invites the member received and anonymises the ones they sent", async () => {
      // `invitedBy` is `required: true`, so the sender attribution takes the
      // sentinel rather than a null — the recipient's access has to survive.
      RESULTS["channel-invite.deleteMany"] = { deletedCount: 2 };
      RESULTS["channel-invite.updateMany"] = {
        matchedCount: 4,
        modifiedCount: 4,
      };

      const report = await service().purge(USER, GUILD);

      expect(UPDATES["channel-invite.updateMany"]).toEqual({
        $set: { invitedBy: ANONYMISED_USER_ID },
      });
      expect(stepsFor(report, "channel-invite")).toMatchObject([
        { action: "hard-delete", matched: 2, removed: 2 },
        { action: "anonymise", matched: 4, removed: 4 },
      ]);
      // Delete first: a row matching both ends up gone, not anonymised.
      expect(CALLS.indexOf("channel-invite.deleteMany")).toBeLessThan(
        CALLS.indexOf("channel-invite.updateMany"),
      );
    });

    it("reports the rows, the Discord posts and the anonymisation separately", async () => {
      purgeForUser.mockResolvedValue({
        authored: 5,
        deleted: 5,
        messagesAttempted: 5,
        messagesDeleted: 5,
        messagesFailed: 0,
        anonymised: 2,
        attributionsRerendered: 0,
        attributionsStale: 0,
      });

      const report = await service().purge(USER, GUILD);

      expect(stepsFor(report, "quote")).toMatchObject([
        { action: "hard-delete", matched: 5, removed: 5 },
        {
          action: "hard-delete",
          matched: 5,
          removed: 5,
          note: "quote-channel posts",
        },
        { action: "anonymise", matched: 2, removed: 2 },
      ]);
      expect(report.ok).toBe(true);
    });

    it("fails the purge when a quote post still names the member as saver", async () => {
      // The row is anonymised but the embed prints "Added by @member", so
      // the erasure is unfinished where anyone can actually see it (#916).
      purgeForUser.mockResolvedValue({
        authored: 0,
        deleted: 0,
        messagesAttempted: 0,
        messagesDeleted: 0,
        messagesFailed: 0,
        anonymised: 2,
        attributionsRerendered: 1,
        attributionsStale: 1,
      });

      const report = await service().purge(USER, GUILD);

      const step = stepsFor(report, "quote")[2];
      expect(step).toMatchObject({ action: "anonymise", removed: 2 });
      expect(step.error).toContain("still name this member");
      expect(report.ok).toBe(false);
    });

    it("fails the purge when a quote post may still be visible", async () => {
      // The row is deleted either way, so this step is the only record that
      // the member's words are still on screen in Discord.
      purgeForUser.mockResolvedValue({
        authored: 3,
        deleted: 3,
        messagesAttempted: 3,
        messagesDeleted: 1,
        messagesFailed: 2,
        anonymised: 0,
        attributionsRerendered: 0,
        attributionsStale: 0,
      });

      const report = await service().purge(USER, GUILD);

      const posts = stepsFor(report, "quote")[1];
      expect(posts).toMatchObject({ matched: 3, removed: 1 });
      expect(posts.error).toContain("still be visible");
      expect(report.ok).toBe(false);
    });

    it("fails the purge when the quote row delete could not finish", async () => {
      // The posts are already deleted by then, so the service reports the
      // failure instead of throwing — and the coordinator has to carry it
      // through rather than treat the smaller number as a success.
      purgeForUser.mockResolvedValue({
        authored: 4,
        deleted: 0,
        deleteError: "write conflict",
        messagesAttempted: 4,
        messagesDeleted: 4,
        messagesFailed: 0,
        anonymised: 1,
        attributionsRerendered: 0,
        attributionsStale: 0,
      });

      const report = await service().purge(USER, GUILD);

      expect(stepsFor(report, "quote")[0]).toMatchObject({
        matched: 4,
        removed: 0,
        error: "write conflict",
      });
      // The anonymisation still ran and is still reported.
      expect(stepsFor(report, "quote")[2]).toMatchObject({
        action: "anonymise",
        removed: 1,
      });
      expect(report.ok).toBe(false);
    });

    it("reports an RSVP removal that cleared only some of the events", async () => {
      removeRsvp.mockResolvedValue({
        matched: 3,
        removed: 2,
        rendersFailed: 0,
      });

      const report = await service().purge(USER, GUILD);

      expect(stepsFor(report, "event-rsvp")[0]).toMatchObject({
        matched: 3,
        removed: 2,
      });
      expect(report.ok).toBe(false);
    });

    it("fails the purge when an event announcement could not be refreshed", async () => {
      // The RSVP row is gone, but the message still shows the member as
      // attending — their data, still readable by the whole guild.
      removeRsvp.mockResolvedValue({
        matched: 2,
        removed: 2,
        rendersFailed: 1,
      });

      const report = await service().purge(USER, GUILD);

      const step = stepsFor(report, "event-rsvp")[0];
      expect(step).toMatchObject({ matched: 2, removed: 2 });
      expect(step.error).toContain("could not be refreshed");
      expect(report.ok).toBe(false);
    });

    it("still anonymises invites when the invite delete fails", async () => {
      // Two independent policies on one collection: a failed delete must not
      // stop the sender attribution from being cleared, nor leave the report
      // with no row for it at all.
      THROWS["channel-invite.deleteMany"] = "write conflict";
      RESULTS["channel-invite.updateMany"] = {
        matchedCount: 3,
        modifiedCount: 3,
      };

      const report = await service().purge(USER, GUILD);

      expect(stepsFor(report, "channel-invite")).toMatchObject([
        {
          action: "hard-delete",
          matched: 0,
          removed: 0,
          error: "write conflict",
        },
        { action: "anonymise", matched: 3, removed: 3 },
      ]);
      expect(report.ok).toBe(false);
    });

    it("revokes the birthday role before the row that records it", async () => {
      // `roleAssignedAt` on that row is the expiry sweep's only handle on the
      // grant, so deleting it first would strand the role permanently.
      birthdayPurgeForUser.mockResolvedValue({
        matched: 1,
        removed: 1,
        roleRevoked: true,
        ...NO_BIRTHDAY_POSTS,
      });

      const report = await service().purge(USER, GUILD);

      expect(stepsFor(report, "user-birthday")[0]).toMatchObject({
        matched: 1,
        removed: 1,
        note: "birthday role revoked",
      });
      expect(CALLS.indexOf("birthday.purgeForUser")).toBeLessThan(
        CALLS.indexOf("reminder.deleteMany"),
      );
    });

    it("gives the birthday posts a step of their own", async () => {
      // Each one names the member, and often their age, in a channel the
      // whole guild reads — rolling them into the row count would hide a
      // message that is still up (#916).
      birthdayPurgeForUser.mockResolvedValue({
        matched: 1,
        removed: 1,
        roleRevoked: false,
        announcementsAttempted: 2,
        announcementsDeleted: 2,
        announcementsFailed: 0,
      });

      const report = await service().purge(USER, GUILD);

      const steps = stepsFor(report, "user-birthday");
      expect(steps[0]).toMatchObject({
        matched: 2,
        removed: 2,
        note: "birthday announcements",
      });
      expect(steps[1]).toMatchObject({ matched: 1, removed: 1 });
      expect(report.ok).toBe(true);
    });

    it("fails the purge when a birthday post is still public", async () => {
      birthdayPurgeForUser.mockResolvedValue({
        matched: 1,
        removed: 0,
        roleRevoked: false,
        announcementsAttempted: 2,
        announcementsDeleted: 1,
        announcementsFailed: 1,
        error: "1 birthday announcement(s) could not be deleted",
      });

      const report = await service().purge(USER, GUILD);

      expect(stepsFor(report, "user-birthday")[0].error).toContain(
        "may still name this member",
      );
      expect(report.ok).toBe(false);
    });

    it("fails the purge when the birthday role could not be taken back", async () => {
      birthdayPurgeForUser.mockResolvedValue({
        matched: 1,
        removed: 0,
        roleRevoked: false,
        ...NO_BIRTHDAY_POSTS,
        error: "could not take back the birthday role",
      });

      const report = await service().purge(USER, GUILD);

      expect(stepsFor(report, "user-birthday")[0]).toMatchObject({
        matched: 1,
        removed: 0,
      });
      expect(report.ok).toBe(false);
    });

    it("reports a leaderboard role whose Discord revoke failed as a partial step", async () => {
      // The id stays on the roster so the next reconcile retries — but the
      // member is still wearing the role, which the report has to say.
      revokeForUser.mockResolvedValue({
        revoked: ["role-a"],
        retained: ["role-b"],
      });

      const report = await service().purge(USER, GUILD);

      const step = stepsFor(report, "leaderboard-role-assignment")[0];
      expect(step).toMatchObject({ matched: 2, removed: 1 });
      expect(step.error).toContain("role-b");
      expect(step.error).toContain("Leaderboard cleanup incomplete");
      // The next reconcile will retry, but until it does the member is still
      // wearing a reward role they asked to be forgotten from — so the purge
      // did not succeed, whatever the retry does later.
      expect(report.ok).toBe(false);
    });

    it("records the in-flight voice session it discarded", async () => {
      forgetActiveSession.mockReturnValue({
        discarded: true,
        drained: false,
        timedOut: false,
      });

      const report = await service().purge(USER, GUILD);

      expect(stepsFor(report, VOICE_SESSION_CACHE)[0]).toMatchObject({
        action: "evict",
        matched: 1,
        removed: 1,
      });
    });

    it("fails the purge but finishes it when the voice drain times out", async () => {
      // A persist still running can land after the deletes and resurrect the
      // row, so the purge cannot claim to have closed the window — but it
      // must not hang on it either.
      forgetActiveSession.mockReturnValue({
        discarded: true,
        drained: true,
        timedOut: true,
      });

      const report = await service().purge(USER, GUILD);

      expect(stepsFor(report, VOICE_SESSION_CACHE)[0].error).toContain(
        "may be recreated",
      );
      expect(report.ok).toBe(false);
      // Everything after it still ran, including the last step of all.
      expect(CALLS).toContain("reminder.deleteMany");
      expect(CALLS[CALLS.length - 1]).toBe("session.revokeForUser");
    });

    it("records that it waited out a persist already in flight", async () => {
      // Evicting the maps cannot call back a persist that already read its
      // session; the tracker waits for it so the delete below lands after
      // that write instead of racing it.
      forgetActiveSession.mockReturnValue({
        discarded: false,
        drained: true,
        timedOut: false,
      });

      const report = await service().purge(USER, GUILD);

      expect(stepsFor(report, VOICE_SESSION_CACHE)[0].note).toContain(
        "waited for a persist already in flight",
      );
    });

    it("deletes a tracking row recreated mid-purge", async () => {
      RESULTS["voice-channel-tracking.deleteMany"] = { deletedCount: 1 };

      const report = await service().purge(USER, GUILD);

      const [first, recheck] = stepsFor(report, "voice-channel-tracking");
      expect(first.removed).toBe(1);
      expect(recheck).toMatchObject({
        removed: 1,
        note: "post-purge re-check",
      });
    });
  });

  describe("failures", () => {
    it("records a failing step and keeps going", async () => {
      // There are no transactions and nothing to roll back to, so the useful
      // behaviour is to finish and say which step is still owed.
      THROWS["user-achievements.deleteMany"] = "mongo is down";

      const report = await service().purge(USER, GUILD);

      const step = stepsFor(report, "user-achievements")[0];
      expect(step).toMatchObject({
        action: "hard-delete",
        matched: 0,
        removed: 0,
        error: "mongo is down",
      });
      expect(report.ok).toBe(false);
      // Everything after it still ran, including the last step of all.
      expect(CALLS).toContain("reminder.deleteMany");
      expect(CALLS[CALLS.length - 1]).toBe("session.revokeForUser");
    });

    it("keeps the completed half of a two-policy deleter that fails mid-way", async () => {
      // `channel-invite` deletes the invites the member received and only
      // then anonymises the ones they sent. Losing the first outcome because
      // the second threw would report deleted rows as still owed and send a
      // retry hunting for rows that are already gone.
      RESULTS["channel-invite.deleteMany"] = { deletedCount: 2 };
      THROWS["channel-invite.updateMany"] = "write conflict";

      const report = await service().purge(USER, GUILD);

      expect(stepsFor(report, "channel-invite")).toMatchObject([
        { action: "hard-delete", matched: 2, removed: 2 },
        // And the failure is reported against the policy that actually
        // failed, not the first one the deleter declares.
        {
          action: "anonymise",
          matched: 0,
          removed: 0,
          error: "write conflict",
        },
      ]);
      expect(report.ok).toBe(false);
    });

    it("keeps the rest of the purge when a Discord side-effect fails", async () => {
      revokeForUser.mockRejectedValue(new Error("discord unreachable"));

      const report = await service().purge(USER, GUILD);

      expect(stepsFor(report, "leaderboard-role-assignment")[0]).toMatchObject({
        action: "pull-member",
        error: "discord unreachable",
      });
      expect(report.ok).toBe(false);
      expect(CALLS).toContain("quote.purgeForUser");
      expect(CALLS).toContain("event.removeRsvp");
    });

    it("reports one step per collection even when nothing matched", async () => {
      const report = await service().purge(USER, GUILD);

      expect(report.ok).toBe(true);
      // One per registry collection, plus the two quote/channel-invite
      // second policies, plus the eviction, the re-check and the revoke.
      for (const collection of DELETER_COLLECTIONS) {
        expect(stepsFor(report, collection).length).toBeGreaterThan(0);
      }
      expect(stepsFor(report, VOICE_SESSION_CACHE)).toHaveLength(1);
      expect(stepsFor(report, "web-session")).toHaveLength(1);
      expect(report.steps.every((step) => step.matched === 0)).toBe(true);
    });
  });

  describe("idempotence", () => {
    it("is a no-op the second time", async () => {
      // First run: everything matches.
      RESULTS["voice-channel-tracking.deleteMany"] = { deletedCount: 1 };
      RESULTS["user-achievements.deleteMany"] = { deletedCount: 1 };
      RESULTS["poll-turnout.updateMany"] = {
        matchedCount: 2,
        modifiedCount: 2,
      };
      RESULTS["channel-invite.deleteMany"] = { deletedCount: 1 };
      RESULTS["channel-invite.updateMany"] = {
        matchedCount: 1,
        modifiedCount: 1,
      };
      forgetActiveSession.mockReturnValue({
        discarded: true,
        drained: true,
        timedOut: false,
      });
      revokeForUser.mockResolvedValue({ revoked: ["role-a"], retained: [] });
      removeRsvp.mockResolvedValue({
        matched: 2,
        removed: 2,
        rendersFailed: 0,
      });
      purgeForUser.mockResolvedValue({
        authored: 3,
        deleted: 3,
        messagesAttempted: 3,
        messagesDeleted: 3,
        messagesFailed: 0,
        anonymised: 1,
        attributionsRerendered: 0,
        attributionsStale: 0,
      });
      birthdayPurgeForUser.mockResolvedValue({
        matched: 1,
        removed: 1,
        roleRevoked: true,
      });
      revokeSessionsForUser.mockResolvedValue(1);

      const instance = service();
      const first = await instance.purge(USER, GUILD);
      expect(first.ok).toBe(true);
      expect(first.steps.some((step) => step.removed > 0)).toBe(true);

      // Second run: the rows are gone, so every step matches nothing. The
      // mocks stand in for the database having been emptied by the first.
      for (const key of Object.keys(RESULTS)) delete RESULTS[key];
      forgetActiveSession.mockReturnValue({
        discarded: false,
        drained: false,
        timedOut: false,
      });
      revokeForUser.mockResolvedValue({ revoked: [], retained: [] });
      removeRsvp.mockResolvedValue({
        matched: 0,
        removed: 0,
        rendersFailed: 0,
      });
      purgeForUser.mockResolvedValue({
        authored: 0,
        deleted: 0,
        messagesAttempted: 0,
        messagesDeleted: 0,
        messagesFailed: 0,
        anonymised: 0,
        attributionsRerendered: 0,
        attributionsStale: 0,
      });
      birthdayPurgeForUser.mockResolvedValue({
        matched: 0,
        removed: 0,
        roleRevoked: false,
      });
      revokeSessionsForUser.mockResolvedValue(0);

      const second = await instance.purge(USER, GUILD);

      expect(second.ok).toBe(true);
      expect(second.steps.map((step) => step.collection)).toEqual(
        first.steps.map((step) => step.collection),
      );
      expect(second.steps.every((step) => step.removed === 0)).toBe(true);
    });
  });
});
