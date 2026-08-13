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
 * It is idempotent: once every row carries the field, the `$exists: false`
 * filter matches nothing and the migration is a no-op on subsequent starts.
 * Runs after the Mongo connection is established and before services that
 * consume reaction-role configs initialise.
 */
export async function runReactionRoleMigrations(): Promise<void> {
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
