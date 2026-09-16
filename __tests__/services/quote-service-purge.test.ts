import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { QuoteService } from "../../src/services/quote-service.js";
import { ANONYMISED_USER_ID } from "../../src/services/user-data-registry.js";

jest.mock("mongoose");
jest.mock("../../src/database/schema.js");
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/services/cooldown-manager.js");
jest.mock("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

/**
 * `QuoteService.purgeForUser` (#914).
 *
 * The two halves of a quote row are two different people: a quote the member
 * *said* is theirs and goes (post included), while a quote they merely
 * *saved* belongs to whoever said it and only loses the saver's name. Both
 * halves have a trap the naive implementation falls into — an orphaned
 * Discord post nothing sweeps, and a `required: true` field that cannot be
 * nulled.
 */
describe("QuoteService.purgeForUser", () => {
  let service: QuoteService;
  let model: {
    find: jest.Mock;
    deleteMany: jest.Mock;
    updateMany: jest.Mock;
  };
  let messages: { deleteQuoteMessage: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new QuoteService();
    model = {
      find: jest.fn(async () => []),
      deleteMany: jest.fn(async () => ({ deletedCount: 0 })),
      updateMany: jest.fn(async () => ({ modifiedCount: 0 })),
    } as never;
    // Replace the (mongoose-mocked) model with a controllable stub.
    (service as never as { model: unknown }).model = model;
    messages = { deleteQuoteMessage: jest.fn(async () => undefined) };
  });

  const ID_FORMS = ["123", "<@123>", "<@!123>", "@123"];

  describe("quotes the member said", () => {
    it("deletes the row and its quote-channel post", async () => {
      model.find.mockResolvedValue([
        { _id: "q1", messageId: "m1" },
        { _id: "q2", messageId: "m2" },
      ]);
      model.deleteMany.mockResolvedValue({ deletedCount: 2 });

      const result = await service.purgeForUser("123", messages);

      expect(model.deleteMany).toHaveBeenCalledWith({
        authorId: { $in: ID_FORMS },
      });
      // Without this the member's words stay visible in Discord forever:
      // `cleanupUnauthorizedMessages` only sweeps non-bot messages, so a
      // bot-posted quote orphaned by a row delete is never collected.
      expect(messages.deleteQuoteMessage).toHaveBeenCalledTimes(2);
      expect(messages.deleteQuoteMessage).toHaveBeenCalledWith("m1");
      expect(messages.deleteQuoteMessage).toHaveBeenCalledWith("m2");
      expect(result.deleted).toBe(2);
      expect(result.messagesDeleted).toBe(2);
    });

    it("still deletes the row when the message is already gone", async () => {
      // `messageId` is overloaded — it starts as the original message id and
      // is only later overwritten with the quote-channel post id — so a miss
      // is expected, not exceptional.
      model.find.mockResolvedValue([{ _id: "q1", messageId: "m1" }]);
      model.deleteMany.mockResolvedValue({ deletedCount: 1 });
      messages.deleteQuoteMessage.mockRejectedValue(
        new Error("Unknown Message"),
      );

      const result = await service.purgeForUser("123", messages);

      expect(result.deleted).toBe(1);
      expect(result.messagesDeleted).toBe(0);
      expect(model.deleteMany).toHaveBeenCalledTimes(1);
    });

    it("skips the message delete for a row with no messageId", async () => {
      model.find.mockResolvedValue([{ _id: "q1", messageId: "" }]);
      model.deleteMany.mockResolvedValue({ deletedCount: 1 });

      const result = await service.purgeForUser("123", messages);

      expect(messages.deleteQuoteMessage).not.toHaveBeenCalled();
      expect(result.deleted).toBe(1);
    });
  });

  describe("quotes the member saved for someone else", () => {
    it("writes the sentinel instead of deleting or nulling", async () => {
      model.updateMany.mockResolvedValue({ modifiedCount: 3 });

      const result = await service.purgeForUser("123", messages);

      // `addedById` is `required: true`, so `$set: { addedById: null }` would
      // throw on a validated write — and `updateMany` skips validators by
      // default, quietly persisting an invalid document instead.
      expect(model.updateMany).toHaveBeenCalledWith(
        { addedById: { $in: ID_FORMS } },
        { $set: { addedById: ANONYMISED_USER_ID } },
      );
      expect(result.anonymised).toBe(3);
      // The quote itself belongs to its author and survives.
      expect(model.deleteMany).toHaveBeenCalledWith({
        authorId: { $in: ID_FORMS },
      });
    });

    it("uses a sentinel no real member can match", () => {
      expect(ANONYMISED_USER_ID).toBe("0");
      expect(ANONYMISED_USER_ID).not.toMatch(/^\d{17,20}$/);
    });
  });

  it("deletes authored rows before anonymising, so a self-saved quote goes", async () => {
    model.find.mockResolvedValue([{ _id: "q1", messageId: "m1" }]);
    model.deleteMany.mockResolvedValue({ deletedCount: 1 });
    model.updateMany.mockResolvedValue({ modifiedCount: 0 });

    await service.purgeForUser("123", messages);

    expect(model.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      model.updateMany.mock.invocationCallOrder[0],
    );
  });

  it("matches legacy id formats, exactly as the readers do", async () => {
    await service.purgeForUser("<@!123>", messages);

    expect(model.find).toHaveBeenCalledWith({ authorId: { $in: ID_FORMS } });
    expect(model.updateMany).toHaveBeenCalledWith(
      { addedById: { $in: ID_FORMS } },
      { $set: { addedById: ANONYMISED_USER_ID } },
    );
  });

  it("reports zeros for a member with no quotes", async () => {
    const result = await service.purgeForUser("123", messages);

    expect(result).toEqual({ deleted: 0, messagesDeleted: 0, anonymised: 0 });
    expect(messages.deleteQuoteMessage).not.toHaveBeenCalled();
  });

  it("does not route through deleteQuote, so no role check is consulted", async () => {
    model.find.mockResolvedValue([{ _id: "q1", messageId: "m1" }]);
    model.deleteMany.mockResolvedValue({ deletedCount: 1 });
    const deleteQuote = jest.spyOn(service, "deleteQuote");

    await service.purgeForUser("123", messages);

    // `deleteQuote` enforces `quotes.delete_roles`. A member erasing their
    // own data must not be the call site that decides to skip that check.
    expect(deleteQuote).not.toHaveBeenCalled();
  });
});
