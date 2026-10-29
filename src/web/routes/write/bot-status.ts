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
  STATUS_TEXT_MAX,
  type BotStatusPool,
} from "../../../content/statuses.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  getString,
  getRawString,
  flashRedirectQuery,
  requireSessionContext,
  asyncHandler,
  parseStringListImport,
  refuseForm,
} from "./helpers.js";
import { addFieldError, type FormErrors } from "../../form-errors.js";
import {
  allMatched,
  casOps,
  orderChanges,
  parseMoveRequest,
  planMove,
  positionText,
} from "./reorder.js";
import {
  botStatusAddForm,
  botStatusEditForm,
  botStatusImportForm,
} from "../../admin-views.js";

const PAGE = "/admin/bot-status";

/**
 * What to change in a status text that `validateStatusEntry` refused, or null
 * when it is fine. `validateStatusEntry` stays the one place that decides.
 */
function statusTextProblem(pool: BotStatusPool, text: string): string | null {
  if (!validateStatusEntry(pool, text)) return null;
  const trimmed = text.trim();
  if (!trimmed) return "Enter the status text.";
  if (trimmed.length > STATUS_TEXT_MAX) {
    return `At most ${STATUS_TEXT_MAX} characters.`;
  }
  return "This pool needs the {count} placeholder.";
}

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
      const errors: FormErrors = {};
      const problem = statusTextProblem(pool, text);
      if (problem) addFieldError(errors, "text", problem);
      if (
        await refuseForm(req, res, {
          page: PAGE,
          formId: botStatusAddForm(pool),
          errors,
          values: { text: getRawString(req, "text") },
        })
      ) {
        return;
      }
      try {
        // A new entry goes last in its pool (#1540).
        const last = await BotStatusMessage.findOne({
          guildId: session.guildId,
          pool,
        })
          .sort({ order: -1, _id: -1 })
          .lean();
        const order = last ? last.order + 1 : 0;
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
      const errors: FormErrors = {};
      const problem = statusTextProblem(pool, text);
      if (problem) addFieldError(errors, "text", problem);
      if (
        await refuseForm(req, res, {
          page: PAGE,
          formId: botStatusEditForm(id),
          errors,
          values: { text: getRawString(req, "text") },
        })
      ) {
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

  // Move one entry within its pool (#1540). The pool is renumbered 0..n-1 so
  // no two entries share a place; a move from a page that no longer matches the
  // pool changes nothing.
  router.post(
    "/bot-status/entry/:id/move",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const move = parseMoveRequest(req);
      if (move === null) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "That move could not be read. Reload the page and try again.",
        });
        return;
      }
      const entry = await findOwnedEntry(res, session.guildId, id);
      if (!entry) return;
      try {
        const rows = (
          await BotStatusMessage.find({
            guildId: session.guildId,
            pool: entry.pool,
          })
            .sort({ order: 1, _id: 1 })
            .lean()
        ).map((e) => ({ id: String(e._id), order: e.order }));
        const plan = planMove(
          rows.map((r) => r.id),
          id,
          move,
        );
        // The form was drawn for another pool: the entry is stored elsewhere now.
        if (
          move.scope !== entry.pool ||
          plan.kind === "stale" ||
          plan.kind === "out-of-range"
        ) {
          await recordAudit(session, {
            action: "bot-status.reorder",
            targetId: id,
            details: { pool: entry.pool, from: move.from, to: move.to },
            result: "failure",
            errorMessage: plan.kind === "moved" ? "stale" : plan.kind,
          });
          flashRedirect(res, PAGE, {
            type: "warn",
            text: "The list changed since this page was drawn, so nothing was moved. The page now shows the current order.",
          });
          return;
        }
        if (plan.kind === "unchanged") {
          flashRedirect(res, PAGE, {
            type: "ok",
            text: "That entry is already at that place.",
          });
          return;
        }
        const changes = orderChanges(rows, plan.ids);
        if (changes.length > 0) {
          // Compare-and-set: an entry another move changed since the read does
          // not match, and is not overwritten.
          const result = await BotStatusMessage.bulkWrite(
            casOps(changes, rows, {
              guildId: session.guildId,
              pool: entry.pool,
            }),
          );
          const done = allMatched(result, changes.length);
          if (!done.ok) {
            // Part of the move may have been written.
            await reloadBotStatusPools();
            await recordAudit(session, {
              action: "bot-status.reorder",
              targetId: id,
              details: {
                pool: entry.pool,
                from: move.from,
                to: move.to,
                matched: done.matched,
                planned: changes.length,
              },
              result: "failure",
              errorMessage: "partial",
            });
            flashRedirect(res, PAGE, {
              type: "warn",
              text: "The list was changed by someone else while this move was made, so it may not have been applied in full. The page now shows the current order.",
            });
            return;
          }
        }
        await reloadBotStatusPools();
        await recordAudit(session, {
          action: "bot-status.reorder",
          targetId: id,
          details: {
            pool: entry.pool,
            from: move.from,
            to: move.to,
            renumbered: changes.length,
          },
          result: "success",
        });
        const query = flashRedirectQuery({
          type: "ok",
          text: `Moved the entry to ${positionText(move.to, rows.length)}. The bot still picks a message at random, so this changes the list and its export only.`,
        });
        res.redirect(303, `${PAGE}?${query}#entry-${encodeURIComponent(id)}`);
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Move bot status failed", err);
        await recordAudit(session, {
          action: "bot-status.reorder",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, PAGE, {
          type: "err",
          text: `Failed to move status: ${text}`,
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
      const errors: FormErrors = {};
      if (entries.length === 0) {
        addFieldError(
          errors,
          "items",
          "Paste at least one entry: one per line, or a JSON array.",
        );
      }
      // Validate every entry up front so the pool is never left half-written.
      for (let i = 0; i < entries.length; i++) {
        const problem = statusTextProblem(pool, entries[i]);
        if (problem) {
          addFieldError(
            errors,
            "items",
            `Entry ${i + 1} ("${entries[i].slice(0, 40)}"): ${problem}`,
          );
          break;
        }
      }
      if (
        await refuseForm(req, res, {
          page: PAGE,
          formId: botStatusImportForm(pool),
          errors,
          values: { items: getRawString(req, "items"), mode },
        })
      ) {
        return;
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
