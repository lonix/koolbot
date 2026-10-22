/**
 * Route-handler tests for the Events write router (issue #849).
 *
 * `/admin/events/*` is the only admin surface for scheduling events, so its
 * validation ladder — required fields, length caps, timezone, date/time
 * parsing, "must be in the future", duration bounds — is the thing standing
 * between an operator typo and a bad row in Mongo. Every rung is driven
 * over HTTP here; only `EventService` is mocked, so the real
 * `parseEventDateTime` and timezone helpers run.
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
const mockCreateEvent = jest.fn<() => Promise<unknown>>();
const mockCreateImpromptu =
  jest.fn<(input: unknown, now?: Date) => Promise<unknown>>();
const mockCancelEvent = jest.fn<() => Promise<unknown>>();
const mockStartEventNow = jest.fn<() => Promise<unknown>>();
const mockCancelSeries = jest.fn<() => Promise<unknown>>();
const mockEndEventNow =
  jest.fn<
    (id: string, guildId: string, o: { pullBack: boolean }) => Promise<unknown>
  >();
const mockConfigGetString = jest.fn<() => Promise<string>>();
const mockConfigGetNumber = jest.fn<() => Promise<number>>();

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

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getString: mockConfigGetString,
      getNumber: mockConfigGetNumber,
      getBoolean: jest.fn(async () => true),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

// Keep the real pure helpers (`parseEventDateTime` et al.) and swap only the
// service singleton, so the date/time ladder under test is the real one.
const actualEventService = await import("../../src/services/event-service.js");
jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  ...actualEventService,
  EventService: {
    getInstance: (): unknown => ({
      createEvent: mockCreateEvent,
      createImpromptuEvent: mockCreateImpromptu,
      cancelEvent: mockCancelEvent,
      cancelSeries: mockCancelSeries,
      startEventNow: mockStartEventNow,
      endEventNow: mockEndEventNow,
    }),
  },
}));

const { createEventsRouter } =
  await import("../../src/web/routes/write/events.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();

/** A date safely in the future, in the YYYY-MM-DD / HH:MM shape the form posts. */
function futureDateTime(): { date: string; time: string } {
  const when = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return {
    date: when.toISOString().slice(0, 10),
    time: "18:30",
  };
}

let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  mockConfigGetString.mockResolvedValue("UTC");
  mockConfigGetNumber.mockResolvedValue(120);
  mockCreateEvent.mockResolvedValue({ _id: "event-1" });
  mockCreateImpromptu.mockResolvedValue({
    event: { _id: "event-1", startTime: new Date() },
    started: true,
  });
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

async function createEvent(
  body: Record<string, string | undefined>,
): Promise<ReturnType<typeof parseFlashRedirect>> {
  const res = await harness.post("/events/create", body);
  expect(res.status).toBe(303);
  return parseFlashRedirect(res.headers.get("location"));
}

