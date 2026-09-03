/**
 * `execute()` tests for `/event` and the RSVP button handler (issue #849).
 *
 * `src/commands/event.ts` had no test file at all (0% → the issue's flat
 * zero) and `src/handlers/event-rsvp-handler.ts` was likewise untouched.
 * Both are member-facing: `/event list` is open to everyone while
 * create/cancel/start are Administrator-only at runtime (the command
 * deliberately sets no default member permission so `list` stays visible),
 * and the RSVP buttons are clicked by anyone in the guild.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { MessageFlags } from "discord.js";
import {
  createMockChatInputInteraction,
  createMockButtonInteraction,
  createRawMember,
  type MockChatInputInteraction,
  type MockCommandOptions,
} from "../test-utils.js";

const mockConfigGetBoolean = jest.fn<() => Promise<boolean>>();
const mockConfigGetString = jest.fn<() => Promise<string>>();
const mockConfigGetNumber = jest.fn<() => Promise<number>>();
const mockCreateEvent = jest.fn<() => Promise<unknown>>();
const mockListEvents = jest.fn<() => Promise<Array<Record<string, unknown>>>>();
const mockCancelEvent = jest.fn<() => Promise<unknown>>();
const mockStartEventNow = jest.fn<() => Promise<unknown>>();
const mockSetRsvp = jest.fn<() => Promise<unknown>>();
const mockBuildAnnouncementPayload = jest.fn(() => ({ content: "refreshed" }));

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: mockConfigGetBoolean,
      getString: mockConfigGetString,
      getNumber: mockConfigGetNumber,
      registerReloadCallback: jest.fn(),
    }),
  },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Keep the real pure helpers (`parseEventDateTime`, `formatEventWhen`,
// `countRsvps`) and swap only the service singleton.
const actualEventService = await import("../../src/services/event-service.js");
jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  ...actualEventService,
  EventService: {
    getInstance: (): unknown => ({
      createEvent: mockCreateEvent,
      listEvents: mockListEvents,
      cancelEvent: mockCancelEvent,
      startEventNow: mockStartEventNow,
      setRsvp: mockSetRsvp,
      buildAnnouncementPayload: mockBuildAnnouncementPayload,
    }),
  },
}));

const { execute } = await import("../../src/commands/event.js");
const { handleEventRsvpButton } =
  await import("../../src/handlers/event-rsvp-handler.js");

function futureDateTime(): { date: string; time: string } {
  const when = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return { date: when.toISOString().slice(0, 10), time: "18:30" };
}

function interaction(
  options: MockCommandOptions,
  overrides: Record<string, unknown> = {},
): MockChatInputInteraction {
  return createMockChatInputInteraction(options, {
    member: createRawMember(true),
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigGetBoolean.mockResolvedValue(true);
  mockConfigGetString.mockResolvedValue("UTC");
  mockConfigGetNumber.mockResolvedValue(120);
  mockCreateEvent.mockResolvedValue({
    _id: "event-1",
    title: "Raid",
    startTime: new Date(Date.now() + 86_400_000),
    timezone: "UTC",
  });
  mockListEvents.mockResolvedValue([]);
});

describe("/event feature gating", () => {
  it("declines every subcommand while events.enabled is false", async () => {
    mockConfigGetBoolean.mockResolvedValue(false);
    const it_ = interaction({ subcommand: "list" });
    await execute(it_);
    const reply = it_.reply.mock.calls[0][0] as { content: string };
    expect(reply.content).toBe("The events feature is currently disabled.");
    expect(mockListEvents).not.toHaveBeenCalled();
  });

  it("declines when run outside a guild", async () => {
    const it_ = interaction({ subcommand: "list" }, { guildId: null });
    await execute(it_);
    const reply = it_.reply.mock.calls[0][0] as { content: string };
    expect(reply.content).toContain("inside a guild");
  });

  it.each(["create", "cancel", "start"])(
    "refuses /event %s for a non-administrator",
    async (subcommand) => {
      const it_ = interaction(
        { subcommand, strings: { id: "event-1" } },
        { member: createRawMember(false) },
      );
      await execute(it_);
      const reply = it_.reply.mock.calls[0][0] as { content: string };
      expect(reply.content).toContain("Only administrators can manage events");
      expect(it_.deferReply).not.toHaveBeenCalled();
    },
  );

  it("leaves /event list open to non-administrators", async () => {
    const it_ = interaction(
      { subcommand: "list" },
      { member: createRawMember(false) },
    );
    await execute(it_);
    expect(mockListEvents).toHaveBeenCalledWith("guild-1");
  });
});

describe("/event create", () => {
  it("defers before the first slow await (#842)", async () => {
    const { date, time } = futureDateTime();
    const it_ = interaction({
      subcommand: "create",
      strings: { title: "Raid", date, time },
    });
    await execute(it_);
    expect(it_.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
  });

  it("rejects an unrecognised IANA timezone", async () => {
    const { date, time } = futureDateTime();
    const it_ = interaction({
      subcommand: "create",
      strings: { title: "Raid", date, time, timezone: "Mars/Olympus_Mons" },
    });
    await execute(it_);
    expect(it_.editReply).toHaveBeenCalledWith(
      expect.stringContaining("not a recognised IANA timezone"),
    );
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("rejects an unparseable date/time", async () => {
    const it_ = interaction({
      subcommand: "create",
      strings: { title: "Raid", date: "tomorrow", time: "sevenish" },
    });
    await execute(it_);
    expect(it_.editReply).toHaveBeenCalledWith(
      expect.stringContaining("Invalid date/time"),
    );
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("rejects a start time in the past", async () => {
    const it_ = interaction({
      subcommand: "create",
      strings: { title: "Raid", date: "2000-01-01", time: "18:00" },
    });
    await execute(it_);
    expect(it_.editReply).toHaveBeenCalledWith(
      expect.stringContaining("must be in the future"),
    );
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("creates the event with the supplied duration and timezone", async () => {
    const { date, time } = futureDateTime();
    const it_ = interaction({
      subcommand: "create",
      strings: {
        title: "  Raid night  ",
        date,
        time,
        description: "  Bring snacks  ",
        timezone: "Europe/London",
      },
      integers: { duration: 90 },
    });
    await execute(it_);
    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateEvent.mock.calls[0][0]).toMatchObject({
      guildId: "guild-1",
      title: "Raid night",
      description: "Bring snacks",
      timezone: "Europe/London",
      durationMinutes: 90,
      createdBy: "user-1",
    });
    expect(it_.editReply).toHaveBeenCalledWith(
      expect.stringContaining("Created event"),
    );
  });

  it("falls back to the configured default duration", async () => {
    mockConfigGetNumber.mockResolvedValue(45);
    const { date, time } = futureDateTime();
    await execute(
      interaction({
        subcommand: "create",
        strings: { title: "Raid", date, time },
      }),
    );
    expect(mockCreateEvent.mock.calls[0][0]).toMatchObject({
      durationMinutes: 45,
    });
  });

  it("reports a service failure without throwing", async () => {
    mockCreateEvent.mockRejectedValue(new Error("duplicate"));
    const { date, time } = futureDateTime();
    const it_ = interaction(
      { subcommand: "create", strings: { title: "Raid", date, time } },
      { member: createRawMember(true), deferred: true },
    );
    await expect(execute(it_)).resolves.toBeUndefined();
    expect(it_.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("error running this command"),
      }),
    );
  });
});

describe("/event list", () => {
  it("tells the member how to create one when nothing is upcoming", async () => {
    const it_ = interaction({ subcommand: "list" });
    await execute(it_);
    expect(it_.editReply).toHaveBeenCalledWith(
      expect.stringContaining("No upcoming events"),
    );
  });

  it("hides ended and cancelled events", async () => {
    mockListEvents.mockResolvedValue([
      {
        _id: "e1",
        title: "Old",
        state: "ended",
        rsvps: [],
        startTime: new Date(),
      },
      {
        _id: "e2",
        title: "Gone",
        state: "cancelled",
        rsvps: [],
        startTime: new Date(),
      },
    ]);
    const it_ = interaction({ subcommand: "list" });
    await execute(it_);
    expect(it_.editReply).toHaveBeenCalledWith(
      expect.stringContaining("No upcoming events"),
    );
  });

  it("renders scheduled and active events with their RSVP tallies", async () => {
    mockListEvents.mockResolvedValue([
      {
        _id: "e1",
        title: "Raid night",
        state: "scheduled",
        startTime: new Date(Date.now() + 86_400_000),
        timezone: "UTC",
        rsvps: [
          { status: "going" },
          { status: "going" },
          { status: "maybe" },
          { status: "cant" },
        ],
      },
    ]);
    const it_ = interaction({ subcommand: "list" });
    await execute(it_);
    const payload = it_.editReply.mock.calls[0][0] as {
      embeds: Array<{
        data: { fields?: Array<{ name: string; value: string }> };
      }>;
    };
    const field = payload.embeds[0].data.fields?.[0];
    expect(field?.name).toBe("Raid night");
    expect(field?.value).toContain("✅ 2");
    expect(field?.value).toContain("🤔 1");
    expect(field?.value).toContain("🚫 1");
  });

  it("caps the embed at 15 events", async () => {
    mockListEvents.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({
        _id: `e${i}`,
        title: `Event ${i}`,
        state: "scheduled",
        startTime: new Date(Date.now() + 86_400_000),
        timezone: "UTC",
        rsvps: [],
      })),
    );
    const it_ = interaction({ subcommand: "list" });
    await execute(it_);
    const payload = it_.editReply.mock.calls[0][0] as {
      embeds: Array<{ data: { fields?: unknown[] } }>;
    };
    expect(payload.embeds[0].data.fields).toHaveLength(15);
  });
});

describe("/event cancel and /event start", () => {
  it("cancels an event in the invoking guild", async () => {
    mockCancelEvent.mockResolvedValue({ _id: "event-1", title: "Raid" });
    const it_ = interaction({
      subcommand: "cancel",
      strings: { id: " event-1 " },
    });
    await execute(it_);
    expect(mockCancelEvent).toHaveBeenCalledWith("event-1", "guild-1");
    expect(it_.editReply).toHaveBeenCalledWith(
      expect.stringContaining("Cancelled **Raid**"),
    );
  });

  it("reports a cancel that matched nothing", async () => {
    mockCancelEvent.mockResolvedValue(null);
    const it_ = interaction({
      subcommand: "cancel",
      strings: { id: "event-1" },
    });
    await execute(it_);
    expect(it_.editReply).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
    );
  });

  it("links the channel when starting an event created one", async () => {
    mockStartEventNow.mockResolvedValue({
      _id: "event-1",
      title: "Raid",
      channelId: "channel-9",
    });
    const it_ = interaction({
      subcommand: "start",
      strings: { id: "event-1" },
    });
    await execute(it_);
    expect(it_.editReply).toHaveBeenCalledWith(
      expect.stringContaining("<#channel-9>"),
    );
  });

  it("reports an event that could not be started", async () => {
    mockStartEventNow.mockResolvedValue(null);
    const it_ = interaction({
      subcommand: "start",
      strings: { id: "event-1" },
    });
    await execute(it_);
    expect(it_.editReply).toHaveBeenCalledWith(
      expect.stringContaining("already ended/cancelled"),
    );
  });
});

describe("event RSVP button handler", () => {
  it("rejects a customId that isn't an event RSVP button", async () => {
    const it_ = createMockButtonInteraction("vc_control_rename");
    await handleEventRsvpButton(it_);
    expect(it_.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Invalid RSVP button"),
      }),
    );
    expect(mockSetRsvp).not.toHaveBeenCalled();
  });

  it("rejects an unknown RSVP status", async () => {
    const it_ = createMockButtonInteraction("event_rsvp_event-1_perhaps");
    await handleEventRsvpButton(it_);
    expect(it_.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Unknown RSVP option"),
      }),
    );
    expect(mockSetRsvp).not.toHaveBeenCalled();
  });

  it.each(["going", "maybe", "cant"])(
    "records a %s RSVP and refreshes the announcement in place",
    async (status) => {
      mockSetRsvp.mockResolvedValue({ _id: "event-1" });
      const it_ = createMockButtonInteraction(`event_rsvp_event-1_${status}`);
      await handleEventRsvpButton(it_);
      expect(mockSetRsvp).toHaveBeenCalledWith("event-1", "user-1", status);
      expect(it_.update).toHaveBeenCalledWith({ content: "refreshed" });
      expect(it_.followUp).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Your RSVP"),
        }),
      );
    },
  );

  it("tells the member when the event no longer accepts RSVPs", async () => {
    mockSetRsvp.mockResolvedValue(null);
    const it_ = createMockButtonInteraction("event_rsvp_event-1_going");
    await handleEventRsvpButton(it_);
    expect(it_.update).not.toHaveBeenCalled();
    expect(it_.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("no longer accepting RSVPs"),
      }),
    );
  });

  it("replies with an error when the RSVP write threw", async () => {
    mockSetRsvp.mockRejectedValue(new Error("mongo down"));
    const it_ = createMockButtonInteraction("event_rsvp_event-1_going");
    await expect(handleEventRsvpButton(it_)).resolves.toBeUndefined();
    expect(it_.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("error recording your RSVP"),
      }),
    );
  });

  it("follows up (rather than re-replying) on an already-acknowledged interaction", async () => {
    mockSetRsvp.mockRejectedValue(new Error("mongo down"));
    const it_ = createMockButtonInteraction("event_rsvp_event-1_going", {
      replied: true,
    });
    await handleEventRsvpButton(it_);
    expect(it_.reply).not.toHaveBeenCalled();
    expect(it_.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("error recording your RSVP"),
      }),
    );
  });
});
