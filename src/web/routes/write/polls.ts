/**
 * Polls — schedules and the question library.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { PollService } from "../../../services/poll-service.js";
import type { IPollSchedule } from "../../../models/poll-schedule.js";
import type { IPollItem } from "../../../models/poll-item.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  getString,
  getCheckbox,
  normalizeCron,
  validCron,
  requireSessionContext,
  asyncHandler,
  Flash,
  TEXT_LIMITS,
} from "./helpers.js";

export function createPollsRouter(client: Client): Router {
  const router = Router();

  // ============================================================
  // Polls — schedules
  // ============================================================

  router.post(
    "/polls/schedules/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const channelId = getString(req, "channelId");
      const cron = normalizeCron(getString(req, "cron"));
      const durationRaw = getString(req, "durationHours");
      const pingRoleId = getString(req, "pingRoleId");

      if (!channelId || !cron) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Channel and cron are required.",
        });
        return;
      }
      const duration = Number.parseInt(durationRaw, 10);
      if (!Number.isFinite(duration) || duration < 1 || duration > 768) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Duration must be an integer between 1 and 768 hours.",
        });
        return;
      }
      if (!validCron(cron)) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Invalid cron expression: ${cron}`,
        });
        return;
      }

      const service = PollService.getInstance(client);
      try {
        const schedule = await service.createSchedule({
          guildId: session.guildId,
          channelId,
          cronSchedule: cron,
          pollDuration: duration,
          roleIdToPing: pingRoleId || null,
          enabled: true,
          createdBy: session.discordUserId,
        } as Omit<IPollSchedule, "createdAt" | "updatedAt" | "lastRun">);
        await recordAudit(session, {
          action: "poll-schedule.create",
          targetId: String(schedule._id),
          details: {
            channelId,
            cron,
            durationHours: duration,
            pingRoleId: pingRoleId || null,
          },
          result: "success",
        });
        flashRedirect(res, "/admin/polls", {
          type: "ok",
          text: `Created poll schedule ${schedule._id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "poll-schedule.create",
          details: { channelId, cron },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to create schedule: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/polls/schedules/:id/edit",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const channelId = getString(req, "channelId");
      const cron = normalizeCron(getString(req, "cron"));
      const durationRaw = getString(req, "durationHours");
      const pingRoleId = getString(req, "pingRoleId");

      if (!channelId || !cron) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Channel and cron are required.",
        });
        return;
      }
      const duration = Number.parseInt(durationRaw, 10);
      if (!Number.isFinite(duration) || duration < 1 || duration > 768) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Duration must be an integer between 1 and 768 hours.",
        });
        return;
      }
      if (!validCron(cron)) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Invalid cron expression: ${cron}`,
        });
        return;
      }

      const service = PollService.getInstance(client);
      try {
        const schedule = await service.updateSchedule(
          id,
          {
            channelId,
            cronSchedule: cron,
            pollDuration: duration,
            roleIdToPing: pingRoleId || null,
          },
          session.guildId,
        );
        if (!schedule) {
          await recordAudit(session, {
            action: "poll-schedule.edit",
            targetId: id,
            result: "failure",
            errorMessage: "not found or wrong guild",
          });
          flashRedirect(res, "/admin/polls", {
            type: "err",
            text: `Schedule ${id} not found.`,
          });
          return;
        }
        await recordAudit(session, {
          action: "poll-schedule.edit",
          targetId: id,
          details: {
            channelId,
            cron,
            durationHours: duration,
            pingRoleId: pingRoleId || null,
          },
          result: "success",
        });
        flashRedirect(res, "/admin/polls", {
          type: "ok",
          text: `Updated poll schedule ${id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "poll-schedule.edit",
          targetId: id,
          details: { channelId, cron },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to update schedule ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/polls/schedules/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      try {
        const ok = await service.deleteSchedule(id, session.guildId);
        await recordAudit(session, {
          action: "poll-schedule.delete",
          targetId: id,
          result: ok ? "success" : "failure",
          errorMessage: ok ? null : "not found or wrong guild",
        });
        flashRedirect(res, "/admin/polls", {
          type: ok ? "ok" : "err",
          text: ok
            ? `Deleted poll schedule ${id}.`
            : `Schedule ${id} not found.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete poll schedule failed", err);
        await recordAudit(session, {
          action: "poll-schedule.delete",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to delete schedule ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/polls/schedules/:id/toggle",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      const current = await service.getSchedule(id);
      if (!current || current.guildId !== session.guildId) {
        await recordAudit(session, {
          action: "poll-schedule.toggle",
          targetId: id,
          result: "failure",
          errorMessage: "not found or wrong guild",
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Schedule ${id} not found.`,
        });
        return;
      }
      const updated = await service.setScheduleEnabled(
        id,
        !current.enabled,
        session.guildId,
      );
      const ok = updated !== null;
      await recordAudit(session, {
        action: "poll-schedule.toggle",
        targetId: id,
        details: { enabled: !current.enabled },
        result: ok ? "success" : "failure",
      });
      flashRedirect(res, "/admin/polls", {
        type: ok ? "ok" : "err",
        text: ok
          ? `Schedule ${id} ${!current.enabled ? "enabled" : "disabled"}.`
          : `Failed to update schedule ${id}.`,
      });
    }),
  );

  router.post(
    "/polls/schedules/:id/test",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      const current = await service.getSchedule(id);
      if (!current || current.guildId !== session.guildId) {
        await recordAudit(session, {
          action: "poll-schedule.test",
          targetId: id,
          result: "failure",
          errorMessage: "not found or wrong guild",
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Schedule ${id} not found.`,
        });
        return;
      }
      try {
        await service.testSchedule(id);
        await recordAudit(session, {
          action: "poll-schedule.test",
          targetId: id,
          result: "success",
        });
        flashRedirect(res, "/admin/polls", {
          type: "ok",
          text: `Test poll posted from schedule ${id}. Check the configured channel.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "poll-schedule.test",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Test failed: ${text}`,
        });
      }
    }),
  );

  // ============================================================
  // Polls — question library
  // ============================================================

  router.post(
    "/polls/items/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const question = getString(req, "question");
      const answersStr = getString(req, "answers");
      const tagsStr = getString(req, "tags");
      const multiSelect = getCheckbox(req, "multiSelect");

      if (!question) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Question is required.",
        });
        return;
      }
      if (question.length > TEXT_LIMITS.pollQuestion) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Question must be ${TEXT_LIMITS.pollQuestion} characters or fewer.`,
        });
        return;
      }
      const answers = answersStr
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      if (answers.length < 2 || answers.length > 10) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Provide 2–10 comma-separated answers.",
        });
        return;
      }
      // Discord caps each poll answer (option) at 55 characters; reject an
      // oversized one here so it fails with a clean flash rather than being
      // stored and only rejected when Discord receives the payload (#508).
      if (answers.some((a) => a.length > TEXT_LIMITS.pollAnswer)) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Each answer must be ${TEXT_LIMITS.pollAnswer} characters or fewer.`,
        });
        return;
      }
      const tags = tagsStr
        ? tagsStr
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
        : [];

      const service = PollService.getInstance(client);
      try {
        const item = await service.createPollItem({
          guildId: session.guildId,
          question,
          answers,
          multiSelect,
          tags,
          enabled: true,
          createdBy: session.discordUserId,
          source: "manual",
        } as Omit<
          IPollItem,
          "createdAt" | "updatedAt" | "usageCount" | "lastUsed"
        >);
        await recordAudit(session, {
          action: "poll-item.create",
          targetId: String(item._id),
          details: {
            answerCount: answers.length,
            multiSelect,
            tagCount: tags.length,
          },
          result: "success",
        });
        flashRedirect(res, "/admin/polls", {
          type: "ok",
          text: `Added poll question ${item._id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "poll-item.create",
          details: { answerCount: answers.length },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to add question: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/polls/items/:id/edit",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const question = getString(req, "question");
      const answersStr = getString(req, "answers");
      const tagsStr = getString(req, "tags");
      const multiSelect = getCheckbox(req, "multiSelect");

      if (!question) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Question is required.",
        });
        return;
      }
      if (question.length > TEXT_LIMITS.pollQuestion) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Question must be ${TEXT_LIMITS.pollQuestion} characters or fewer.`,
        });
        return;
      }
      const answers = answersStr
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      if (answers.length < 2 || answers.length > 10) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Provide 2–10 comma-separated answers.",
        });
        return;
      }
      // Same 55-char poll-option cap the create route enforces (#508).
      if (answers.some((a) => a.length > TEXT_LIMITS.pollAnswer)) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Each answer must be ${TEXT_LIMITS.pollAnswer} characters or fewer.`,
        });
        return;
      }
      const tags = tagsStr
        ? tagsStr
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
        : [];

      const service = PollService.getInstance(client);
      try {
        const item = await service.updatePollItem(
          id,
          { question, answers, multiSelect, tags },
          session.guildId,
        );
        if (!item) {
          await recordAudit(session, {
            action: "poll-item.edit",
            targetId: id,
            result: "failure",
            errorMessage: "not found or wrong guild",
          });
          flashRedirect(res, "/admin/polls", {
            type: "err",
            text: `Question ${id} not found.`,
          });
          return;
        }
        await recordAudit(session, {
          action: "poll-item.edit",
          targetId: id,
          details: {
            answerCount: answers.length,
            multiSelect,
            tagCount: tags.length,
          },
          result: "success",
        });
        flashRedirect(res, "/admin/polls", {
          type: "ok",
          text: `Updated poll question ${id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "poll-item.edit",
          targetId: id,
          details: { answerCount: answers.length },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to update question ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/polls/items/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      try {
        const ok = await service.deletePollItem(id, session.guildId);
        await recordAudit(session, {
          action: "poll-item.delete",
          targetId: id,
          result: ok ? "success" : "failure",
          errorMessage: ok ? null : "not found or wrong guild",
        });
        flashRedirect(res, "/admin/polls", {
          type: ok ? "ok" : "err",
          text: ok
            ? `Deleted poll question ${id}.`
            : `Question ${id} not found.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete poll item failed", err);
        await recordAudit(session, {
          action: "poll-item.delete",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to delete question ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/polls/items/:id/toggle",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      const items = await service.listPollItems(session.guildId);
      const current = items.find((it) => String(it._id) === id);
      if (!current) {
        await recordAudit(session, {
          action: "poll-item.toggle",
          targetId: id,
          result: "failure",
          errorMessage: "not found or wrong guild",
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Question ${id} not found.`,
        });
        return;
      }
      const updated = await service.setPollItemEnabled(
        id,
        !current.enabled,
        session.guildId,
      );
      const ok = updated !== null;
      await recordAudit(session, {
        action: "poll-item.toggle",
        targetId: id,
        details: { enabled: !current.enabled },
        result: ok ? "success" : "failure",
      });
      flashRedirect(res, "/admin/polls", {
        type: ok ? "ok" : "err",
        text: ok
          ? `Question ${id} ${!current.enabled ? "enabled" : "disabled"}.`
          : `Failed to update question ${id}.`,
      });
    }),
  );

  // Import a poll library from content the admin pastes into the textarea or
  // loads from a local file in the browser (#646). There is no URL/fetch path:
  // the YAML/JSON arrives straight from the authenticated admin's browser, so
  // there is no outbound request to forge and no host allowlist to maintain.
  // The parse/validate/dedup loop lives in PollService.importFromString.
  router.post(
    "/polls/items/import-text",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const content = getString(req, "content");
      if (!content) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Paste some YAML or JSON poll content to import.",
        });
        return;
      }
      const service = PollService.getInstance(client);
      try {
        const results = await service.importFromString(
          content,
          session.guildId,
          session.discordUserId,
          "paste",
        );
        const errCount = results.errors.length;
        const type: Flash["type"] =
          results.imported > 0 && errCount === 0
            ? "ok"
            : results.imported > 0
              ? "warn"
              : "err";
        const summary = `Imported ${results.imported}, skipped ${results.skipped}, errors ${errCount}.`;
        const firstError =
          errCount > 0 ? ` First error: ${results.errors[0]}` : "";
        await recordAudit(session, {
          action: "poll-item.import",
          details: {
            source: "paste",
            imported: results.imported,
            skipped: results.skipped,
            errors: errCount,
          },
          result:
            errCount > 0 && results.imported === 0 ? "failure" : "success",
          errorMessage:
            errCount > 0 ? results.errors.slice(0, 5).join("; ") : null,
        });
        flashRedirect(res, "/admin/polls", {
          type,
          text: `${summary}${firstError}`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Poll paste import failed", err);
        await recordAudit(session, {
          action: "poll-item.import",
          details: { source: "paste" },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Import failed: ${text}`,
        });
      }
    }),
  );

  return router;
}
