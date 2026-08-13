import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// Rely on the global mongoose mock (see __tests__/setup.ts) and assign the
// statics this migration touches directly onto the imported model — the repo's
// convention for model-level unit tests under the ESM jest setup.
jest.mock("../../src/models/reaction-role-config.js");

import { runReactionRoleMigrations } from "../../src/services/reaction-role-migrator.js";
import { ReactionRoleConfig } from "../../src/models/reaction-role-config.js";

const Model = ReactionRoleConfig as unknown as {
  countDocuments: jest.Mock;
  updateMany: jest.Mock;
  collection?: unknown;
};

beforeEach(() => {
  jest.clearAllMocks();
  Model.countDocuments = jest.fn().mockResolvedValue(0);
  Model.updateMany = jest.fn();
  Model.collection = undefined;
});

describe("runReactionRoleMigrations", () => {
  it("backfills autoCreated=true on legacy rows missing the field", async () => {
    Model.countDocuments.mockResolvedValue(3);
    Model.updateMany.mockResolvedValue({ modifiedCount: 3 });

    await runReactionRoleMigrations();

    expect(Model.updateMany).toHaveBeenCalledWith(
      { autoCreated: { $exists: false } },
      { $set: { autoCreated: true } },
    );
  });

  it("is a no-op when every row already carries the field", async () => {
    Model.countDocuments.mockResolvedValue(0);

    await runReactionRoleMigrations();

    expect(Model.updateMany).not.toHaveBeenCalled();
  });

  it("never throws when the backfill query fails", async () => {
    Model.countDocuments.mockRejectedValue(new Error("db down"));

    await expect(runReactionRoleMigrations()).resolves.toBeUndefined();
  });

  it("drops the stale guildId_1_roleName_1 unique index when present", async () => {
    const dropIndex = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(undefined);
    Model.collection = {
      indexes: jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue([
          { name: "_id_" },
          { name: "guildId_1_roleName_1", unique: true },
          { name: "guildId_1_messageId_1_emoji_1", unique: true },
        ]),
      dropIndex,
    };

    await runReactionRoleMigrations();

    expect(dropIndex).toHaveBeenCalledWith("guildId_1_roleName_1");
  });

  it("leaves indexes alone when the stale unique index is absent", async () => {
    const dropIndex = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(undefined);
    Model.collection = {
      indexes: jest.fn<() => Promise<unknown>>().mockResolvedValue([
        { name: "_id_" },
        // Same key but non-unique — this is the new declaration, keep it.
        { name: "guildId_1_roleName_1", unique: false },
      ]),
      dropIndex,
    };

    await runReactionRoleMigrations();

    expect(dropIndex).not.toHaveBeenCalled();
  });
});
