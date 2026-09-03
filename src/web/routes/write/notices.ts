/**
 * Notices — create/update/delete/toggle and channel rebuild.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { NoticesChannelManager } from "../../../services/notices-channel-manager.js";
import { ConfigService } from "../../../services/config-service.js";
import Notice from "../../../models/notice.js";
import { NOTICE_CATEGORIES } from "../../../content/notice-categories.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  getString,
  parseIntInRange,
  requireSessionContext,
  asyncHandler,
  Flash,
  TEXT_LIMITS,
  firstLengthError,
} from "./helpers.js";

export function createNoticesRouter(client: Client): Router {
  const router = Router();

  // ============================================================
  // Notices (issue #384)
  // ============================================================

  const NOTICE_CATEGORY_KEYS = new Set(Object.keys(NOTICE_CATEGORIES));

  router.post(
    "/notices/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const title = getString(req, "title");
      const content = getString(req, "content");
      const category = getString(req, "category");
      const orderRaw = getString(req, "order");

      if (!title || !content || !category) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Title, content, and category are all required.",
        });
        return;
      }
      const lengthError = firstLengthError([
        { label: "Title", value: title, max: TEXT_LIMITS.noticeTitle },
        { label: "Content", value: content, max: TEXT_LIMITS.noticeContent },
      ]);
      if (lengthError) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: lengthError,
        });
        return;
      }
      if (!NOTICE_CATEGORY_KEYS.has(category)) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Unknown category: ${category}.`,
        });
        return;
      }
      const order = parseIntInRange(orderRaw || "0", -1000, 10000);
      if (order === null) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Order must be an integer between -1000 and 10000.",
        });
        return;
      }

      try {
        const enabled = await ConfigService.getInstance().getBoolean(
          "notices.enabled",
          false,
        );
        const notice = await new Notice({
          title,
          content,
          category,
          order,
          createdBy: session.discordUserId,
        }).save();

        let postedMessageId: string | null = null;
        if (enabled) {
          const manager = NoticesChannelManager.getInstance(client);
          postedMessageId = await manager.postNotice(notice);
          if (postedMessageId) {
            notice.messageId = postedMessageId;
            await notice.save();
          }
        }

        await recordAudit(session, {
          action: "notice.create",
          targetId: String(notice._id),
          details: {
            title,
            category,
            order,
            posted: postedMessageId !== null,
            featureEnabled: enabled,
          },
          result: "success",
        });
        let flashType: Flash["type"] = "ok";
        let flashText: string;
        if (!enabled) {
          flashText = `Created notice ${notice._id}. Enable notices.enabled to post it to a channel.`;
        } else if (postedMessageId !== null) {
          flashText = `Created notice ${notice._id} and posted to channel.`;
        } else {
          flashType = "warn";
          flashText = `Created notice ${notice._id} but the channel post failed. Check the bot's logs and use Resync to retry.`;
        }
        flashRedirect(res, "/admin/notices", {
          type: flashType,
          text: flashText,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Create notice failed", err);
        await recordAudit(session, {
          action: "notice.create",
          details: { title, category, order },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Failed to create notice: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/notices/:id/update",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const title = getString(req, "title");
      const content = getString(req, "content");
      const category = getString(req, "category");
      const orderRaw = getString(req, "order");

      if (!title || !content || !category) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Title, content, and category are all required.",
        });
        return;
      }
      // Mirror the create-route length checks: `notice.save()` would otherwise
      // reject the oversized field as a Mongoose ValidationError surfaced as a
      // 500-style flash instead of this readable message (#508).
      const lengthError = firstLengthError([
        { label: "Title", value: title, max: TEXT_LIMITS.noticeTitle },
        { label: "Content", value: content, max: TEXT_LIMITS.noticeContent },
      ]);
      if (lengthError) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: lengthError,
        });
        return;
      }
      if (!NOTICE_CATEGORY_KEYS.has(category)) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Unknown category: ${category}.`,
        });
        return;
      }
      const order = parseIntInRange(orderRaw, -1000, 10000);
      if (order === null) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Order must be an integer between -1000 and 10000.",
        });
        return;
      }

      try {
        const notice = await Notice.findById(id);
        if (!notice) {
          await recordAudit(session, {
            action: "notice.update",
            targetId: id,
            result: "failure",
            errorMessage: "not found",
          });
          flashRedirect(res, "/admin/notices", {
            type: "err",
            text: `Notice ${id} not found.`,
          });
          return;
        }

        notice.title = title;
        notice.content = content;
        notice.category = category;
        notice.order = order;
        await notice.save();

        const enabled = await ConfigService.getInstance().getBoolean(
          "notices.enabled",
          false,
        );
        // `postNotice()` catches its own errors and returns null on failure.
        // Track the actual outcome so the audit/flash don't lie about a repost.
        let repostAttempted = false;
        let repostSucceeded = false;
        if (enabled) {
          repostAttempted = true;
          const manager = NoticesChannelManager.getInstance(client);
          if (notice.messageId) {
            await manager.deleteNoticeMessage(notice.messageId);
          }
          const newMessageId = await manager.postNotice(notice);
          if (newMessageId) {
            notice.messageId = newMessageId;
            repostSucceeded = true;
          } else {
            // We deleted (or tried to delete) the old message but couldn't
            // post a replacement. Clear the now-stale messageId so the next
            // sync doesn't try to delete a message that no longer exists.
            notice.messageId = undefined;
          }
          await notice.save();
        }

        await recordAudit(session, {
          action: "notice.update",
          targetId: id,
          details: {
            title,
            category,
            order,
            repostAttempted,
            repostSucceeded,
          },
          result: "success",
        });
        if (repostAttempted && !repostSucceeded) {
          flashRedirect(res, "/admin/notices", {
            type: "warn",
            text: `Updated notice ${id} but the channel post failed. Use Resync to retry.`,
          });
          return;
        }
        flashRedirect(res, "/admin/notices", {
          type: "ok",
          text: `Updated notice ${id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Update notice failed", err);
        await recordAudit(session, {
          action: "notice.update",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Failed to update notice ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/notices/:id/order",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const orderRaw = getString(req, "order");
      const order = parseIntInRange(orderRaw, -1000, 10000);
      if (order === null) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Order must be an integer between -1000 and 10000.",
        });
        return;
      }
      try {
        const notice = await Notice.findById(id);
        if (!notice) {
          await recordAudit(session, {
            action: "notice.reorder",
            targetId: id,
            result: "failure",
            errorMessage: "not found",
          });
          flashRedirect(res, "/admin/notices", {
            type: "err",
            text: `Notice ${id} not found.`,
          });
          return;
        }
        const previous = notice.order;
        notice.order = order;
        await notice.save();
        await recordAudit(session, {
          action: "notice.reorder",
          targetId: id,
          details: { from: previous, to: order, category: notice.category },
          result: "success",
        });
        flashRedirect(res, "/admin/notices", {
          type: "ok",
          text: `Reordered notice ${id}: ${previous} → ${order}. Resync to refresh channel order.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Reorder notice failed", err);
        await recordAudit(session, {
          action: "notice.reorder",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Failed to reorder notice ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/notices/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      try {
        const notice = await Notice.findById(id);
        if (!notice) {
          await recordAudit(session, {
            action: "notice.delete",
            targetId: id,
            result: "failure",
            errorMessage: "not found",
          });
          flashRedirect(res, "/admin/notices", {
            type: "err",
            text: `Notice ${id} not found.`,
          });
          return;
        }
        const manager = NoticesChannelManager.getInstance(client);
        if (notice.messageId) {
          await manager.deleteNoticeMessage(notice.messageId);
        }
        await Notice.findByIdAndDelete(id);
        await recordAudit(session, {
          action: "notice.delete",
          targetId: id,
          details: { title: notice.title, category: notice.category },
          result: "success",
        });
        flashRedirect(res, "/admin/notices", {
          type: "ok",
          text: `Deleted notice ${id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete notice failed", err);
        await recordAudit(session, {
          action: "notice.delete",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Failed to delete notice ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/notices/sync",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      try {
        const manager = NoticesChannelManager.getInstance(client);
        await manager.syncNotices();
        const count = await Notice.countDocuments();
        await recordAudit(session, {
          action: "notice.sync",
          details: { count },
          result: "success",
        });
        flashRedirect(res, "/admin/notices", {
          type: "ok",
          text: `Synced ${count} notices to channel.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Notice sync failed", err);
        await recordAudit(session, {
          action: "notice.sync",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Failed to sync notices: ${text}`,
        });
      }
    }),
  );

  return router;
}