describe("POST /events/create — validation", () => {
  it.each([
    ["title", { date: "2999-01-01", time: "18:00" }],
    ["date", { title: "Raid", time: "18:00" }],
    ["time", { title: "Raid", date: "2999-01-01" }],
  ])("rejects a submission missing %s", async (_field, body) => {
    const flash = await createEvent(body);
    expect(flash.path).toBe("/admin/events");
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Title, date and time are all required.");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("rejects a title over the 100-character cap", async () => {
    const { date, time } = futureDateTime();
    const flash = await createEvent({ title: "x".repeat(101), date, time });
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Title must be 100 characters or fewer.");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("rejects a description over the 1000-character cap", async () => {
    const { date, time } = futureDateTime();
    const flash = await createEvent({
      title: "Raid",
      date,
      time,
      description: "y".repeat(1001),
    });
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Description must be 1000 characters or fewer.");
  });

  it("rejects an unknown IANA timezone", async () => {
    const { date, time } = futureDateTime();
    const flash = await createEvent({
      title: "Raid",
      date,
      time,
      timezone: "Mars/Olympus_Mons",
    });
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Invalid timezone: Mars/Olympus_Mons");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("rejects an unparseable date/time", async () => {
    const flash = await createEvent({
      title: "Raid",
      date: "next tuesday",
      time: "half seven",
    });
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Use YYYY-MM-DD and 24-hour HH:MM");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("rejects a start time in the past", async () => {
    const flash = await createEvent({
      title: "Raid",
      date: "2000-01-01",
      time: "18:00",
    });
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("must be in the future");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it.each(["0", "1441", "abc", "-5"])(
    "rejects an out-of-range duration (%s)",
    async (duration) => {
      const { date, time } = futureDateTime();
      const flash = await createEvent({ title: "Raid", date, time, duration });
      expect(flash.type).toBe("err");
      expect(flash.msg).toBe("Duration must be between 1 and 1440 minutes.");
      expect(mockCreateEvent).not.toHaveBeenCalled();
    },
  );
});

describe("POST /events/create — When (#1305)", () => {
  it("Now creates and starts the event and opens its host panel", async () => {
    const flash = await createEvent({ title: "Right now", when: "now" });
    expect(flash.path).toBe("/me/events/event-1/host");
    expect(flash.type).toBe("ok");
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockCreateImpromptu.mock.calls[0][0]).toMatchObject({
      guildId: session.guildId,
      title: "Right now",
      createdBy: session.discordUserId,
    });
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event.create",
      result: "success",
      details: { via: "admin", when: "now", startedNow: true },
    });
  });

  it("Now flashes an error, keeping the host panel link, when the channels were not made", async () => {
    mockCreateImpromptu.mockResolvedValue({
      event: { _id: "event-1", startTime: new Date() },
      started: false,
    });
    const flash = await createEvent({ title: "Right now", when: "now" });
    expect(flash.path).toBe("/me/events/event-1/host");
    expect(flash.type).toBe("err");
  });

  it("Now cannot repeat: a recurrence is refused, not dropped", async () => {
    const flash = await createEvent({
      title: "Right now",
      when: "now",
      recurrence: "weekly",
    });
    expect(flash.path).toBe("/admin/events");
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("cannot repeat");
    expect(mockCreateImpromptu).not.toHaveBeenCalled();
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("In 30 min is a planned event that starts 30 minutes out", async () => {
    const before = Date.now();
    const flash = await createEvent({ title: "Soon", when: "30" });
    expect(flash.path).toBe("/admin/events");
    expect(flash.type).toBe("ok");
    const input = mockCreateEvent.mock.calls[0][0] as { startTime: Date };
    expect(input.startTime.getTime()).toBeGreaterThanOrEqual(
      before + 30 * 60_000,
    );
    expect(mockCreateImpromptu).not.toHaveBeenCalled();
  });

  it("an admin may still repeat a planned event", async () => {
    const { date, time } = futureDateTime();
    await createEvent({ title: "Weekly", date, time, recurrence: "weekly" });
    expect(mockCreateEvent.mock.calls[0][0]).toMatchObject({
      recurrence: "weekly",
    });
  });
});

describe("POST /events/create — success", () => {
  it("creates the event, attributes it to the session and audits it", async () => {
    const { date, time } = futureDateTime();
    const flash = await createEvent({
      title: "Raid night",
      description: "Bring snacks",
      date,
      time,
      duration: "90",
      timezone: "Europe/London",
    });

    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("Raid night");
    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateEvent.mock.calls[0][0]).toMatchObject({
      guildId: session.guildId,
      title: "Raid night",
      description: "Bring snacks",
      timezone: "Europe/London",
      durationMinutes: 90,
      createdBy: session.discordUserId,
    });
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event.create",
      targetId: "event-1",
      result: "success",
      details: { durationMinutes: 90 },
    });
  });

  it("falls back to the configured duration when none was posted", async () => {
    mockConfigGetNumber.mockResolvedValue(45);
    const { date, time } = futureDateTime();
    await createEvent({ title: "Raid", date, time });
    expect(mockCreateEvent.mock.calls[0][0]).toMatchObject({
      durationMinutes: 45,
    });
  });

  it("falls back to the configured timezone when none was posted", async () => {
    mockConfigGetString.mockResolvedValue("Europe/Stockholm");
    const { date, time } = futureDateTime();
    await createEvent({ title: "Raid", date, time });
    expect(mockCreateEvent.mock.calls[0][0]).toMatchObject({
      timezone: "Europe/Stockholm",
    });
  });

  it("audits a service failure and flashes the reason", async () => {
    mockCreateEvent.mockRejectedValue(new Error("duplicate key"));
    const { date, time } = futureDateTime();
    const flash = await createEvent({ title: "Raid", date, time });
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("duplicate key");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event.create",
      result: "failure",
      errorMessage: "duplicate key",
    });
  });
});

describe("recurring events", () => {
  it("creates a one-off event by default", async () => {
    const { date, time } = futureDateTime();
    await createEvent({ title: "Raid", date, time });
    expect(mockCreateEvent.mock.calls[0][0]).toMatchObject({
      recurrence: "none",
    });
  });

  it("passes a chosen cadence to the service and audit log", async () => {
    const { date, time } = futureDateTime();
    const flash = await createEvent({
      title: "Game Night",
      date,
      time,
      recurrence: "weekly",
    });
    expect(flash.type).toBe("ok");
    expect(mockCreateEvent.mock.calls[0][0]).toMatchObject({
      recurrence: "weekly",
    });
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      details: expect.objectContaining({ recurrence: "weekly" }),
    });
  });

  it("rejects an unknown cadence", async () => {
    const { date, time } = futureDateTime();
    const flash = await createEvent({
      title: "Game Night",
      date,
      time,
      recurrence: "daily",
    });
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Invalid recurrence: daily");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("cancels the whole series when scope=series", async () => {
    mockCancelSeries.mockResolvedValue({
      event: { _id: "event-1" },
      cancelled: 2,
    });
    const res = await harness.post("/events/event-1/cancel", {
      scope: "series",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(mockCancelSeries).toHaveBeenCalledWith("event-1", session.guildId);
    expect(mockCancelEvent).not.toHaveBeenCalled();
    expect(flash.type).toBe("ok");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event.cancel-series",
      result: "success",
    });
  });

  it("reports a series cancel that matched nothing", async () => {
    mockCancelSeries.mockResolvedValue(null);
    const res = await harness.post("/events/missing/cancel", {
      scope: "series",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
  });
});

