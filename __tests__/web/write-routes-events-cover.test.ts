/**
 * Cover image routes of the Events write router (#1181).
 *
 * The upload is the raw file body (no multipart parser exists), so these
 * drive real HTTP through the real session-bound middleware chain used by
 * `createWriteRouter` (admin role, CSRF), the real raw-body parser and the real
 * validation in `services/event-cover.ts`. Only the Mongo models and the
 * `EventService` singleton are mocked.
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
  TEST_CSRF_TOKEN,
  type AdminHarness,
} from "./admin-harness.js";

const mockRecordAudit = jest.fn<(...a: unknown[]) => Promise<unknown>>(
  async () => undefined,
);
const mockGetEvent = jest.fn<(id: string) => Promise<unknown>>();
const imageUpsert = jest.fn<(...a: unknown[]) => Promise<unknown>>(
  async () => ({}),
);
const imageDelete = jest.fn<(...a: unknown[]) => Promise<unknown>>(
  async () => ({}),
);
const eventUpdateMany = jest.fn<(...a: unknown[]) => Promise<unknown>>(
  async () => ({}),
);

jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: (): unknown => ({}) },
}));
jest.unstable_mockModule("../../src/models/event-image.js", () => ({
  EventImage: {
    findOneAndUpdate: imageUpsert,
    deleteOne: imageDelete,
  },
}));
jest.unstable_mockModule("../../src/models/event.js", () => ({
  EVENT_RECURRENCES: ["none", "weekly", "biweekly", "monthly"],
  Event: { updateMany: eventUpdateMany },
}));

const actualEventService = await import("../../src/services/event-service.js");
jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  ...actualEventService,
  EventService: {
    getInstance: (): unknown => ({ getEvent: mockGetEvent }),
  },
}));

const { createEventsRouter } =
  await import("../../src/web/routes/write/events.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");
const { COVER_MAX_BYTES } = await import("../../src/services/event-cover.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

function row(overrides: Record<string, unknown> = {}): unknown {
  return {
    _id: "ev1",
    guildId: "guild-1",
    state: "scheduled",
    recurrence: "none",
    seriesId: null,
    nextSpawned: false,
    seriesCancelled: false,
    nativeAdopted: false,
    nativeCleanupOnly: false,
    ...overrides,
  };
}

let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  mockGetEvent.mockResolvedValue(row());
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createEventsRouter(client),
  ]);
});

afterEach(async () => {
  await harness.close();
});

/** What the page script sends: raw bytes, CSRF in a header, JSON reply. */
async function upload(
  body: Buffer | string,
  opts: {
    id?: string;
    contentType?: string;
    csrfHeader?: string | null;
  } = {},
): Promise<{ status: number; json: Record<string, string> }> {
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/octet-stream",
    accept: "application/json",
    cookie: `koolbot_csrf=${encodeURIComponent(TEST_CSRF_TOKEN)}`,
  };
  if (opts.csrfHeader !== null) {
    headers["x-csrf-token"] = opts.csrfHeader ?? TEST_CSRF_TOKEN;
  }
  const res = await fetch(
    `${harness.baseUrl}/admin/events/${opts.id ?? "ev1"}/cover`,
    { method: "POST", headers, body },
  );
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, string>,
  };
}

