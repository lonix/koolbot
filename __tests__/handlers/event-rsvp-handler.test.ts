/**
 * Tests for the event RSVP button handler (issue #849).
 *
 * `src/handlers/event-rsvp-handler.ts` is member-facing: the RSVP buttons on
 * an event announcement are clicked by anyone in the guild.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { createMockButtonInteraction } from "../test-utils.js";

const mockSetRsvp = jest.fn<() => Promise<unknown>>();
const mockBuildAnnouncementPayload = jest.fn(() => ({ content: "refreshed" }));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Keep the real pure helpers and swap only the service singleton.
const actualEventService = await import("../../src/services/event-service.js");
jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  ...actualEventService,
  EventService: {
    getInstance: (): unknown => ({
      setRsvp: mockSetRsvp,
      buildLegacyRsvpPayload: mockBuildAnnouncementPayload,
    }),
  },
}));

const { handleEventRsvpButton } =
  await import("../../src/handlers/event-rsvp-handler.js");

beforeEach(() => {
  jest.clearAllMocks();
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
      const it_ = createMockButtonInteraction(`event_rsvp_event-1_${status}`, {
        message: { id: "msg-1" },
      });
      await handleEventRsvpButton(it_);
      expect(mockSetRsvp).toHaveBeenCalledWith(
        "event-1",
        "user-1",
        status,
        "msg-1",
      );
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
    const it_ = createMockButtonInteraction("event_rsvp_event-1_going", {
      message: { id: "msg-1" },
    });
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
    const it_ = createMockButtonInteraction("event_rsvp_event-1_going", {
      message: { id: "msg-1" },
    });
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
