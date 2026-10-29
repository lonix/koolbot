/**
 * GET /admin/events (#1193): the End now confirmation for an adopted Discord
 * event says KoolBot lets go of it, for any other it says it is closed. The row
 * flag comes from the stored event, so this goes through the real route.
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
  type AdminHarness,
} from "./admin-harness.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => false),
      getString: jest.fn(async () => ""),
      getNumber: jest.fn(async () => 0),
      getAll: jest.fn(async () => []),
      get: jest.fn(async () => null),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

const { EventService } = await import("../../src/services/event-service.js");
const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");

const client = {
  user: { id: "bot" },
  guilds: {
    cache: new Map(),
    fetch: jest.fn(async () => {
      throw new Error("discord down");
    }),
  },
  commands: new Map(),
} as unknown as Client;

let harness: AdminHarness;

function stored(id: string, extra: Record<string, unknown>): unknown {
  return {
    _id: id,
    guildId: "guild-1",
    title: `Event ${id}`,
    startTime: new Date("2026-07-04T20:00:00Z"),
    durationMinutes: 60,
    state: "active",
    recurrence: "none",
    rsvps: [],
    ...extra,
  };
}

beforeEach(async () => {
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(createTestSession())),
  ]);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await harness.close();
});

describe("GET /events: End now text", () => {
  it("tells an adopted event apart from one KoolBot made", async () => {
    jest.spyOn(EventService, "getInstance").mockReturnValue({
      listEvents: jest.fn(async () => [
        stored("own-1", { nativeEventId: "n1" }),
        stored("adopted-1", { nativeEventId: "n2", nativeAdopted: true }),
      ]),
    } as never);
    const html = await (await harness.get("/events")).text();
    const forms = html.match(/<form[^>]*end-event-form[\s\S]*?<\/form>/g) ?? [];
    expect(forms).toHaveLength(2);
    const own = forms.find((f) => f.includes("/events/own-1/end-now")) ?? "";
    const adopted =
      forms.find((f) => f.includes("/events/adopted-1/end-now")) ?? "";
    expect(own).toContain("the Discord event is closed");
    expect(adopted).toContain("the Discord event is left as it is");
    expect(adopted).not.toContain("Discord event is closed");
  });
});

describe("GET /events: Live now and Upcoming (#1525)", () => {
  it("splits on isEventRunning: an active event whose start is ahead stays upcoming", async () => {
    const past = new Date(Date.now() - 10 * 60_000);
    const ahead = new Date(Date.now() + 10 * 60_000);
    jest.spyOn(EventService, "getInstance").mockReturnValue({
      listEvents: jest.fn(async () => [
        stored("started", { startTime: past }),
        stored("prepared-early", { startTime: ahead }),
        stored("planned", { state: "scheduled", startTime: ahead }),
      ]),
    } as never);
    const html = await (await harness.get("/events")).text();
    const section = (id: string): string =>
      html.match(
        new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`),
      )?.[0] ?? "";
    const live = section("live-events");
    const upcoming = section("upcoming-events");
    expect(live).toContain("Event started");
    expect(live).not.toContain("Event prepared-early");
    expect(upcoming).toContain("Event prepared-early");
    expect(upcoming).toContain("Event planned");
    expect(upcoming).not.toContain("Event started");
  });
});