describe("POST /events/:id/cancel and /start-now", () => {
  it("cancels an event scoped to the session's guild", async () => {
    mockCancelEvent.mockResolvedValue({ _id: "event-1", state: "cancelled" });
    const res = await harness.post("/events/event-1/cancel");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(mockCancelEvent).toHaveBeenCalledWith("event-1", session.guildId);
    expect(flash.type).toBe("ok");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event.cancel",
      targetId: "event-1",
      result: "success",
    });
  });

  it("does not report success for an event that ended meanwhile (a lost cancel claim)", async () => {
    mockCancelEvent.mockResolvedValue({ _id: "event-1", state: "ended" });
    const res = await harness.post("/events/event-1/cancel");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("could not be cancelled");
    expect(flash.msg).toContain("ended");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event.cancel",
      result: "failure",
      errorMessage: "event is ended",
    });
  });

  it("a series cancel that cancelled nothing of a one-off event is a failure", async () => {
    mockCancelSeries.mockResolvedValue({
      event: { _id: "event-1", state: "ended" },
      cancelled: 0,
    });
    const res = await harness.post("/events/event-1/cancel", {
      scope: "series",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event.cancel-series",
      result: "failure",
    });
  });

  it("reports (and audits) a cancel that matched nothing", async () => {
    mockCancelEvent.mockResolvedValue(null);
    const res = await harness.post("/events/missing/cancel");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("not found");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      result: "failure",
      errorMessage: "not found or wrong guild",
    });
  });

  it("starts an event now", async () => {
    mockStartEventNow.mockResolvedValue({ _id: "event-1" });
    const res = await harness.post("/events/event-1/start-now");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(mockStartEventNow).toHaveBeenCalledWith("event-1", session.guildId);
    expect(flash.type).toBe("ok");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event.start-now",
      result: "success",
    });
  });

  it("reports an event that could not be started", async () => {
    mockStartEventNow.mockResolvedValue(null);
    const res = await harness.post("/events/event-1/start-now");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("not found, ended, or cancelled");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      result: "failure",
    });
  });
});

describe("POST /events/:id/end-now (#1193)", () => {
  const ended = {
    status: "ended",
    endedAt: new Date(),
    event: {},
    steps: [
      {
        id: "group-channels",
        ok: true,
        note: "Removed 2 group channel(s).",
        counts: { removed: 2 },
      },
    ],
  };

  it("does nothing without the confirmation, and audits the refusal", async () => {
    const res = await harness.post("/events/event-1/end-now", {
      pullBack: "1",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Tick the box");
    expect(mockEndEventNow).not.toHaveBeenCalled();
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event.end-now",
      targetId: "event-1",
      result: "failure",
      errorMessage: "not confirmed",
    });
  });

  it("only the exact value 1 confirms", async () => {
    for (const confirm of ["on", "true", "0", "yes"]) {
      await harness.post("/events/event-1/end-now", { confirm });
    }
    expect(mockEndEventNow).not.toHaveBeenCalled();
  });

  it("ends the event for the session's guild with the shared teardown, and audits counts", async () => {
    mockEndEventNow.mockResolvedValue(ended);
    const res = await harness.post("/events/event-1/end-now", {
      confirm: "1",
      pullBack: "1",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(mockEndEventNow).toHaveBeenCalledWith("event-1", session.guildId, {
      pullBack: true,
    });
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("The event has ended.");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event.end-now",
      targetId: "event-1",
      result: "success",
      details: { outcome: "ended", pullBack: true, removed: 2 },
    });
  });

  it("the pull-back is off unless the box was ticked", async () => {
    mockEndEventNow.mockResolvedValue(ended);
    await harness.post("/events/event-1/end-now", { confirm: "1" });
    expect(mockEndEventNow).toHaveBeenCalledWith("event-1", session.guildId, {
      pullBack: false,
    });
  });

  it("an already ended event is a success with a clear message", async () => {
    mockEndEventNow.mockResolvedValue({
      status: "already-ended",
      endedAt: null,
    });
    const res = await harness.post("/events/event-1/end-now", {
      confirm: "1",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("already ended");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      result: "success",
    });
  });

  it.each([
    [{ status: "not-found" }, "could not be found"],
    [{ status: "not-running", state: "scheduled" }, "has not started"],
    [{ status: "refused", message: "Events are turned off." }, "turned off"],
  ])("reports and audits %j as a failure", async (outcome, text) => {
    mockEndEventNow.mockResolvedValue(outcome);
    const res = await harness.post("/events/event-1/end-now", {
      confirm: "1",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain(text);
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      result: "failure",
    });
  });
});
