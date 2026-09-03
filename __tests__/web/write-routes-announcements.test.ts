/**
 * Route-handler tests for the Announcements write router (issue #849).
 *
 * `scheduled-announcement-service.ts` sat at ~12% and its router at ~7%, so
 * the cron validation, the Discord length caps (#508), the hex-colour parse
 * and the guild scoping on every by-id action were all unverified — and this
 * is the surface that posts to a public channel on a schedule.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { Client } from "discord.js";
import {
  startAdminHarness,
  stubRequireSession,
  createTestSession,
  parseFlashRedirect,
  type AdminHarness,
} from "./admin-harness.js";

const mockRecordAudit = jest.fn(async () => undefined);
const mockCreateAnnouncement = jest.fn<() => Promise<{ _id: string }>>();
const mockDeleteAnnouncement = jest.fn<() => Promise<boolean>>();
const mockGetAnnouncement = jest.fn<() => Promise<unknown>>();
const mockSetAnnouncementEnabled = jest.fn<() => Promise<unknown>>();
const mockPostAnnouncementNow = jest.fn<() => Promise<boolean>>();
const mockPostOnce = jest.fn<() => Promise<void>>();
const mockMakeAnnouncement = jest.fn<() => Promise<void>>();

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
}));

jest.unstable_mockModule(
  "../../src/services/scheduled-announcement-service.js",
  () => ({
    ScheduledAnnouncementService: {
      getInstance: (): unknown => ({
        createAnnouncement: mockCreateAnnouncement,
        deleteAnnouncement: mockDeleteAnnouncement,
        getAnnouncement: mockGetAnnouncement,
        setAnnouncementEnabled: mockSetAnnouncementEnabled,
        postAnnouncementNow: mockPostAnnouncementNow,
        postOnce: mockPostOnce,
      }),
    },
  }),
);

jest.unstable_mockModule(
  "../../src/services/voice-channel-announcer.js",
  () => ({
    VoiceChannelAnnouncer: {
      getInstance: (): unknown => ({ makeAnnouncement: mockMakeAnnouncement }),
    },
  }),
);

const { createAnnouncementsRouter } =
  await import("../../src/web/routes/write/announcements.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

const VALID = {
  channelId: "channel-9",
  cron: "0 9 * * 1",
  message: "Standup in 5",
};

beforeEach(async () => {
  jest.clearAllMocks();
  mockCreateAnnouncement.mockResolvedValue({ _id: "ann-1" });
  mockDeleteAnnouncement.mockResolvedValue(true);
  mockPostAnnouncementNow.mockResolvedValue(true);
  mockPostOnce.mockResolvedValue(undefined);
  mockMakeAnnouncement.mockResolvedValue(undefined);
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createAnnouncementsRouter(client),
  ]);
});

afterEach(async () => {
  await harness.close();
});

function lastAudit(): Record<string, unknown> {
  const calls = mockRecordAudit.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

describe("POST /announcements/create", () => {
  it.each([
    ["channel", { cron: "0 9 * * 1", message: "hi" }],
    ["cron", { channelId: "c", message: "hi" }],
    ["message", { channelId: "c", cron: "0 9 * * 1" }],
  ])("rejects a submission missing the %s", async (_field, body) => {
    const res = await harness.post("/announcements/create", body);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/announcements");
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Channel, cron and message are all required.");
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  it("rejects an invalid cron expression", async () => {
    const res = await harness.post("/announcements/create", {
      ...VALID,
      cron: "every monday please",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.msg).toContain("Invalid cron expression");
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  it("strips wrapping quotes so validation and storage agree", async () => {
    await harness.post("/announcements/create", {
      ...VALID,
      cron: '"0 9 * * 1"',
    });
    expect(mockCreateAnnouncement.mock.calls[0][0]).toMatchObject({
      cronSchedule: "0 9 * * 1",
    });
  });

  it("rejects a message past the Discord 2000-character cap", async () => {
    const res = await harness.post("/announcements/create", {
      ...VALID,
      message: "m".repeat(2001),
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Message must be 2000 characters or fewer.",
    );
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  it("rejects an embed description past the 4000-character cap", async () => {
    const res = await harness.post("/announcements/create", {
      ...VALID,
      embedDescription: "d".repeat(4001),
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Embed description must be 4000 characters or fewer.",
    );
  });

  it("rejects a malformed hex colour", async () => {
    const res = await harness.post("/announcements/create", {
      ...VALID,
      embedTitle: "Notice",
      embedColor: "blurple",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "Invalid hex colour: blurple",
    );
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  it("creates a plain announcement scoped to the session's guild", async () => {
    const res = await harness.post("/announcements/create", VALID);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Created announcement ann-1.");
    expect(mockCreateAnnouncement.mock.calls[0][0]).toMatchObject({
      guildId: session.guildId,
      channelId: "channel-9",
      cronSchedule: "0 9 * * 1",
      message: "Standup in 5",
      placeholders: false,
      enabled: true,
      createdBy: session.discordUserId,
      embedData: undefined,
    });
    expect(lastAudit()).toMatchObject({
      action: "announcement.create",
      targetId: "ann-1",
      result: "success",
      details: { hasEmbed: false, placeholders: false },
    });
  });

  it("builds embed data from a #-prefixed or bare hex colour", async () => {
    await harness.post("/announcements/create", {
      ...VALID,
      placeholders: "on",
      embedTitle: "Notice",
      embedDescription: "Body",
      embedColor: "#ff8800",
    });
    expect(mockCreateAnnouncement.mock.calls[0][0]).toMatchObject({
      placeholders: true,
      embedData: {
        title: "Notice",
        description: "Body",
        color: 0xff8800,
      },
    });
    expect(lastAudit()).toMatchObject({ details: { hasEmbed: true } });
  });

  it("audits a service failure and flashes the reason", async () => {
    mockCreateAnnouncement.mockRejectedValue(new Error("cron collision"));
    const res = await harness.post("/announcements/create", VALID);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("cron collision");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });
});

describe("POST /announcements/:id/{delete,toggle,post-now}", () => {
  it("deletes an announcement in the session's guild", async () => {
    const res = await harness.post("/announcements/ann-1/delete");
    expect(mockDeleteAnnouncement).toHaveBeenCalledWith(
      "ann-1",
      session.guildId,
    );
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "announcement.delete",
      result: "success",
    });
  });

  it("reports a delete that matched nothing in this guild", async () => {
    mockDeleteAnnouncement.mockResolvedValue(false);
    const res = await harness.post("/announcements/ann-1/delete");
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(lastAudit()).toMatchObject({
      errorMessage: "not found or wrong guild",
    });
  });

  it("refuses to toggle an announcement belonging to another guild", async () => {
    mockGetAnnouncement.mockResolvedValue({
      _id: "ann-1",
      guildId: "some-other-guild",
      enabled: true,
    });
    const res = await harness.post("/announcements/ann-1/toggle");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(mockSetAnnouncementEnabled).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "announcement.toggle",
      errorMessage: "not found or wrong guild",
    });
  });

  it("flips the enabled flag to the opposite of the stored value", async () => {
    mockGetAnnouncement.mockResolvedValue({
      _id: "ann-1",
      guildId: session.guildId,
      enabled: false,
    });
    mockSetAnnouncementEnabled.mockResolvedValue({ _id: "ann-1" });
    const res = await harness.post("/announcements/ann-1/toggle");
    expect(mockSetAnnouncementEnabled).toHaveBeenCalledWith(
      "ann-1",
      true,
      session.guildId,
    );
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("enabled");
    expect(lastAudit()).toMatchObject({ details: { enabled: true } });
  });

  it("posts an announcement immediately", async () => {
    const res = await harness.post("/announcements/ann-1/post-now");
    expect(mockPostAnnouncementNow).toHaveBeenCalledWith(
      "ann-1",
      session.guildId,
    );
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
  });

  it("turns a thrown post into a flash rather than a 500", async () => {
    mockPostAnnouncementNow.mockRejectedValue(new Error("Missing Permissions"));
    const res = await harness.post("/announcements/ann-1/post-now");
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Missing Permissions");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });
});

describe("POST /announcements/post-once and /post-vc-stats", () => {
  it("requires a channel and a message", async () => {
    const res = await harness.post("/announcements/post-once", {
      message: "hi",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Channel and message are both required.",
    );
    expect(mockPostOnce).not.toHaveBeenCalled();
  });

  it("applies the same length caps as the scheduled create", async () => {
    const res = await harness.post("/announcements/post-once", {
      channelId: "c",
      message: "m".repeat(2001),
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Message must be 2000 characters or fewer.",
    );
  });

  it("posts a one-off message with its embed", async () => {
    const res = await harness.post("/announcements/post-once", {
      channelId: "channel-9",
      message: "Hello",
      embedTitle: "Notice",
    });
    expect(mockPostOnce).toHaveBeenCalledWith({
      guildId: session.guildId,
      channelId: "channel-9",
      message: "Hello",
      placeholders: false,
      embedData: { title: "Notice", description: undefined, color: undefined },
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "announcement.post-once",
      result: "success",
    });
  });

  it("triggers the weekly VC stats announcement", async () => {
    const res = await harness.post("/announcements/post-vc-stats");
    expect(mockMakeAnnouncement).toHaveBeenCalled();
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "announcement.post-vc-stats",
      result: "success",
    });
  });

  it("audits a failed VC stats announcement", async () => {
    mockMakeAnnouncement.mockRejectedValue(new Error("no channel configured"));
    const res = await harness.post("/announcements/post-vc-stats");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("no channel configured");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });
});
