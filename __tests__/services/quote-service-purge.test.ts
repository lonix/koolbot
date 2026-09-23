import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { QuoteService } from "../../src/services/quote-service.js";
import { ANONYMISED_USER_ID } from "../../src/services/user-data-registry.js";
import { MissingPostError } from "../../src/utils/discord.js";

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
  let messages: {
    deleteQuoteMessage: jest.Mock;
    updateQuoteMessage: jest.Mock;
  };

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
    messages = {
      deleteQuoteMessage: jest.fn(async () => true),
      updateQuoteMessage: jest.fn(async () => undefined),
    };
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

      // By the snapshot's ids, not a fresh `authorId` re-match: re-matching
      // would delete a quote created after the snapshot whose channel post
      // was never inspected, leaving a public orphan (#916).
      expect(model.deleteMany).toHaveBeenCalledWith({
        $or: [
          { _id: "q1", messageId: "m1" },
          { _id: "q2", messageId: "m2" },
        ],
      });
      // Without this the member's words stay visible in Discord forever:
      // `cleanupUnauthorizedMessages` only sweeps non-bot messages, so a
      // bot-posted quote orphaned by a row delete is never collected.
      expect(messages.deleteQuoteMessage).toHaveBeenCalledTimes(2);
      expect(messages.deleteQuoteMessage).toHaveBeenCalledWith("m1", undefined);
      expect(messages.deleteQuoteMessage).toHaveBeenCalledWith("m2", undefined);
      expect(result.deleted).toBe(2);
      expect(result.messagesAttempted).toBe(2);
      expect(result.messagesDeleted).toBe(2);
      expect(result.messagesFailed).toBe(0);
    });

    it("counts a post it could not delete as a failure, not a deletion", async () => {
      // `deleteQuoteMessage` resolving false means the post may still be
      // visible in the quote channel. Counting it as deleted would tell the
      // member their words are gone from Discord while they are on screen
      // (#916).
      model.find.mockResolvedValue([
        { _id: "q1", messageId: "m1" },
        { _id: "q2", messageId: "m2" },
      ]);
      model.deleteMany.mockResolvedValue({ deletedCount: 2 });
      messages.deleteQuoteMessage.mockResolvedValueOnce(true);
      messages.deleteQuoteMessage.mockResolvedValueOnce(false);

      const result = await service.purgeForUser("123", messages);

      expect(result.messagesAttempted).toBe(2);
      expect(result.messagesDeleted).toBe(1);
      expect(result.messagesFailed).toBe(1);
      // The rows still go: a member's erasure is not held up by a stale
      // `messageId` or an unreachable channel.
      expect(result.deleted).toBe(2);
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
      expect(result.messagesFailed).toBe(1);
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
      // No authored quotes, three saved for other people.
      model.find.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { _id: "q1", messageId: null, content: "a", authorId: "999" },
        { _id: "q2", messageId: null, content: "b", authorId: "999" },
        { _id: "q3", messageId: null, content: "c", authorId: "999" },
      ]);
      model.updateMany.mockResolvedValue({ modifiedCount: 3 });

      const result = await service.purgeForUser("123", messages);

      // `addedById` is `required: true`, so `$set: { addedById: null }` would
      // throw on a validated write — and `updateMany` skips validators by
      // default, quietly persisting an invalid document instead.
      //
      // Pinned to the rows inspected and the `messageId` each had when its
      // post was redrawn, so a row that gained a post in between is left
      // attributed rather than stranded behind a sentinel (#916).
      expect(model.updateMany).toHaveBeenCalledWith(
        {
          $or: [
            { _id: "q1", messageId: null },
            { _id: "q2", messageId: null },
            { _id: "q3", messageId: null },
          ],
        },
        { $set: { addedById: ANONYMISED_USER_ID } },
      );
      expect(result.anonymised).toBe(3);
      // The quote itself belongs to its author and survives. This member
      // authored none, so the delete is skipped entirely: `$or: []` is a
      // filter MongoDB rejects, and issuing it would fail every purge for
      // someone who only ever saved other people's quotes (#916).
      expect(model.deleteMany).not.toHaveBeenCalled();
    });

    it("re-renders the channel post so it stops naming them as the saver", async () => {
      // The embed prints "Added by @member": clearing only the row leaves
      // the member's name on a public message (#916).
      model.find.mockResolvedValue([
        { _id: "q1", messageId: "m1", content: "Hi", authorId: "999" },
      ]);
      model.updateMany.mockResolvedValue({ modifiedCount: 1 });

      const result = await service.purgeForUser("123", messages);

      expect(messages.updateQuoteMessage).toHaveBeenCalledWith(
        "m1",
        "q1",
        "Hi",
        "999",
        ANONYMISED_USER_ID,
        undefined,
      );
      expect(result.attributionsRerendered).toBe(1);
      expect(result.attributionsStale).toBe(0);
    });

    it("counts a post it could not re-render as still naming them", async () => {
      model.find.mockResolvedValue([
        { _id: "q1", messageId: "m1", content: "Hi", authorId: "999" },
      ]);
      model.updateMany.mockResolvedValue({ modifiedCount: 1 });
      messages.updateQuoteMessage.mockRejectedValue(new Error("no perms"));

      const result = await service.purgeForUser("123", messages);

      // The row is anonymised either way — an unreachable post must not hold
      // up the erasure — but the embed still shows them.
      expect(result.anonymised).toBe(1);
      expect(result.attributionsRerendered).toBe(0);
      expect(result.attributionsStale).toBe(1);
    });

    it("does not count an already-deleted post as still naming them", async () => {
      // `messageId` is overloaded: it holds the *originating* message id
      // until the quote-channel post goes up, so the edit missing is the
      // expected case for older rows, not a failure. Counting it as stale
      // would keep the purge report failing over a name that appears
      // nowhere (#916).
      model.find.mockResolvedValue([
        { _id: "q1", messageId: "m1", content: "Hi", authorId: "999" },
      ]);
      model.updateMany.mockResolvedValue({ modifiedCount: 1 });
      messages.updateQuoteMessage.mockRejectedValue(
        new MissingPostError("Quote message m1 no longer exists"),
      );

      const result = await service.purgeForUser("123", messages);

      expect(result.anonymised).toBe(1);
      expect(result.attributionsGone).toBe(1);
      expect(result.attributionsStale).toBe(0);
      expect(result.attributionsRerendered).toBe(0);
    });

    it("re-renders the posts even when the update rejects", async () => {
      // A multi-document update can modify rows and still reject — a lost
      // acknowledgement is enough. Those rows now hold the sentinel, so no
      // retry selects them again, and skipping the redraw would leave the
      // member named on every embed for good (#916).
      model.find.mockResolvedValue([
        { _id: "q1", messageId: "m1", content: "Hi", authorId: "999" },
      ]);
      model.updateMany.mockRejectedValue(new Error("connection reset"));

      const result = await service.purgeForUser("123", messages);

      expect(messages.updateQuoteMessage).toHaveBeenCalledWith(
        "m1",
        "q1",
        "Hi",
        "999",
        ANONYMISED_USER_ID,
        undefined,
      );
      expect(result.attributionsRerendered).toBe(1);
      // The write failure is still reported rather than papered over.
      expect(result.anonymiseError).toBe("connection reset");
    });

    it("redraws the post before it writes the sentinel", async () => {
      // The sentinel is what makes a row invisible to the next purge, so
      // writing it first means anything that fails in between leaves an
      // embed naming the member with nothing left to select it (#916).
      model.find.mockResolvedValue([
        { _id: "q1", messageId: "m1", content: "Hi", authorId: "999" },
      ]);
      model.updateMany.mockResolvedValue({ modifiedCount: 1 });

      await service.purgeForUser("123", messages);

      expect(
        messages.updateQuoteMessage.mock.invocationCallOrder[0],
      ).toBeLessThan(model.updateMany.mock.invocationCallOrder[0]);
    });

    it("keeps a row that gained a post mid-purge, and says so", async () => {
      // Its `messageId` no longer matches what was inspected, so the write
      // skips it: anonymising it would leave a fresh post crediting the
      // member behind a sentinel row no retry can find.
      model.find.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { _id: "q1", messageId: null, content: "a", authorId: "999" },
        { _id: "q2", messageId: null, content: "b", authorId: "999" },
      ]);
      model.updateMany.mockResolvedValue({ modifiedCount: 1 });

      const result = await service.purgeForUser("123", messages);

      expect(result.saverMatched).toBe(2);
      expect(result.anonymised).toBe(1);
      expect(result.anonymiseError).toContain("run the reset again");
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
    expect(model.find).toHaveBeenCalledWith({ addedById: { $in: ID_FORMS } });
  });

  it("reports zeros for a member with no quotes", async () => {
    const result = await service.purgeForUser("123", messages);

    // No snapshot, no delete — see the sentinel test above.
    expect(model.deleteMany).not.toHaveBeenCalled();

    expect(result).toEqual({
      authored: 0,
      deleted: 0,
      deleteError: undefined,
      messagesAttempted: 0,
      messagesDeleted: 0,
      messagesFailed: 0,
      saverMatched: 0,
      anonymised: 0,
      attributionsRerendered: 0,
      attributionsStale: 0,
      attributionsGone: 0,
      anonymiseError: undefined,
    });
    expect(messages.deleteQuoteMessage).not.toHaveBeenCalled();
  });

  it("keeps a quote published mid-purge rather than orphaning its post", async () => {
    // The reverse ordering of the add race: the purge inspected the old
    // `messageId`, then the add posted and recorded the new one before this
    // delete. Deleting anyway would strand a post nothing can find.
    model.find.mockResolvedValue([
      { _id: "q1", messageId: "m1" },
      { _id: "q2", messageId: undefined },
    ]);
    // Only q1 still matches its snapshot; q2 gained a messageId in between.
    model.deleteMany.mockResolvedValue({ deletedCount: 1 });

    const result = await service.purgeForUser("123", messages);

    expect(model.deleteMany).toHaveBeenCalledWith({
      $or: [
        { _id: "q1", messageId: "m1" },
        { _id: "q2", messageId: null },
      ],
    });
    expect(result.authored).toBe(2);
    expect(result.deleted).toBe(1);
    // Reported, not silently smaller: the row is still there to be swept.
    expect(result.deleteError).toContain("published while the purge ran");
  });

  it("still anonymises when the authored lookup itself fails", async () => {
    // The lookup only the authored half needs must not be able to skip the
    // independent anonymisation (#916).
    // Only the authored lookup fails; the anonymise half takes its own
    // snapshot and must still run.
    model.find.mockRejectedValueOnce(new Error("no primary"));
    model.find.mockResolvedValue([
      { _id: "q1", messageId: null, content: "a", authorId: "999" },
      { _id: "q2", messageId: null, content: "b", authorId: "999" },
    ]);
    model.updateMany.mockResolvedValue({ modifiedCount: 2 });

    const result = await service.purgeForUser("123", messages);

    expect(result.authored).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.deleteError).toBe("no primary");
    // Not attempted, since the rows it would delete are unknown.
    expect(model.deleteMany).not.toHaveBeenCalled();
    expect(result.anonymised).toBe(2);
  });

  it("still anonymises when the row delete fails, and records why", async () => {
    // By this point the Discord posts are already deleted. Letting the row
    // delete take the whole call down would lose that, and leave the saver
    // attribution standing with the caller none the wiser (#916).
    model.find.mockResolvedValue([{ _id: "q1", messageId: "m1" }]);
    model.deleteMany.mockRejectedValue(new Error("write conflict"));
    model.updateMany.mockResolvedValue({ modifiedCount: 2 });

    const result = await service.purgeForUser("123", messages);

    expect(result.authored).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.deleteError).toBe("write conflict");
    expect(result.messagesDeleted).toBe(1);
    expect(result.anonymised).toBe(2);
  });

  it("reports an anonymisation failure without losing the deleted rows", async () => {
    model.find.mockResolvedValue([{ _id: "q1", messageId: "m1" }]);
    model.deleteMany.mockResolvedValue({ deletedCount: 1 });
    model.updateMany.mockRejectedValue(new Error("no primary"));

    const result = await service.purgeForUser("123", messages);

    expect(result.deleted).toBe(1);
    expect(result.anonymised).toBe(0);
    expect(result.anonymiseError).toBe("no primary");
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
