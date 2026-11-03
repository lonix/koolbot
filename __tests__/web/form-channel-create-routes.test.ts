/**
 * Creating the channel a plain form asks for, on the Announcements and Polls
 * pages (#1665), driven over HTTP with the real routes, the real helper and the
 * real planner. Discord reads and writes, the permission check, the services and
 * the audit log are mocked.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { ChannelType, type Client } from "discord.js";
import {
  startAdminHarness,
  stubRequireSession,
  createTestSession,
  parseFlashRedirect,
  type AdminHarness,
} from "./admin-harness.js";
import type { ManagedChannelView } from "../../src/web/channel-manager.js";

const mockRecordAudit = jest.fn<(...a: any[]) => Promise<void>>(
  async () => undefined,
);
jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: () => false,
}));

const mockCreateAnnouncement = jest.fn<(...a: any[]) => Promise<any>>();
const mockPostOnce = jest.fn<(...a: any[]) => Promise<void>>();
jest.unstable_mockModule(
  "../../src/services/scheduled-announcement-service.js",
  () => ({
    ScheduledAnnouncementService: {
      getInstance: (): unknown => ({
        createAnnouncement: mockCreateAnnouncement,
        postOnce: mockPostOnce,
      }),
    },
  }),
);
jest.unstable_mockModule(
  "../../src/services/voice-channel-announcer.js",
  () => ({ VoiceChannelAnnouncer: { getInstance: (): unknown => ({}) } }),
);
const mockCreateSchedule = jest.fn<(...a: any[]) => Promise<any>>();
const mockUpdateSchedule = jest.fn<(...a: any[]) => Promise<any>>();
const mockGetSchedule = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule("../../src/services/poll-service.js", () => ({
  PollService: {
    getInstance: (): unknown => ({
      createSchedule: mockCreateSchedule,
      updateSchedule: mockUpdateSchedule,
      getSchedule: mockGetSchedule,
    }),
  },
}));
jest.unstable_mockModule("../../src/services/command-manager.js", () => ({
  CommandManager: {
    getInstance: (): unknown => ({
      makeDiscordApiCall: async (fn: () => Promise<unknown>) => fn(),
    }),
  },
}));

type Can = { ok: true } | { ok: false; reason: string } | { ok: "unknown" };
let can: Can = { ok: true };
const mockCanBotCreate = jest.fn<(...a: any[]) => Promise<Can>>(
  async () => can,
);
jest.unstable_mockModule("../../src/services/bot-create-check.js", () => ({
  canBotCreate: mockCanBotCreate,
  toPickerCreate: (
    kind: string,
    answer: { ok: unknown; reason?: string },
    channelKind?: string,
  ) =>
    answer.ok === "unknown"
      ? undefined
      : {
          kind,
          ...(channelKind ? { channelKind } : {}),
          ok: answer.ok,
          ...(answer.ok === false ? { reason: answer.reason } : {}),
        },
}));

let live: ManagedChannelView[] = [];
const mockFetchViews = jest.fn<(...a: any[]) => Promise<ManagedChannelView[]>>(
  async () => live,
);
jest.unstable_mockModule("../../src/web/channel-manager-data.js", () => ({
  fetchChannelViews: mockFetchViews,
  maxBitrateOf: () => 96000,
  botCanManageChannels: async () => true,
}));

const mockPost = jest.fn<(...a: any[]) => Promise<any>>();
const mockDelete = jest.fn<(...a: any[]) => Promise<any>>(async () => ({}));
jest.unstable_mockModule("../../src/web/channel-write-rest.js", () => ({
  createWriteRest: () => ({ post: mockPost, delete: mockDelete }),
  cancellableCall: async (
    _m: unknown,
    fn: (s: AbortSignal) => Promise<unknown>,
  ) => fn(new AbortController().signal),
  describeWriteFailure: (e: unknown) =>
    e instanceof Error ? `Discord refused: ${e.message}` : "Discord refused.",
}));

const { createAnnouncementsRouter } =
  await import("../../src/web/routes/write/announcements.js");
const { createPollsRouter } =
  await import("../../src/web/routes/write/polls.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");
const { registerFormPage } = await import("../../src/web/form-pages.js");
const { renderAnnouncementsPage, renderPollsPage } =
  await import("../../src/web/admin-views.js");
const { createFormChannels, readPostedChannel } =
  await import("../../src/web/form-channel-create.js");

const view = (
  id: string,
  over: Partial<ManagedChannelView>,
): ManagedChannelView => ({
  id,
  name: id,
  kind: "text",
  typeLabel: "text",
  parentId: null,
  position: 0,
  topic: null,
  userLimit: null,
  bitrate: null,
  ...over,
});

const client = {
  token: "bot-token",
  user: { id: "bot" },
  guilds: { fetch: async () => ({ id: "guild-1", name: "G" }) },
} as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;
let nextId = 100000000000000100n;
const CHANNELS = [
  { id: "100000000000000001", name: "general", type: ChannelType.GuildText },
];

const registerPages = (): void => {
  const common = {
    guildId: "guild-1",
    csrfToken: "csrf",
    remainingMs: 1000,
    navFeatureStatus: {},
    enabled: true,
    textChannels: CHANNELS,
  };
  registerFormPage("/admin/announcements", async (_req, refused) =>
    renderAnnouncementsPage({
      ...common,
      rows: [],
      settingRows: [],
      createChannel: { kind: "channel", channelKind: "text", ok: true },
      refusedForm: refused,
    }),
  );
  registerFormPage("/admin/polls", async (_req, refused) =>
    renderPollsPage({
      ...common,
      defaultDurationHours: 24,
      cooldownDays: 7,
      settingRows: [],
      roles: [],
      items: [],
      createChannel: { kind: "channel", channelKind: "text", ok: true },
      schedules: [
        {
          id: "s1",
          channelId: "100000000000000001",
          channelName: "general",
          channelType: ChannelType.GuildText,
          cron: "0 12 * * 3",
          durationHours: 24,
          pingRoleId: null,
          pingRoleName: null,
          enabled: true,
          lastRun: "—",
        },
      ],
      refusedForm: refused,
    }),
  );
};

beforeEach(async () => {
  jest.clearAllMocks();
  can = { ok: true };
  mockFetchViews.mockReset();
  mockFetchViews.mockImplementation(async () => live);
  live = [view("100000000000000001", { name: "general" })];
  nextId = 100000000000000100n;
  mockDelete.mockResolvedValue({});
  mockPost.mockImplementation(async (_route: string, o: any) => ({
    id: String(nextId++),
    name: o.body.name,
  }));
  mockCreateAnnouncement.mockResolvedValue({ _id: "ann-1" });
  mockPostOnce.mockResolvedValue(undefined);
  mockCreateSchedule.mockResolvedValue({ _id: "sch-1" });
  mockUpdateSchedule.mockResolvedValue({ _id: "s1" });
  mockGetSchedule.mockResolvedValue({ guildId: session.guildId });
  registerPages();
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createAnnouncementsRouter(client),
    createPollsRouter(client),
  ]);
});
afterEach(async () => {
  await harness.close();
});

const lastAudit = (): Record<string, any> =>
  mockRecordAudit.mock.calls[mockRecordAudit.mock.calls.length - 1][1];
const ANN = { cron: "0 9 * * 1", message: "Standup in 5" };
const SCHEDULE = { cron: "0 12 * * 3", durationHours: "24", pingRoleId: "" };
const created = (): any[] => mockPost.mock.calls.map((c) => c[1].body);

/** A refused form: 422, the page, and the error line of the Channel field. */
async function refused(res: Response, formId: string): Promise<string> {
  expect(res.status).toBe(422);
  const html = await res.text();
  expect(html).toContain(`id="${formId}-channelId-error"`);
  return html;
}

