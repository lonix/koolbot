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
 * Recording a quote-channel post id against its row (#916).
 *
 * A quote is written to Mongo before it is posted to Discord, so a per-user
 * purge running in that window acts on a row whose post does not exist yet —
 * and the post that then goes up is drawn from values the publisher read
 * before the purge touched them. The publisher is the only party left that
 * can see both, so this write has to tell it what changed underneath.
 */
describe("QuoteService.updateQuoteMessageId", () => {
  let service: QuoteService;
  let model: { findByIdAndUpdate: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new QuoteService();
    model = { findByIdAndUpdate: jest.fn(async () => null) } as never;
    (service as never as { model: unknown }).model = model;
  });

  it("confirms an ordinary publication", async () => {
    model.findByIdAndUpdate.mockResolvedValue({ addedById: "123" });

    await expect(service.updateQuoteMessageId("q1", "m1")).resolves.toEqual({
      stillExists: true,
      attributionCleared: false,
    });
    // Returning the updated document is what makes the attribution check
    // below see the purge's write rather than the pre-purge value.
    expect(model.findByIdAndUpdate).toHaveBeenCalledWith(
      "q1",
      { messageId: "m1" },
      { new: true },
    );
  });

  it("reports a row deleted by a purge mid-publication", async () => {
    model.findByIdAndUpdate.mockResolvedValue(null);

    await expect(service.updateQuoteMessageId("q1", "m1")).resolves.toEqual({
      stillExists: false,
      attributionCleared: false,
    });
  });

  it("reports a saver attribution cleared by a purge mid-publication", async () => {
    // The purge anonymised the row and re-rendered the post it could see —
    // the *originating* message, since `messageId` only becomes the
    // quote-channel post id on this very write. The post now on screen is
    // invisible to it, and the row holds the sentinel so no later purge will
    // find it either.
    model.findByIdAndUpdate.mockResolvedValue({
      addedById: ANONYMISED_USER_ID,
    });

    await expect(service.updateQuoteMessageId("q1", "m1")).resolves.toEqual({
      stillExists: true,
      attributionCleared: true,
    });
  });
});
