/**
 * Quotes — edit/delete a stored quote, rebuild the quote channel and
 * download a JSON backup (#984).
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { ConfigService } from "../../../services/config-service.js";
import { quoteService } from "../../../services/quote-service.js";
import { QuoteChannelManager } from "../../../services/quote-channel-manager.js";
import { isMissingPostError } from "../../../utils/discord.js";
import { normalizeUserId } from "../../../utils/user-id.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  getString,
  requireSessionContext,
  asyncHandler,
} from "./helpers.js";

const QUOTES_PAGE = "/admin/quotes";

/** A Discord snowflake: 17–20 digits. */
const SNOWFLAKE = /^\d{17,20}$/;

/** A quote id is a Mongo ObjectId; anything else can't name a stored quote. */
const QUOTE_ID = /^[a-f\d]{24}$/i;

export function createQuotesRouter(client: Client): Router {
  const router = Router();

  router.post(
    "/quotes/:id/edit",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const content = getString(req, "content");
      const authorId = normalizeUserId(getString(req, "author_id"));

      if (!content) {
        flashRedirect(res, QUOTES_PAGE, {
          type: "err",
          text: "Quote text is required.",
        });
        return;
      }
      if (!SNOWFLAKE.test(authorId)) {
        flashRedirect(res, QUOTES_PAGE, {
          type: "err",
          text: "Author must be a Discord user ID (17–20 digits).",
        });
        return;
      }

      try {
        const config = ConfigService.getInstance();
        const [enabled, maxLength] = await Promise.all([
          config.getBoolean("quotes.enabled", false),
          config.getNumber("quotes.max_length", 1000),
        ]);
        // Checked before the post is touched: `editQuote` enforces the same
        // cap, and failing there would leave the post showing text the row
        // never took.
        if (content.length > maxLength) {
          flashRedirect(res, QUOTES_PAGE, {
            type: "err",
            text: `Quote is too long. Maximum length is ${maxLength} characters (quotes.max_length).`,
          });
          return;
        }

        const quote = QUOTE_ID.test(id)
          ? await quoteService.getQuoteById(id)
          : null;
        if (!quote) {
          await recordAudit(session, {
            action: "quote.edit",
            targetId: id,
            result: "failure",
            errorMessage: "not found",
          });
          flashRedirect(res, QUOTES_PAGE, {
            type: "err",
            text: `Quote ${id} not found.`,
          });
          return;
        }

        // Redraw the channel post first, like `/quote edit`: a post that
        // can't be reached this time would otherwise keep showing the old
        // text while the row says otherwise. A post that no longer exists is
        // different — there is nothing to disagree with, so the row is saved
        // and Resync reposts it.
        let postMissing = false;
        if (enabled) {
          try {
            await QuoteChannelManager.getInstance(client).updateQuoteMessage(
              quote.messageId,
              id,
              content,
              authorId,
              quote.addedById,
              quote.postChannelId,
            );
          } catch (err) {
            if (!isMissingPostError(err)) throw err;
            postMissing = true;
          }
        }

        await quoteService.editQuote(id, content, authorId);
        await recordAudit(session, {
          action: "quote.edit",
          targetId: id,
          details: {
            authorChanged: normalizeUserId(quote.authorId) !== authorId,
            contentChanged: quote.content !== content,
            postUpdated: enabled && !postMissing,
            featureEnabled: enabled,
          },
          result: "success",
        });
        if (postMissing) {
          flashRedirect(res, QUOTES_PAGE, {
            type: "warn",
            text: `Updated quote ${id}, but its channel post no longer exists. Use Resync quote channel to repost it.`,
          });
          return;
        }
        flashRedirect(res, QUOTES_PAGE, {
          type: "ok",
          text: enabled
            ? `Updated quote ${id} and its channel post.`
            : `Updated quote ${id}. Its channel post was not changed while quotes.enabled is off.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Edit quote failed", err);
        await recordAudit(session, {
          action: "quote.edit",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, QUOTES_PAGE, {
          type: "err",
          text: `Failed to update quote ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/quotes/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      try {
        const quote = QUOTE_ID.test(id)
          ? await quoteService.getQuoteById(id)
          : null;
        if (!quote) {
          await recordAudit(session, {
            action: "quote.delete",
            targetId: id,
            result: "failure",
            errorMessage: "not found",
          });
          flashRedirect(res, QUOTES_PAGE, {
            type: "err",
            text: `Quote ${id} not found.`,
          });
          return;
        }
        // `deleteQuoteMessage` treats an already-gone post as removed and
        // returns false only when the post may still be up. The row goes
        // either way — the admin asked for the quote to be deleted — and the
        // flash says what is left behind.
        const postRemoved = await QuoteChannelManager.getInstance(
          client,
        ).deleteQuoteMessage(quote.messageId, quote.postChannelId);
        await quoteService.removeQuote(id);
        await recordAudit(session, {
          action: "quote.delete",
          targetId: id,
          details: { authorId: quote.authorId, postRemoved },
          result: "success",
        });
        if (!postRemoved) {
          flashRedirect(res, QUOTES_PAGE, {
            type: "warn",
            text: `Deleted quote ${id}, but its channel post could not be removed. Delete it in Discord or use Resync quote channel.`,
          });
          return;
        }
        flashRedirect(res, QUOTES_PAGE, {
          type: "ok",
          text: `Deleted quote ${id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete quote failed", err);
        await recordAudit(session, {
          action: "quote.delete",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, QUOTES_PAGE, {
          type: "err",
          text: `Failed to delete quote ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/quotes/sync",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      try {
        const enabled = await ConfigService.getInstance().getBoolean(
          "quotes.enabled",
          false,
        );
        if (!enabled) {
          flashRedirect(res, QUOTES_PAGE, {
            type: "err",
            text: "Enable quotes.enabled before resyncing the quote channel.",
          });
          return;
        }
        const { reposted } =
          await QuoteChannelManager.getInstance(client).resetChannel();
        await recordAudit(session, {
          action: "quote.sync",
          details: { reposted },
          result: "success",
        });
        flashRedirect(res, QUOTES_PAGE, {
          type: "ok",
          text: `Rebuilt the quote channel: ${reposted} quote${reposted === 1 ? "" : "s"} reposted.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Quote channel resync failed", err);
        await recordAudit(session, {
          action: "quote.sync",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, QUOTES_PAGE, {
          type: "err",
          text: `Failed to resync the quote channel: ${text}`,
        });
      }
    }),
  );

  // GET is exempt from CSRF; mounted on this router so requireSession runs.
  // The same backup `/quote export` attaches in Discord.
  router.get(
    "/quotes/export",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      try {
        const backup = await quoteService.exportQuotes();
        await recordAudit(session, {
          action: "quote.export",
          details: { quotes: backup.quotes.length },
          result: "success",
        });
        const filename = `quotes-backup-${new Date().toISOString().slice(0, 10)}.json`;
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        res.type("application/json").send(JSON.stringify(backup, null, 2));
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Quote export failed", err);
        await recordAudit(session, {
          action: "quote.export",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, QUOTES_PAGE, {
          type: "err",
          text: `Export failed: ${text}`,
        });
      }
    }),
  );

  return router;
}
