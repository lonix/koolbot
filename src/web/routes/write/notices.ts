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
  flashRedirectQuery,
  getString,
  getRawString,
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
import {
  orderChanges,
  parseMoveRequest,
  planMove,
  positionText,
} from "./reorder.js";

const PAGE = "/admin/notices";
const OBJECT_ID = /^[0-9a-f]{24}$/;

export function createNoticesRouter(client: Client): Router {
  const router = Router();

  // ============================================================
  // Notices (issue #384)
  // ============================================================

  const NOTICE_CATEGORY_KEYS = new Set(Object.keys(NOTICE_CATEGORIES));

  /**
   * What the create and edit forms submit, checked field by field (#1520).
   * Order is not a field (#1540): a new notice goes last in its category and
   * the Move up / Move down buttons change the rest.
   */
  const checkNoticeForm = (
    req: Parameters<typeof getString>[0],
  ): {
    errors: FormErrors;
    values: FormValues;
    title: string;
    content: string;
    category: string;
  } => {
    const title = getString(req, "title");
    const content = getString(req, "content");
    const category = getString(req, "category");
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
    return {
      errors,
      values: {
        title: getRawString(req, "title"),
        content: getRawString(req, "content"),
        category,
      },
      title,
      content,
      category,
    };
  };

  /** The place after the last notice of `category`: where a new or re-categorised notice goes. */
  const nextOrder = async (category: string): Promise<number> => {
    const last = await Notice.findOne({ category })
      .sort({ order: -1, _id: -1 })
      .lean();
    return last ? last.order + 1 : 0;
  };

  router.post(
    "/notices/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const form = checkNoticeForm(req);
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

      try {
        const enabled = await ConfigService.getInstance().getBoolean(
          "notices.enabled",
          false,
        );
        const order = await nextOrder(category);
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
          details: { title, category },
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
      const form = checkNoticeForm(req);
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

        // Another category means the end of that category's list; the same
        // category keeps its place.
        const order =
          category === notice.category
            ? notice.order
            : await nextOrder(category);
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

  // Move one notice within its category (#1540). The server renumbers the
  // whole category 0..n-1, so no two notices share a place afterwards. A move
  // from a page that no longer matches the list changes nothing.
  router.post(
    "/notices/:id/move",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const move = parseMoveRequest(req);
      if (!OBJECT_ID.test(id) || move === null) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "That move could not be read. Reload the page and try again.",
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
          flashRedirect(res, PAGE, {
            type: "err",
            text: `Notice ${id} not found.`,
          });
          return;
        }
        const rows = (
          await Notice.find({ category: notice.category })
            .sort({ order: 1, _id: 1 })
            .lean()
        ).map((n) => ({ id: String(n._id), order: n.order }));
        const plan = planMove(
          rows.map((r) => r.id),
          id,
          move,
        );
        const where = NOTICE_CATEGORY_KEYS.has(notice.category)
          ? NOTICE_CATEGORIES[notice.category as keyof typeof NOTICE_CATEGORIES]
              .label
          : notice.category;
        if (plan.kind === "stale" || plan.kind === "out-of-range") {
          await recordAudit(session, {
            action: "notice.reorder",
            targetId: id,
            details: {
              category: notice.category,
              from: move.from,
              to: move.to,
            },
            result: "failure",
            errorMessage: plan.kind,
          });
          flashRedirect(res, PAGE, {
            type: "warn",
            text: `The ${where} list changed since this page was drawn, so nothing was moved. The page now shows the current order.`,
          });
          return;
        }
        if (plan.kind === "unchanged") {
          flashRedirect(res, PAGE, {
            type: "ok",
            text: `"${notice.title}" is already at that place in ${where}.`,
          });
          return;
        }
        const changes = orderChanges(rows, plan.ids);
        if (changes.length > 0) {
          await Notice.bulkWrite(
            changes.map((c) => ({
              updateOne: {
                filter: { _id: c.id },
                update: { $set: { order: c.order } },
              },
            })),
          );
        }
        await recordAudit(session, {
          action: "notice.reorder",
          targetId: id,
          details: {
            category: notice.category,
            from: move.from,
            to: move.to,
            renumbered: changes.length,
          },
          result: "success",
        });
        // The hash puts the page back on the moved row.
        const query = flashRedirectQuery({
          type: "ok",
          text: `Moved "${notice.title}" to ${positionText(move.to, rows.length)} in ${where}. Use Resync notices to channel to show the new order in the channel.`,
        });
        res.redirect(303, `${PAGE}?${query}#notice-${id}`);
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Move notice failed", err);
        await recordAudit(session, {
          action: "notice.reorder",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, PAGE, {
          type: "err",
          text: `Failed to move notice ${id}: ${text}`,
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