describe("Announcements: a pending creation is created, then stored (#1665)", () => {
  it("create: the channel exists first, the schedule is stored with its id, the flash and audit say so", async () => {
    const res = await harness.post("/announcements/create", {
      ...ANN,
      channelId: "create:Daily News",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe(
      "Created announcement ann-1. Created # daily-news for Channel.",
    );
    // No parent and no permission overwrites: the helper decides.
    expect(created()).toEqual([
      { name: "daily-news", type: ChannelType.GuildText },
    ]);
    expect(mockCreateAnnouncement.mock.calls[0][0]).toMatchObject({
      guildId: session.guildId,
      channelId: "100000000000000100",
    });
    expect(lastAudit().details.channel).toEqual({
      id: "100000000000000100",
      name: "daily-news",
      created: true,
    });
    // Posted before the stored write: the post of the channel came first.
    expect(mockPost.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateAnnouncement.mock.invocationCallOrder[0],
    );
  });

  it("post-once: creates the channel, then posts into it", async () => {
    const res = await harness.post("/announcements/post-once", {
      message: "Hello",
      channelId: "create:Daily News",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("Created # daily-news for Channel.");
    expect(mockPostOnce.mock.calls[0][0]).toMatchObject({
      channelId: "100000000000000100",
    });
    expect(created()).toHaveLength(1);
  });

  it("a failed create stores nothing, keeps the typed name and shows the error under the field", async () => {
    mockPost.mockRejectedValue(new Error("Missing Permissions"));
    const res = await harness.post("/announcements/create", {
      ...ANN,
      channelId: "create:Daily News",
    });
    const html = await refused(res, "announcement-create");
    expect(html).toContain("Discord refused: Missing Permissions");
    expect(lastAudit()).toMatchObject({
      action: "announcement.create",
      result: "failure",
      details: { channelName: "Daily News" },
    });
    // The typed name comes back as the pending option.
    expect(html).toContain('value="create:Daily News" data-create');
    expect(html).toContain('value="0 9 * * 1"');
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  it("a failed create on the one-off form posts nothing", async () => {
    mockPost.mockRejectedValue(new Error("Missing Permissions"));
    const res = await harness.post("/announcements/post-once", {
      message: "Hello",
      channelId: "create:Daily News",
    });
    await refused(res, "announcement-once");
    expect(mockPostOnce).not.toHaveBeenCalled();
  });

  it("an invalid form creates no channel", async () => {
    const res = await harness.post("/announcements/create", {
      channelId: "create:Daily News",
      cron: "not a cron",
      message: "Hi",
    });
    expect(res.status).toBe(422);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockCanBotCreate).not.toHaveBeenCalled();
  });

  it.each([["create:"], ["create:   "], [`create:${"x".repeat(101)}`]])(
    "refuses the name %j under the field and creates nothing",
    async (channelId) => {
      const res = await harness.post("/announcements/create", {
        ...ANN,
        channelId,
      });
      await refused(res, "announcement-create");
      expect(mockPost).not.toHaveBeenCalled();
      expect(mockCreateAnnouncement).not.toHaveBeenCalled();
    },
  );

  it("the server checks the permission again: the bot cannot create, so nothing is created or stored", async () => {
    can = { ok: false, reason: "The bot needs Manage Channels." };
    const res = await harness.post("/announcements/create", {
      ...ANN,
      channelId: "create:Daily News",
    });
    const html = await refused(res, "announcement-create");
    expect(html).toContain("The bot needs Manage Channels.");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  it("an unreadable permission answer creates nothing", async () => {
    can = { ok: "unknown" };
    const res = await harness.post("/announcements/create", {
      ...ANN,
      channelId: "create:Daily News",
    });
    await refused(res, "announcement-create");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("a stored channel id posts as it did: no permission read, no create", async () => {
    const res = await harness.post("/announcements/create", {
      ...ANN,
      channelId: "100000000000000001",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Created announcement ann-1.",
    );
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockCanBotCreate).not.toHaveBeenCalled();
    expect(lastAudit().details.channel).toBeUndefined();
  });

  it("a name that exists is selected, not created again", async () => {
    const res = await harness.post("/announcements/create", {
      ...ANN,
      channelId: "create:General",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "Used the existing # general for Channel.",
    );
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockCreateAnnouncement.mock.calls[0][0]).toMatchObject({
      channelId: "100000000000000001",
    });
  });

  it("the same new name sent twice makes one channel", async () => {
    await harness.post("/announcements/create", {
      ...ANN,
      channelId: "create:Daily News",
    });
    live = [...live, view("100000000000000100", { name: "daily-news" })];
    const second = await harness.post("/announcements/post-once", {
      message: "Hello",
      channelId: "create:Daily  News",
    });
    expect(parseFlashRedirect(second.headers.get("location")).msg).toContain(
      "Used the existing # daily-news for Channel.",
    );
    expect(created()).toHaveLength(1);
    expect(mockPostOnce.mock.calls[0][0]).toMatchObject({
      channelId: "100000000000000100",
    });
  });

  it("a name another writer created after the first read is refused under the lock: nothing created or stored", async () => {
    let reads = 0;
    mockFetchViews.mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? live
        : [...live, view("100000000000000555", { name: "daily-news" })];
    });
    const res = await harness.post("/announcements/create", {
      ...ANN,
      channelId: "create:Daily News",
    });
    const html = await refused(res, "announcement-create");
    expect(html).toContain("changed since Review");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  it("a store that fails after the channel was created keeps it and says so", async () => {
    mockCreateAnnouncement.mockRejectedValue(new Error("cron collision"));
    const res = await harness.post("/announcements/create", {
      ...ANN,
      channelId: "create:Daily News",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("cron collision");
    expect(flash.msg).toContain("Created # daily-news for Channel.");
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe("Polls: a pending creation is created, then the schedule is stored (#1665)", () => {
  it("create: the channel exists first and the schedule holds its id", async () => {
    const res = await harness.post("/polls/schedules/create", {
      ...SCHEDULE,
      channelId: "create:Weekly Poll",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.msg).toBe(
      "Created poll schedule sch-1. Created # weekly-poll for Channel.",
    );
    expect(mockCreateSchedule.mock.calls[0][0]).toMatchObject({
      channelId: "100000000000000100",
    });
    expect(mockPost.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateSchedule.mock.invocationCallOrder[0],
    );
    expect(lastAudit().details.channel.name).toBe("weekly-poll");
  });

  it("a failed create stores no schedule and keeps the typed name", async () => {
    mockPost.mockRejectedValue(new Error("Missing Permissions"));
    const res = await harness.post("/polls/schedules/create", {
      ...SCHEDULE,
      channelId: "create:Weekly Poll",
    });
    const html = await refused(res, "poll-schedule-create");
    expect(html).toContain('value="create:Weekly Poll" data-create');
    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });

  it("edit: the schedule is updated with the new channel's id", async () => {
    const res = await harness.post("/polls/schedules/s1/edit", {
      ...SCHEDULE,
      channelId: "create:Weekly Poll",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Updated poll schedule s1. Created # weekly-poll for Channel.",
    );
    expect(mockUpdateSchedule.mock.calls[0][1]).toMatchObject({
      channelId: "100000000000000100",
    });
  });

  it("a failed create on an edit leaves the schedule as it was", async () => {
    mockPost.mockRejectedValue(new Error("Missing Permissions"));
    const res = await harness.post("/polls/schedules/s1/edit", {
      ...SCHEDULE,
      channelId: "create:Weekly Poll",
    });
    await refused(res, "poll-schedule-edit-s1");
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

  it("an edit of a schedule that is gone creates no channel", async () => {
    mockGetSchedule.mockResolvedValue(null);
    const res = await harness.post("/polls/schedules/s9/edit", {
      ...SCHEDULE,
      channelId: "create:Weekly Poll",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Schedule s9 not found.",
    );
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

  it("a failed schedule lookup creates no channel and asks to try again, keeping the form", async () => {
    mockGetSchedule.mockRejectedValue(new Error("db down"));
    const res = await harness.post("/polls/schedules/s1/edit", {
      ...SCHEDULE,
      channelId: "create:Weekly Poll",
    });
    const html = await refused(res, "poll-schedule-edit-s1");
    expect(html).toContain("Try again.");
    expect(html).toContain('value="create:Weekly Poll" data-create');
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

  it("a schedule deleted while the channel is created: the flash and audit still name the channel", async () => {
    mockUpdateSchedule.mockResolvedValue(null);
    const res = await harness.post("/polls/schedules/s1/edit", {
      ...SCHEDULE,
      channelId: "create:Weekly Poll",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.msg).toBe(
      "Schedule s1 not found. Created # weekly-poll for Channel.",
    );
    expect(lastAudit().details.channel.name).toBe("weekly-poll");
  });

  it("an existing name is refused when a writer created it after the first read", async () => {
    let reads = 0;
    mockFetchViews.mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? live
        : [...live, view("100000000000000555", { name: "weekly-poll" })];
    });
    const res = await harness.post("/polls/schedules/create", {
      ...SCHEDULE,
      channelId: "create:Weekly Poll",
    });
    const html = await refused(res, "poll-schedule-create");
    expect(html).toContain("changed since Review");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });
});

describe("no create: value reaches storage for another field (#1665)", () => {
  it("a create: value for the ping role is refused, not stored as a role id", async () => {
    const res = await harness.post("/polls/schedules/create", {
      ...SCHEDULE,
      channelId: "100000000000000001",
      pingRoleId: "create:Pollers",
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('id="poll-schedule-create-pingRoleId-error"');
    expect(mockCreateSchedule).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("the same on an edit", async () => {
    const res = await harness.post("/polls/schedules/s1/edit", {
      ...SCHEDULE,
      channelId: "100000000000000001",
      pingRoleId: "create:Pollers",
    });
    expect(res.status).toBe(422);
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

  it("a create: value in a text field is just text and creates nothing", async () => {
    await harness.post("/announcements/create", {
      ...ANN,
      message: "create:Oops",
      channelId: "100000000000000001",
    });
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockCreateAnnouncement.mock.calls[0][0]).toMatchObject({
      message: "create:Oops",
      channelId: "100000000000000001",
    });
  });
});

describe("createFormChannels: one channel per distinct name (#1665)", () => {
  it("two entries that normalise to the same name make one channel and share its id", async () => {
    const made = await createFormChannels(client, "guild-1", "u1", [
      "Daily News",
      "daily  news",
      "Other",
    ]);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(created().map((b) => b.name)).toEqual(["daily-news", "other"]);
    expect(made.channels.map((c) => c.id)).toEqual([
      "100000000000000100",
      "100000000000000100",
      "100000000000000101",
    ]);
  });

  it("reads a posted value before it is used as an id", () => {
    expect(readPostedChannel("123")).toEqual({ kind: "id", id: "123" });
    expect(readPostedChannel("create: x ")).toEqual({
      kind: "create",
      name: "x",
    });
    expect(readPostedChannel("create:")).toMatchObject({ kind: "refused" });
  });
});
