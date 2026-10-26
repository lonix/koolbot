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
import { finishRepost } from "./repost-response.js";
import {
  flashRedirect,
  getString,
  getRawString,
  parseIntInRange,
  requireSessionContext,
  asyncHandler,
  refuseForm,
  rowIsGone,
  Flash,
  TEXT_LIMITS,
} from "./helpers.js";
import {
  addFieldError,
  type FormErrors,
  type FormValues,
} from "../../form-errors.js";
import { NOTICE_CREATE_FORM, noticeEditForm } from "../../admin-views.js";

const PAGE = "/admin/notices";
const ORDER_MIN = -1000;
const ORDER_MAX = 10000;

export function createNoticesRouter(client: Client): Router {
  const router = Router();

  // ============================================================
  // Notices (issue #384)
  // ============================================================

  const NOTICE_CATEGORY_KEYS = new Set(Object.keys(NOTICE_CATEGORIES));

  /**
   * What the create and edit forms submit, checked field by field (#1520).
   * The create form's blank order means 0; the edit form's is required.
   */
  const checkNoticeForm = (
    req: Parameters<typeof getString>[0],
    blankOrder: string,
  ): {
    errors: FormErrors;
    values: FormValues;
    title: string;
    content: string;
    category: string;
    order: number | null;
  } => {
    const title = getString(req, "title");
    const content = getString(req, "content");
    const category = getString(req, "category");
    const order = parseIntInRange(
      getString(req, "order") || blankOrder,
      ORDER_MIN,
      ORDER_MAX,
    );
    const errors: FormErrors = {};
    // The length caps mirror what `notice.save()` would otherwise reject as a
    // Mongoose ValidationError (#508).
    if (!title) {
      addFieldError(errors, "title", "Enter a title.");
    } else if (title.length > TEXT_LIMITS.noticeTitle) {
      addFieldError(
        errors,
        "title",
        `At most ${TEXT_LIMITS.noticeTitle} characters.`,
      );
    }
    if (!content) {
      addFieldError(errors, "content", "Enter the notice text.");
    } else if (content.length > TEXT_LIMITS.noticeContent) {
      addFieldError(
        errors,
        "content",
        `At most ${TEXT_LIMITS.noticeContent} characters.`,
      );
    }
    if (!category) {
      addFieldError(errors, "category", "Choose a category.");
    } else if (!NOTICE_CATEGORY_KEYS.has(category)) {
      addFieldError(errors, "category", "Choose one of the listed categories.");
    }
    if (order === null) {
      addFieldError(
        errors,
        "order",
        `Use a whole number from ${ORDER_MIN} to ${ORDER_MAX}.`,
      );
    }
    return {
      errors,
      values: {
        title: getRawString(req, "title"),
        content: getRawString(req, "content"),
        category,
        order: getRawString(req, "order"),
      },
      title,
      content,
      category,
      order,
    };
  };

  router.post(
    "/notices/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const form = checkNoticeForm(req, "0");
      if (
        await refuseForm(req, res, {
          page: PAGE,
          formId: NOTICE_CREATE_FORM,
          errors: form.errors,
          values: form.values,
        })
      ) {
        return;
      }
      const { title, content, category } = form;
      const order = form.order as number;

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
      const form = checkNoticeForm(req, "");
      // A refused edit is drawn in the row's own form; a notice deleted in
      // another tab has none, so say so instead.
      if (Object.keys(form.errors).length > 0) {
        const gone = await rowIsGone(
          async () => !!(await Notice.findById(id)),
          "Notice",
        );
        if (gone) {
          flashRedirect(res, PAGE, {
            type: "err",
            text: `Notice ${id} not found.`,
          });
          return;
        }
      }
      if (
        await refuseForm(req, res, {
          page: PAGE,
          formId: noticeEditForm(id),
          errors: form.errors,
          values: form.values,
        })
      ) {
        return;
      }
      const { title, content, category } = form;
      const order = form.order as number;

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

  // Post the header again and take the old one down (#1428). `expectedId` is
  // the header id the page showed, so a double submit re-posts once.
  router.post(
    "/notices/header/repost",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const result = await NoticesChannelManager.getInstance(
        client,
      ).repostHeader(getString(req, "expectedId"));
      await finishRepost(res, session, result, {
        page: "/admin/notices",
        action: "notice.header-repost",
        what: "The notices channel header",
        extra:
          " It is at the bottom of the channel, and pinned if pinning is on. Use Resync notices to channel if you want the notices below it.",
      });
    }),
  );

  return router;
}
