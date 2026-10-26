/**
 * Tests for the event RSVP button handler (issue #849).
 *
 * `src/handlers/event-rsvp-handler.ts` is member-facing: the RSVP buttons on
 * an event announcement are clicked by anyone in the guild.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { MessageFlags } from "discord.js";
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

/**
 * A button interaction that behaves like Discord's: `deferUpdate()` flips
 * `deferred`, and every call is recorded in `order` so a test can assert what
 * ran before what (#1534).
 */
function rsvpClick(
  customId: string,
  order: string[] = [],
  overrides: Record<string, unknown> = {},
): ReturnType<typeof createMockButtonInteraction> & {
  deferUpdate: jest.Mock;
  editReply: jest.Mock;
} {
  const it_ = createMockButtonInteraction(customId, {
    message: { id: "msg-1" },
    ...overrides,
  }) as ReturnType<typeof createMockButtonInteraction> & {
    deferUpdate: jest.Mock;
    editReply: jest.Mock;
  };
  it_.deferUpdate = jest.fn(async () => {
    order.push("deferUpdate");
    (it_ as unknown as { deferred: boolean }).deferred = true;
  });
  it_.editReply = jest.fn(async () => {
    order.push("editReply");
  });
  return it_;
}

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

  it("acknowledges the click before it writes the RSVP", async () => {
    const order: string[] = [];
    mockSetRsvp.mockImplementation(async () => {
      order.push("setRsvp");
      return { _id: "event-1" };
    });
    const it_ = rsvpClick("event_rsvp_event-1_going", order);
    await handleEventRsvpButton(it_);
    expect(order.indexOf("deferUpdate")).toBe(0);
    expect(order.indexOf("setRsvp")).toBeGreaterThan(
      order.indexOf("deferUpdate"),
    );
  });

  it.each(["going", "maybe", "cant"])(
    "records a %s RSVP, edits the announcement and follows up",
    async (status) => {
      mockSetRsvp.mockResolvedValue({ _id: "event-1" });
      const it_ = rsvpClick(`event_rsvp_event-1_${status}`);
      await handleEventRsvpButton(it_);
      expect(mockSetRsvp).toHaveBeenCalledWith(
        "event-1",
        "user-1",
        status,
        "msg-1",
      );
      expect(it_.editReply).toHaveBeenCalledWith({ content: "refreshed" });
      expect(it_.update).not.toHaveBeenCalled();
      expect(it_.reply).not.toHaveBeenCalled();
      expect(it_.followUp).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Your RSVP"),
          flags: MessageFlags.Ephemeral,
        }),
      );
    },
  );

  it("follows up ephemerally, and leaves the post alone, when the event no longer accepts RSVPs", async () => {
    mockSetRsvp.mockResolvedValue(null);
    const it_ = rsvpClick("event_rsvp_event-1_going");
    await handleEventRsvpButton(it_);
    expect(it_.editReply).not.toHaveBeenCalled();
    expect(it_.update).not.toHaveBeenCalled();
    expect(it_.reply).not.toHaveBeenCalled();
    expect(it_.followUp).toHaveBeenCalledWith(
      errorEmbedPayload({
        title: "This event is no longer taking RSVPs here",
        description: expect.stringContaining("Events list"),
      }),
    );
    expect(it_.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it("follows up ephemerally, and leaves the post alone, when the RSVP write threw", async () => {
    mockSetRsvp.mockRejectedValue(new Error("mongo down"));
    const it_ = rsvpClick("event_rsvp_event-1_going");
    await expect(handleEventRsvpButton(it_)).resolves.toBeUndefined();
    expect(it_.editReply).not.toHaveBeenCalled();
    expect(it_.update).not.toHaveBeenCalled();
    expect(it_.reply).not.toHaveBeenCalled();
    expect(it_.followUp).toHaveBeenCalledWith(unexpectedErrorPayload());
    expect(it_.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it("says the RSVP was recorded, with no retry advice, when the refresh fails", async () => {
    mockSetRsvp.mockResolvedValue({ _id: "event-1" });
    const it_ = rsvpClick("event_rsvp_event-1_going");
    it_.editReply.mockRejectedValue(new Error("10062 Unknown interaction"));
    await handleEventRsvpButton(it_);
    expect(mockSetRsvp).toHaveBeenCalledTimes(1);
    // The failed edit is the announcement's own refresh; the error is a
    // separate follow-up and never a second edit.
    expect(it_.editReply).toHaveBeenCalledTimes(1);
    const sent = it_.followUp.mock.calls[0][0] as {
      embeds: { data: { title: string; description: string } }[];
    };
    expect(sent.embeds[0].data.title).toBe("Your RSVP was recorded");
    expect(sent.embeds[0].data.description).not.toMatch(/try again/i);
  });

  it("does not write the RSVP when the defer itself fails", async () => {
    const it_ = rsvpClick("event_rsvp_event-1_going");
    it_.deferUpdate.mockRejectedValue(new Error("Unknown interaction"));
    await expect(handleEventRsvpButton(it_)).resolves.toBeUndefined();
    expect(mockSetRsvp).not.toHaveBeenCalled();
    expect(it_.editReply).not.toHaveBeenCalled();
  });

  it("does not hide the error when the follow-up fails too", async () => {
    mockSetRsvp.mockRejectedValue(new Error("mongo down"));
    const it_ = rsvpClick("event_rsvp_event-1_going");
    it_.followUp.mockRejectedValue(new Error("Unknown interaction"));
    await expect(handleEventRsvpButton(it_)).resolves.toBeUndefined();
  });
});
