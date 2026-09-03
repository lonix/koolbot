/**
 * Bot status message pools — add/edit/delete/import/seed.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router, type Response } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { BotStatusService } from "../../../services/bot-status-service.js";
import type { HydratedDocument } from "mongoose";
import {
  BotStatusMessage,
  type IBotStatusMessage,
} from "../../../models/bot-status-message.js";
import {
  isBotStatusPool,
  validateStatusEntry,
  STATUS_POOL_DEFAULTS,
  type BotStatusPool,
} from "../../../content/statuses.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  getString,
  parseIntInRange,
  requireSessionContext,
  asyncHandler,
  parseStringListImport,
} from "./helpers.js";

export function createBotStatusRouter(client: Client): Router {
  const router = Router();

  // ============================================================
  // Bot Status message pools (issue #557)
  // ============================================================

  const reloadBotStatusPools = async (): Promise<void> => {
    await BotStatusService.getInstance(client).refreshStatusPools();
  };

  // Resolve and guild-check a stored entry; flashes + returns null on miss.
  // A malformed (non-ObjectId) `:id` makes Mongoose throw a CastError — catch
  // it and treat it as a clean "not found" rather than a 500.
  const findOwnedEntry = async (
    res: Response,
    guildId: string,
    id: string,
  ): Promise<HydratedDocument<IBotStatusMessage> | null> => {
    let entry: HydratedDocument<IBotStatusMessage> | null;
    try {
      entry = await BotStatusMessage.findById(id);
    } catch {
      entry = null;
    }
    if (!entry || entry.guildId !== guildId) {
      flashRedirect(res, "/admin/bot-status", {
        type: "err",
        text: `Status entry ${id} not found.`,
      });
      return null;
    }
    return entry;
  };

  router.post(
    "/bot-status/pool/:pool/add",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const pool = String(req.params.pool);
      if (!isBotStatusPool(pool)) {
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Unknown pool: ${pool}.`,
        });
        return;
      }
      const text = getString(req, "text");
      const orderRaw = getString(req, "order");
      const invalid = validateStatusEntry(pool, text);
      if (invalid) {
        flashRedirect(res, "/admin/bot-status", { type: "err", text: invalid });
        return;
      }
      const order = parseIntInRange(orderRaw || "0", -1000, 10000);
      if (order === null) {
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: "Order must be an integer between -1000 and 10000.",
        });
        return;
      }
      try {
        const entry = await new BotStatusMessage({
          guildId: session.guildId,
          pool,
          text: text.trim(),
          order,
          createdBy: session.discordUserId,
        }).save();
        await reloadBotStatusPools();
        await recordAudit(session, {
          action: "bot-status.add",
          targetId: String(entry._id),
          details: { pool, order },
          result: "success",
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "ok",
          text: `Added status to the ${pool} pool.`,
        });
      } catch (err) {
        const text2 = err instanceof Error ? err.message : "Unknown error";
        logger.error("Add bot status failed", err);
        await recordAudit(session, {
          action: "bot-status.add",
          details: { pool },
          result: "failure",
          errorMessage: text2,
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Failed to add status: ${text2}`,
        });
      }
    }),
  );

  router.post(
    "/bot-status/entry/:id/update",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const text = getString(req, "text");
      const entry = await findOwnedEntry(res, session.guildId, id);
      if (!entry) return;
      const pool: BotStatusPool = entry.pool;
      const invalid = validateStatusEntry(pool, text);
      if (invalid) {
        flashRedirect(res, "/admin/bot-status", { type: "err", text: invalid });
        return;
      }
      try {
        entry.text = text.trim();
        await entry.save();
        await reloadBotStatusPools();
        await recordAudit(session, {
          action: "bot-status.update",
          targetId: id,
          details: { pool },
          result: "success",
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "ok",
          text: `Updated status entry ${id}.`,
        });
      } catch (err) {
        const text2 = err instanceof Error ? err.message : "Unknown error";
        logger.error("Update bot status failed", err);
        await recordAudit(session, {
          action: "bot-status.update",
          targetId: id,
          result: "failure",
          errorMessage: text2,
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Failed to update status: ${text2}`,
        });
      }
    }),
  );

  router.post(
    "/bot-status/entry/:id/order",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const order = parseIntInRange(
        getString(req, "order") || "0",
        -1000,
        10000,
      );
      if (order === null) {
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: "Order must be an integer between -1000 and 10000.",
        });
        return;
      }
      const entry = await findOwnedEntry(res, session.guildId, id);
      if (!entry) return;
      try {
        const previous = entry.order;
        entry.order = order;
        await entry.save();
        await reloadBotStatusPools();
        await recordAudit(session, {
          action: "bot-status.reorder",
          targetId: id,
          details: { pool: entry.pool, from: previous, to: order },
          result: "success",
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "ok",
          text: `Reordered status entry ${id}: ${previous} → ${order}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Reorder bot status failed", err);
        await recordAudit(session, {
          action: "bot-status.reorder",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Failed to reorder status: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/bot-status/entry/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const entry = await findOwnedEntry(res, session.guildId, id);
      if (!entry) return;
      const pool = entry.pool;
      try {
        await BotStatusMessage.findByIdAndDelete(id);
        await reloadBotStatusPools();
        await recordAudit(session, {
          action: "bot-status.delete",
          targetId: id,
          details: { pool, text: entry.text },
          result: "success",
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "ok",
          text: `Deleted status entry ${id} from the ${pool} pool.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete bot status failed", err);
        await recordAudit(session, {
          action: "bot-status.delete",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Failed to delete status: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/bot-status/pool/:pool/import",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const pool = String(req.params.pool);
      if (!isBotStatusPool(pool)) {
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Unknown pool: ${pool}.`,
        });
        return;
      }
      const mode = getString(req, "mode") === "append" ? "append" : "replace";
      const entries = parseStringListImport(getString(req, "items"));
      if (entries.length === 0) {
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: "Nothing to import — paste one entry per line or a JSON array.",
        });
        return;
      }
      // Validate every entry up front so the pool is never left half-written.
      for (let i = 0; i < entries.length; i++) {
        const invalid = validateStatusEntry(pool, entries[i]);
        if (invalid) {
          flashRedirect(res, "/admin/bot-status", {
            type: "err",
            text: `Import rejected at entry ${i + 1} ("${entries[i].slice(0, 40)}"): ${invalid}`,
          });
          return;
        }
      }
      try {
        let baseOrder = 0;
        if (mode === "replace") {
          await BotStatusMessage.deleteMany({
            guildId: session.guildId,
            pool,
          });
        } else {
          const last = await BotStatusMessage.findOne({
            guildId: session.guildId,
            pool,
          })
            .sort({ order: -1 })
            .lean();
          baseOrder = last ? last.order + 1 : 0;
        }
        await BotStatusMessage.insertMany(
          entries.map((text, i) => ({
            guildId: session.guildId,
            pool,
            text: text.trim(),
            order: baseOrder + i,
            createdBy: session.discordUserId,
          })),
        );
        await reloadBotStatusPools();
        await recordAudit(session, {
          action: "bot-status.import",
          details: { pool, mode, count: entries.length },
          result: "success",
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "ok",
          text: `Imported ${entries.length} ${entries.length === 1 ? "entry" : "entries"} into the ${pool} pool (${mode}).`,
        });
      } catch (err) {
        const text2 = err instanceof Error ? err.message : "Unknown error";
        logger.error("Import bot status failed", err);
        await recordAudit(session, {
          action: "bot-status.import",
          details: { pool, mode },
          result: "failure",
          errorMessage: text2,
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Failed to import: ${text2}`,
        });
      }
    }),
  );

  router.post(
    "/bot-status/pool/:pool/seed",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const pool = String(req.params.pool);
      if (!isBotStatusPool(pool)) {
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Unknown pool: ${pool}.`,
        });
        return;
      }
      try {
        const existing = await BotStatusMessage.countDocuments({
          guildId: session.guildId,
          pool,
        });
        if (existing > 0) {
          flashRedirect(res, "/admin/bot-status", {
            type: "warn",
            text: `The ${pool} pool already has entries — nothing seeded.`,
          });
          return;
        }
        const defaults = STATUS_POOL_DEFAULTS[pool];
        await BotStatusMessage.insertMany(
          defaults.map((text, i) => ({
            guildId: session.guildId,
            pool,
            text,
            order: i,
            createdBy: session.discordUserId,
          })),
        );
        await reloadBotStatusPools();
        await recordAudit(session, {
          action: "bot-status.seed",
          details: { pool, count: defaults.length },
          result: "success",
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "ok",
          text: `Seeded ${defaults.length} default ${pool} entries into the store.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Seed bot status failed", err);
        await recordAudit(session, {
          action: "bot-status.seed",
          details: { pool },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Failed to seed defaults: ${text}`,
        });
      }
    }),
  );

  return router;
}
