import logger from "../utils/logger.js";
import { ReactionRoleConfig } from "../models/reaction-role-config.js";

/**
 * One-shot data migration for the reaction-roles modernization (issue #813).
 *
 * Before #813 every `ReactionRoleConfig` row was auto-created: the bot always
 * minted a fresh Role + Category + Channel per mapping, so `categoryId` and
 * `channelId` were required and there was no notion of "bind to an existing
 * role". The new schema adds an `autoCreated` flag that governs whether
 * deleting a mapping tears down the underlying Discord role/category/channel.
 *
 * Legacy rows predate that flag, so on read they'd default to `undefined`
 * (falsy) — which would wrongly treat every historical mapping as a plain
 * binding and skip resource teardown on delete. This migration backfills
 * `autoCreated: true` on any row missing the field, restoring the original
 * delete semantics for pre-#813 data.
 *
 * It is idempotent: once every row carries the field and the legacy index is
 * gone, both steps become no-ops on subsequent starts. Runs after the Mongo
 * connection is established and before services that consume reaction-role
 * configs initialise.
 */
const LEGACY_ROLE_NAME_INDEX = "guildId_1_roleName_1";

export async function runReactionRoleMigrations(): Promise<void> {
  await backfillAutoCreated();
  await dropLegacyRoleNameIndex();
}

/**
 * Backfill `autoCreated: true` on rows written before the field existed.
 */
async function backfillAutoCreated(): Promise<void> {
  try {
    const legacyCount = await ReactionRoleConfig.countDocuments({
      autoCreated: { $exists: false },
    });

    if (legacyCount === 0) {
      logger.debug(
        "Reaction-role migration: no legacy rows to backfill (autoCreated present on all rows)",
      );
      return;
    }

    const result = await ReactionRoleConfig.updateMany(
      { autoCreated: { $exists: false } },
      { $set: { autoCreated: true } },
    );

    logger.info(
      `Reaction-role migration: backfilled autoCreated=true on ${result.modifiedCount} legacy mapping(s)`,
    );
  } catch (error) {
    // A failed backfill must never crash startup; the field defaults to true
    // in the schema for any row written afterwards, and delete paths tolerate
    // missing category/channel ids.
    logger.error("Reaction-role migration failed:", error);
  }
}

/**
 * Drop the deployed `{ guildId, roleName }` unique index. Changing the schema
 * declaration alone does not remove an index already built in MongoDB, so the
 * old unique constraint would keep rejecting the same role name across multiple
 * pickers — exactly what #813 needs to allow. Mongoose recreates the new
 * (non-unique roleName + unique messageId/emoji) indexes on model init, so we
 * only have to remove the stale one. Idempotent: a missing index is ignored.
 */
async function dropLegacyRoleNameIndex(): Promise<void> {
  try {
    const collection = ReactionRoleConfig.collection;
    // Guarded for environments where the driver collection isn't available
    // (e.g. the mocked model used in unit tests).
    if (!collection || typeof collection.indexes !== "function") {
      return;
    }

    const indexes = await collection.indexes();
    const stale = indexes.find(
      (idx: { name?: string; unique?: boolean }) =>
        idx.name === LEGACY_ROLE_NAME_INDEX && idx.unique,
    );
    if (!stale) {
      return;
    }

    await collection.dropIndex(LEGACY_ROLE_NAME_INDEX);
    logger.info(
      `Reaction-role migration: dropped stale unique index ${LEGACY_ROLE_NAME_INDEX}`,
    );
  } catch (error) {
    // Non-fatal: worst case the new declaration and the old index coexist until
    // an operator drops it manually; log so it's visible.
    logger.warn(
      "Reaction-role migration: could not drop legacy roleName index:",
      error,
    );
  }
}
