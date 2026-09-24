/**
 * Birthdays — correct or remove a member's stored birthday and run the
 * birthday check on demand (#986).
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { BirthdayService } from "../../../services/birthday-service.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  getCheckbox,
  getString,
  parseIntInRange,
  requireSessionContext,
  asyncHandler,
} from "./helpers.js";

const BIRTHDAYS_PAGE = "/admin/birthdays";

/** A Discord snowflake: 17–20 digits. */
const SNOWFLAKE = /^\d{17,20}$/;

export function createBirthdaysRouter(client: Client): Router {
  const router = Router();

  router.post(
    "/birthdays/:userId/edit",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const userId = String(req.params.userId);
      const month = parseIntInRange(getString(req, "month"), 1, 12);
      const day = parseIntInRange(getString(req, "day"), 1, 31);
      const clearYear = getCheckbox(req, "clear_year");

      if (!SNOWFLAKE.test(userId)) {
        flashRedirect(res, BIRTHDAYS_PAGE, {
          type: "err",
          text: "Member must be a Discord user ID (17–20 digits).",
        });
        return;
      }
      if (month === null || day === null) {
        flashRedirect(res, BIRTHDAYS_PAGE, {
          type: "err",
          text: "Choose a month and a day.",
        });
        return;
      }

      try {
        // A strict read: `getBirthday` turns a read error into "not set",
        // which would report an outage as a missing entry.
        const result = await BirthdayService.getInstance(client).editBirthday(
          userId,
          session.guildId,
          { month, day, clearYear },
        );
        if (!result) {
          await recordAudit(session, {
            action: "birthday.edit",
            targetId: userId,
            result: "failure",
            errorMessage: "not found",
          });
          flashRedirect(res, BIRTHDAYS_PAGE, {
            type: "err",
            text: `No birthday is stored for ${userId}.`,
          });
          return;
        }
        const { before, after } = result;
        // The audit log is admin-readable, so it records whether a year is on
        // file rather than the year itself — the same line the page draws.
        await recordAudit(session, {
          action: "birthday.edit",
          targetId: userId,
          details: {
            before: {
              month: before.month,
              day: before.day,
              hasYear: before.year !== null,
            },
            after: {
              month: after.month,
              day: after.day,
              hasYear: after.year !== null,
            },
          },
          result: "success",
        });
        flashRedirect(res, BIRTHDAYS_PAGE, {
          type: "ok",
          text: `Saved ${userId}'s birthday as ${after.month}/${after.day}${clearYear && before.year !== null ? " and removed the birth year" : ""}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Edit birthday failed", err);
        await recordAudit(session, {
          action: "birthday.edit",
          targetId: userId,
          details: { attempted: { month, day, clearYear } },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, BIRTHDAYS_PAGE, {
          type: "err",
          text: `Failed to update ${userId}'s birthday: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/birthdays/:userId/remove",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const userId = String(req.params.userId);
      if (!SNOWFLAKE.test(userId)) {
        flashRedirect(res, BIRTHDAYS_PAGE, {
          type: "err",
          text: "Member must be a Discord user ID (17–20 digits).",
        });
        return;
      }

      // The same erasure the member's own data reset runs (#916), not a raw
      // delete: the row is the only record of the birthday role and of the
      // posts the bot made about the member, so both are undone first and
      // the row is kept whenever either could not be.
      const result = await BirthdayService.getInstance(client).purgeForUser(
        session.guildId,
        userId,
      );
      const details = {
        removed: result.removed,
        roleRevoked: result.roleRevoked,
        announcementsDeleted: result.announcementsDeleted,
        announcementsFailed: result.announcementsFailed,
      };

      if (result.matched === 0 && !result.error) {
        await recordAudit(session, {
          action: "birthday.remove",
          targetId: userId,
          result: "failure",
          errorMessage: "not found",
        });
        flashRedirect(res, BIRTHDAYS_PAGE, {
          type: "err",
          text: `No birthday is stored for ${userId}.`,
        });
        return;
      }

      if (result.error || result.removed === 0) {
        const text = result.error ?? "the row was not removed";
        await recordAudit(session, {
          action: "birthday.remove",
          targetId: userId,
          details,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, BIRTHDAYS_PAGE, {
          type: "err",
          text: `Could not fully remove ${userId}'s birthday: ${text}. Try again.`,
        });
        return;
      }

      await recordAudit(session, {
        action: "birthday.remove",
        targetId: userId,
        details,
        result: "success",
      });
      const extras: string[] = [];
      if (result.roleRevoked) extras.push("took back the birthday role");
      if (result.announcementsDeleted > 0) {
        extras.push(
          `deleted ${result.announcementsDeleted} birthday post${result.announcementsDeleted === 1 ? "" : "s"}`,
        );
      }
      flashRedirect(res, BIRTHDAYS_PAGE, {
        type: "ok",
        text: `Removed ${userId}'s birthday${extras.length > 0 ? ` and ${extras.join(" and ")}` : ""}.`,
      });
    }),
  );

  router.post(
    "/birthdays/run-now",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      try {
        const summary = await BirthdayService.getInstance(client).runNow();
        if (!summary) {
          // Null when the feature is off, or when the run aborted before
          // looking at anyone: GUILD_ID or the channel is unset or unusable.
          await recordAudit(session, {
            action: "birthday.run-now",
            result: "failure",
            errorMessage: "birthdays disabled or channel unavailable",
          });
          flashRedirect(res, BIRTHDAYS_PAGE, {
            type: "warn",
            text: "The birthday check did not run — birthdays.enabled is off, or the announcement channel is unset or unreachable. Check the bot's logs.",
          });
          return;
        }
        await recordAudit(session, {
          action: "birthday.run-now",
          details: {
            candidates: summary.candidates,
            announced: summary.announced,
            rolesGranted: summary.rolesGranted,
            rolesRemoved: summary.rolesRemoved,
            failed: summary.failed,
          },
          result: summary.failed > 0 ? "failure" : "success",
          errorMessage:
            summary.failed > 0 ? `${summary.failed} member(s) failed` : null,
        });
        flashRedirect(res, BIRTHDAYS_PAGE, {
          type: summary.failed > 0 ? "warn" : "ok",
          text: `Birthday check ran. ${summary.announced} announced · ${summary.rolesGranted} roles granted · ${summary.rolesRemoved} roles removed · ${summary.failed} failed.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Birthday run-now failed", err);
        await recordAudit(session, {
          action: "birthday.run-now",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, BIRTHDAYS_PAGE, {
          type: "err",
          text: `Birthday check failed: ${text}`,
        });
      }
    }),
  );

  return router;
}
