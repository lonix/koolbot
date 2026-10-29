import { it, expect, beforeEach } from "@jest/globals";
import mongoose from "mongoose";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { QuoteService } from "../../src/services/quote-service.js";

/**
 * `/quote edit`'s picker (#1532) lists the quotes a member added through
 * `listQuotesAddedByUser`. The unit tests mock the model, so they cannot show
 * that the filter matches a legacy `<@id>` row, scopes to the member, narrows
 * by a literal substring and sorts newest first on a real server.
 */
describeWithMongo("quote picker against a real MongoDB (#1532)", () => {
  useRealMongo();

  const ME = "100000000000000001";
  const OTHER = "100000000000000002";
  const service = new QuoteService();

  async function insert(
    content: string,
    addedById: string,
    createdAt: Date,
  ): Promise<void> {
    await mongoose.connection.collection("quotes").insertOne({
      content,
      authorId: OTHER,
      addedById,
      channelId: "c1",
      messageId: `m-${content}`,
      createdAt,
      addedAt: createdAt,
      likes: 0,
      dislikes: 0,
    });
  }

  beforeEach(async () => {
    await mongoose.connection.collection("quotes").deleteMany({});
    await insert("oldest (really)", ME, new Date("2026-01-01T00:00:00Z"));
    await insert("legacy mention form", `<@${ME}>`, new Date("2026-02-01"));
    await insert("someone else's", OTHER, new Date("2026-03-01"));
    await insert("newest", ME, new Date("2026-04-01"));
  });

  it("returns only the member's quotes, newest first, including legacy id forms", async () => {
    const rows = await service.listQuotesAddedByUser(ME);
    expect(rows.map((q) => q.content)).toEqual([
      "newest",
      "legacy mention form",
      "oldest (really)",
    ]);
  });

  it("narrows by a literal, case-insensitive substring and honours the limit", async () => {
    expect(
      (await service.listQuotesAddedByUser(ME, "(REALLY)")).map(
        (q) => q.content,
      ),
    ).toEqual(["oldest (really)"]);
    expect(await service.listQuotesAddedByUser(ME, "", 1)).toHaveLength(1);
  });
});