describe("POST /events/:id/cover", () => {
  it("stores a valid PNG, points the rows at its hash and audits it", async () => {
    const res = await upload(PNG);
    expect(res.status).toBe(200);
    expect(res.json.type).toBe("ok");
    expect(res.json.reload).toContain("/admin/events?");
    expect(imageUpsert).toHaveBeenCalledTimes(1);
    const set = (
      imageUpsert.mock.calls[0][1] as { $set: Record<string, unknown> }
    ).$set;
    expect(set.mime).toBe("image/png");
    expect(set.bytes).toBe(PNG.length);
    expect(eventUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "ev1", nativeAdopted: { $ne: true } }),
      [
        {
          $set: {
            coverHash: { $literal: set.hash },
            // A row with failed sends forgets what it last sent.
            nativeCoverHash: {
              $cond: [
                { $gt: ["$nativeCoverAttempts", 0] },
                null,
                "$nativeCoverHash",
              ],
            },
            nativeCoverAttempts: 0,
          },
        },
      ],
      // Mongoose 9 rejects a pipeline update without this option (#1103).
      { updatePipeline: true },
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ action: "event.cover-set", result: "success" }),
    );
  });

  it("applies to the whole series for a recurring event", async () => {
    mockGetEvent.mockResolvedValue(
      row({ recurrence: "weekly", seriesId: "series-1" }),
    );
    const res = await upload(PNG);
    expect(res.json.type).toBe("ok");
    expect(res.json.text).toContain("whole series");
    expect(imageUpsert.mock.calls[0][0]).toEqual({
      guildId: "guild-1",
      key: "series-1",
    });
    expect(eventUpdateMany.mock.calls[0][0]).toEqual(
      expect.objectContaining({ seriesId: "series-1" }),
    );
  });

  it("rejects HTML sent with an image content type: the signature decides", async () => {
    const res = await upload("<html><script>alert(1)</script></html>", {
      contentType: "application/octet-stream",
    });
    expect(res.json.type).toBe("err");
    expect(res.json.text).toContain("not a PNG, JPEG or GIF");
    expect(imageUpsert).not.toHaveBeenCalled();
    expect(eventUpdateMany).not.toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ result: "failure" }),
    );
  });

  it("rejects a body over the size cap with a clear message", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(COVER_MAX_BYTES, 2)]);
    const res = await upload(big);
    expect(res.json.type).toBe("err");
    expect(res.json.text).toContain("too large");
    expect(res.json.text).toContain("2 MB");
    expect(imageUpsert).not.toHaveBeenCalled();
  });

  it("rejects an empty body and a body sent with another content type", async () => {
    expect((await upload(Buffer.alloc(0))).json.type).toBe("err");
    const other = await upload(PNG, { contentType: "image/png" });
    expect(other.json.type).toBe("err");
    expect(imageUpsert).not.toHaveBeenCalled();
  });

  it("refuses an adopted event: its Discord cover is never touched", async () => {
    mockGetEvent.mockResolvedValue(row({ nativeAdopted: true }));
    const res = await upload(PNG);
    expect(res.json.type).toBe("err");
    expect(res.json.text).toContain("adopted");
    expect(imageUpsert).not.toHaveBeenCalled();
    expect(eventUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a detached one-off but accepts a detached recurring series", async () => {
    mockGetEvent.mockResolvedValue(row({ nativeDetached: true }));
    const refused = await upload(PNG);
    expect(refused.json.type).toBe("err");
    expect(refused.json.text).toContain("deleted from Discord");
    expect(imageUpsert).not.toHaveBeenCalled();
    mockGetEvent.mockResolvedValue(
      row({ nativeDetached: true, recurrence: "weekly", seriesId: "s1" }),
    );
    expect((await upload(PNG)).json.type).toBe("ok");
  });

  it("refuses a finished event and an event of another guild", async () => {
    mockGetEvent.mockResolvedValue(row({ state: "ended" }));
    expect((await upload(PNG)).json.type).toBe("err");
    mockGetEvent.mockResolvedValue(row({ guildId: "other-guild" }));
    const res = await upload(PNG);
    expect(res.json.text).toContain("not found");
    mockGetEvent.mockResolvedValue(null);
    expect((await upload(PNG)).json.text).toContain("not found");
    expect(imageUpsert).not.toHaveBeenCalled();
  });

  it("refuses a request without the CSRF header before reading the body", async () => {
    const res = await upload(PNG, { csrfHeader: null });
    expect(res.status).toBe(403);
    expect(imageUpsert).not.toHaveBeenCalled();
  });

  it("refuses a wrong CSRF header", async () => {
    const res = await upload(PNG, { csrfHeader: "not-the-token" });
    expect(res.status).toBe(403);
    expect(imageUpsert).not.toHaveBeenCalled();
  });
});

describe("POST /events/:id/cover/remove", () => {
  it("detaches the rows, deletes the image and audits", async () => {
    const res = await harness.post("/events/ev1/cover/remove");
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(eventUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "ev1" }),
      [
        {
          $set: {
            coverHash: null,
            // Rows with failed sends keep one attempt so a clear is still sent.
            nativeCoverAttempts: {
              $cond: [{ $gt: ["$nativeCoverAttempts", 0] }, 1, 0],
            },
          },
        },
      ],
      { updatePipeline: true },
    );
    expect(imageDelete).toHaveBeenCalledWith({
      guildId: "guild-1",
      key: "ev1",
    });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ action: "event.cover-remove" }),
    );
  });

  it("refuses an adopted event", async () => {
    mockGetEvent.mockResolvedValue(row({ nativeAdopted: true }));
    const res = await harness.post("/events/ev1/cover/remove");
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(imageDelete).not.toHaveBeenCalled();
    expect(eventUpdateMany).not.toHaveBeenCalled();
  });

  it("answers not found for an unknown event", async () => {
    mockGetEvent.mockResolvedValue(null);
    const res = await harness.post("/events/nope/cover/remove");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("not found");
  });
});
