/**
 * Tests for the event RSVP button handler (issue #849).
 *
 * `src/handlers/event-rsvp-handler.ts` is member-facing: the RSVP buttons on
 * an event announcement are clicked by anyone in the guild.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  createMockButtonInteraction,
  errorEmbedPayload,
  unexpectedErrorPayload,
} from "../test-utils.js";

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
      errorEmbedPayload({
        title: "This RSVP button is out of date",
        description: expect.stringContaining("Interested"),
      }),
    );
    expect(mockSetRsvp).not.toHaveBeenCalled();
  });

  it("rejects an unknown RSVP status", async () => {
    const it_ = createMockButtonInteraction("event_rsvp_event-1_perhaps");
    await handleEventRsvpButton(it_);
    expect(it_.reply).toHaveBeenCalledWith(
      errorEmbedPayload({ title: "This RSVP button is out of date" }),
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
      errorEmbedPayload({
        title: "This event is no longer taking RSVPs here",
        description: expect.stringContaining("Events list"),
      }),
    );
  });

  it("replies with an error when the RSVP write threw", async () => {
    mockSetRsvp.mockRejectedValue(new Error("mongo down"));
    const it_ = createMockButtonInteraction("event_rsvp_event-1_going", {
      message: { id: "msg-1" },
    });
    await expect(handleEventRsvpButton(it_)).resolves.toBeUndefined();
    expect(it_.reply).toHaveBeenCalledWith(unexpectedErrorPayload());
  });

  it("follows up (rather than re-replying) on an already-acknowledged interaction", async () => {
    mockSetRsvp.mockRejectedValue(new Error("mongo down"));
    const it_ = createMockButtonInteraction("event_rsvp_event-1_going", {
      replied: true,
    });
    await handleEventRsvpButton(it_);
    expect(it_.reply).not.toHaveBeenCalled();
    expect(it_.followUp).toHaveBeenCalledWith(unexpectedErrorPayload());
  });

  it("never edits the announcement when the click was deferred (#1534)", async () => {
    // A deferred click's response IS the public announcement: an error must be
    // a separate ephemeral follow-up, not an edit.
    mockSetRsvp.mockRejectedValue(new Error("mongo down"));
    const it_ = createMockButtonInteraction("event_rsvp_event-1_going", {
      deferred: true,
    });
    await handleEventRsvpButton(it_);
    expect(it_.editReply).not.toHaveBeenCalled();
    expect(it_.followUp).toHaveBeenCalledWith(unexpectedErrorPayload());
  });

  it("says the RSVP was recorded, with no retry advice, when the refresh fails", async () => {
    mockSetRsvp.mockResolvedValue({ _id: "event-1" });
    const it_ = createMockButtonInteraction("event_rsvp_event-1_going", {
      message: { id: "msg-1" },
      update: jest.fn(async () => {
        throw new Error("10062 Unknown interaction");
      }),
    });
    await handleEventRsvpButton(it_);
    expect(mockSetRsvp).toHaveBeenCalledTimes(1);
    expect(it_.editReply).not.toHaveBeenCalled();
    const sent = (it_.reply as jest.Mock).mock.calls[0][0] as {
      embeds: { data: { title: string; description: string } }[];
    };
    expect(sent.embeds[0].data.title).toBe("Your RSVP was recorded");
    expect(sent.embeds[0].data.description).not.toMatch(/try again/i);
  });
});
