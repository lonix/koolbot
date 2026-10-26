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
import { JSDOM } from "jsdom";
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
const { registerFormPage } = await import("../../src/web/form-pages.js");
const { renderAnnouncementsPage } =
  await import("../../src/web/admin-views.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

const VALID = {
  channelId: "channel-9",
  cron: "0 9 * * 1",
  message: "Standup in 5",
};

// The read router registers the page's renderer in the app (#1517); here the
// real view stands in, so a refusal is checked as the markup the person gets.
const registerPage = (): void =>
  registerFormPage("/admin/announcements", async (_req, refused) =>
    renderAnnouncementsPage({
      guildId: "guild-1",
      csrfToken: "csrf",
      remainingMs: 1000,
      navFeatureStatus: {},
      enabled: true,
      rows: [],
      textChannels: [
        { id: "channel-9", name: "general", type: 0 },
        { id: "channel-3", name: "random", type: 0 },
      ],
      settingRows: [],
      refusedForm: refused,
    }),
  );

/** A refused form: 422 with the page, the first marked field and the error line of each field. */
async function refusal(res: Response): Promise<{
  html: string;
  invalidIds: string[];
  errorLines: Record<string, string>;
}> {
  expect(res.status).toBe(422);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  const invalidIds = [...html.matchAll(/<[^>]*aria-invalid="true"[^>]*>/g)].map(
    (m) => /id="([^"]+)"/.exec(m[0])?.[1] ?? "",
  );
  const errorLines: Record<string, string> = {};
  for (const m of html.matchAll(
    /<p class="kb-field__error" id="([^"]+)">([^<]*)<\/p>/g,
  )) {
    errorLines[m[1]] = m[2];
  }
  return { html, invalidIds, errorLines };
}

beforeEach(async () => {
  jest.clearAllMocks();
  registerPage();
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
    [
      "channel",
      { cron: "0 9 * * 1", message: "hi" },
      "announcement-create-channelId",
      "Pick a channel.",
    ],
    [
      "cron",
      { channelId: "c", message: "hi" },
      "announcement-create-cron",
      "Enter a cron expression, for example 0 9 * * *.",
    ],
    [
      "message",
      { channelId: "c", cron: "0 9 * * 1" },
      "announcement-create-message",
      "Enter the message to post.",
    ],
  ])(
    "refuses a submission missing the %s and marks that field",
    async (_field, body, id, message) => {
      const res = await harness.post("/announcements/create", body);
      const r = await refusal(res);
      expect(r.invalidIds).toEqual([id]);
      expect(r.errorLines[`${id}-error`]).toBe(message);
      expect(mockCreateAnnouncement).not.toHaveBeenCalled();
    },
  );

  it("marks an invalid cron expression and keeps every typed value", async () => {
    const res = await harness.post("/announcements/create", {
      channelId: "channel-3",
      cron: "every monday please",
      message: "Standup <b>now</b> & later",
      placeholders: "1",
      embedTitle: "Notice",
      embedDescription: "Details",
      embedColor: "#112233",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["announcement-create-cron"]);
    expect(r.errorLines["announcement-create-cron-error"]).toBe(
      "Not a valid cron expression. Use five fields (minute hour day-of-month month day-of-week), for example 0 9 * * *.",
    );
    // Typed text comes back, escaped, in the form that was refused.
    expect(r.html).toContain('value="every monday please"');
    expect(r.html).toContain("Standup &lt;b&gt;now&lt;/b&gt; &amp; later");
    expect(r.html).not.toContain("Standup <b>now</b>");
    expect(r.html).toContain('value="Notice"');
    expect(r.html).toContain('value="#112233"');
    expect(r.html).toContain('<option value="channel-3" selected>');
    expect(r.html).toMatch(/name="placeholders" value="1" checked/);
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  it("echoes the message and embed text exactly as typed, not trimmed", async () => {
    const res = await harness.post("/announcements/create", {
      channelId: "channel-9",
      cron: "nope",
      message: "\n  indented line\n\n",
      embedDescription: "  spaced  ",
    });
    const r = await refusal(res);
    // What the browser puts back in the boxes, after HTML parsing.
    const doc = new JSDOM(r.html).window.document;
    const box = (name: string): string =>
      (
        doc.querySelector(
          `form[action$="/announcements/create"] [name=${name}]`,
        ) as unknown as { value: string }
      ).value;
    expect(box("message")).toBe("\n  indented line\n\n");
    expect(box("embedDescription")).toBe("  spaced  ");
  });

  it("marks every refused field at once, in page order", async () => {
    const res = await harness.post("/announcements/create", {
      channelId: "channel-9",
      cron: "nope",
      message: "m".repeat(2001),
      embedTitle: "t".repeat(257),
      embedColor: "blurple",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual([
      "announcement-create-cron",
      "announcement-create-message",
      "announcement-create-embedTitle",
      "announcement-create-embedColor",
    ]);
    expect(r.errorLines["announcement-create-message-error"]).toBe(
      "At most 2000 characters.",
    );
    expect(r.errorLines["announcement-create-embedTitle-error"]).toBe(
      "At most 256 characters.",
    );
    expect(r.errorLines["announcement-create-embedColor-error"]).toBe(
      "Use six hex digits, for example #5865F2.",
    );
    // The one-off form on the same page is not marked.
    expect(r.html).not.toContain("announcement-once-message-error");
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

  it("refuses an embed description past the 4000-character cap", async () => {
    const res = await harness.post("/announcements/create", {
      ...VALID,
      embedDescription: "d".repeat(4001),
    });
    const r = await refusal(res);
    expect(r.errorLines["announcement-create-embedDescription-error"]).toBe(
      "At most 4000 characters.",
    );
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  it("falls back to a flash redirect when the page has no renderer", async () => {
    registerFormPage("/admin/announcements", async () => {
      throw new Error("render failed");
    });
    const res = await harness.post("/announcements/create", {
      ...VALID,
      message: "",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(res.status).toBe(303);
    expect(flash.path).toBe("/admin/announcements");
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Not saved. Enter the message to post.");
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
  it("refuses a missing channel and keeps the typed message", async () => {
    const res = await harness.post("/announcements/post-once", {
      message: "hi <there>",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["announcement-once-channelId"]);
    expect(r.html).toContain("hi &lt;there&gt;");
    expect(mockPostOnce).not.toHaveBeenCalled();
  });

  it("echoes the one-off message exactly as typed", async () => {
    const res = await harness.post("/announcements/post-once", {
      message: "  keep me  ",
    });
    const r = await refusal(res);
    const doc = new JSDOM(r.html).window.document;
    expect(
      (
        doc.querySelector(
          'form[action$="/announcements/post-once"] [name=message]',
        ) as unknown as { value: string }
      ).value,
    ).toBe("  keep me  ");
  });

  it("applies the same length caps as the scheduled create", async () => {
    const res = await harness.post("/announcements/post-once", {
      channelId: "c",
      message: "m".repeat(2001),
    });
    const r = await refusal(res);
    expect(r.errorLines["announcement-once-message-error"]).toBe(
      "At most 2000 characters.",
    );
    expect(r.invalidIds).toEqual(["announcement-once-message"]);
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
