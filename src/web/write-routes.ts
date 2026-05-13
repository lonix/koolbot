/**
 * State-changing route handlers for the WebUI (issues #383 and #384).
 * Mounted onto the WebUI router behind `requireSession` and
 * `requireCsrf`. Every handler is a thin wrapper around an existing
 * service — there is no business logic here. Each write records exactly
 * one audit entry via `recordAudit()`.
 */

import {
  Router,
  type NextFunction,
  type RequestHandler,
  type Response,
} from "express";
import { Client } from "discord.js";
import { CronTime } from "cron";
import logger from "../utils/logger.js";
import { ScheduledAnnouncementService } from "../services/scheduled-announcement-service.js";
import { PollService } from "../services/poll-service.js";
import { VoiceChannelAnnouncer } from "../services/voice-channel-announcer.js";
import { ReactionRoleService } from "../services/reaction-role-service.js";
import { NoticesChannelManager } from "../services/notices-channel-manager.js";
import { VoiceChannelTruncationService } from "../services/voice-channel-truncation.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";
import { ConfigService } from "../services/config-service.js";
import type { IScheduledAnnouncement } from "../models/scheduled-announcement.js";
import type { IPollSchedule } from "../models/poll-schedule.js";
import type { IPollItem } from "../models/poll-item.js";
import Notice from "../models/notice.js";
import { NOTICE_CATEGORIES } from "../content/notice-categories.js";
import { requireCsrf } from "./csrf.js";
import type { AuthenticatedRequest } from "./session.js";
import { recordAudit } from "./audit.js";

type Flash = { type: "ok" | "warn" | "err"; text: string };

const FLASH_MAX = 500;

function flashRedirect(res: Response, path: string, flash: Flash): void {
  // Mirror the renderer's 500-char cap on the way out so the redirect
  // URL itself can't balloon to header/URI limits on a noisy failure.
  const truncated =
    flash.text.length > FLASH_MAX
      ? `${flash.text.slice(0, FLASH_MAX - 1)}…`
      : flash.text;
  const qs = new globalThis.URLSearchParams({
    flash: flash.type,
    msg: truncated,
  }).toString();
  res.redirect(303, `${path}?${qs}`);
}

function getString(req: AuthenticatedRequest, name: string): string {
  const raw = (req.body as Record<string, unknown> | undefined)?.[name];
  if (typeof raw !== "string") return "";
  return raw.trim();
}

function getCheckbox(req: AuthenticatedRequest, name: string): boolean {
  const raw = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof raw === "string" && raw.length > 0;
}

function parseIntInRange(raw: string, min: number, max: number): number | null {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * Normalize a cron expression: trim wrapping quotes so we validate and
 * persist the same form. Otherwise `"0 9 * * *"` would pass validation
 * (which strips quotes internally) but get stored verbatim, and later
 * fail when the cron job is actually scheduled from the database row.
 */
function normalizeCron(expr: string): string {
  return expr.replace(/^["']|["']$/g, "").trim();
}

function validCron(expr: string): boolean {
  try {
    new CronTime(expr);
    return true;
  } catch {
    return false;
  }
}

function parseHexColor(input: string): number | null {
  const match = input.match(/^#?([0-9A-Fa-f]{6})$/);
  if (!match) return null;
  return parseInt(match[1], 16);
}

function requireSessionContext(req: AuthenticatedRequest): {
  guildId: string;
  discordUserId: string;
  sessionId: string;
  scopes: string[];
  lastActivityAt: number;
  expiresAt: Date;
} {
  if (!req.webSession) {
    throw new Error("requireSession middleware must run first");
  }
  return req.webSession;
}

function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction): void => {
    fn(req as AuthenticatedRequest, res).catch(next);
  };
}

export function createWriteRouter(
  client: Client,
  requireSession: RequestHandler,
): Router {
  const router = Router();
  router.use(requireSession);
  router.use(requireCsrf);

  // ============================================================
  // Announcements
  // ============================================================

  router.post(
    "/announcements/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const channelId = getString(req, "channelId");
      const cron = normalizeCron(getString(req, "cron"));
      const message = getString(req, "message");
      const placeholders = getCheckbox(req, "placeholders");
      const embedTitle = getString(req, "embedTitle");
      const embedDescription = getString(req, "embedDescription");
      const embedColorHex = getString(req, "embedColor");

      if (!channelId || !cron || !message) {
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: "Channel, cron and message are all required.",
        });
        return;
      }
      if (!validCron(cron)) {
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Invalid cron expression: ${cron}`,
        });
        return;
      }

      let embedData: IScheduledAnnouncement["embedData"] | undefined;
      if (embedTitle || embedDescription || embedColorHex) {
        let color: number | undefined;
        if (embedColorHex) {
          const parsed = parseHexColor(embedColorHex);
          if (parsed === null) {
            flashRedirect(res, "/admin/announcements", {
              type: "err",
              text: `Invalid hex colour: ${embedColorHex}`,
            });
            return;
          }
          color = parsed;
        }
        embedData = {
          title: embedTitle || undefined,
          description: embedDescription || undefined,
          color,
        };
      }

      const service = ScheduledAnnouncementService.getInstance(client);
      try {
        const announcement = await service.createAnnouncement({
          guildId: session.guildId,
          channelId,
          cronSchedule: cron,
          message,
          embedData,
          placeholders,
          enabled: true,
          createdBy: session.discordUserId,
        } as Omit<IScheduledAnnouncement, "createdAt" | "updatedAt">);
        await recordAudit(session, {
          action: "announcement.create",
          targetId: String(announcement._id),
          details: { channelId, cron, placeholders, hasEmbed: !!embedData },
          result: "success",
        });
        flashRedirect(res, "/admin/announcements", {
          type: "ok",
          text: `Created announcement ${announcement._id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "announcement.create",
          details: { channelId, cron, placeholders },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Failed to create announcement: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/announcements/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = ScheduledAnnouncementService.getInstance(client);
      try {
        const ok = await service.deleteAnnouncement(id, session.guildId);
        await recordAudit(session, {
          action: "announcement.delete",
          targetId: id,
          result: ok ? "success" : "failure",
          errorMessage: ok ? null : "not found or wrong guild",
        });
        flashRedirect(res, "/admin/announcements", {
          type: ok ? "ok" : "err",
          text: ok
            ? `Deleted announcement ${id}.`
            : `Announcement ${id} not found.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete announcement failed", err);
        await recordAudit(session, {
          action: "announcement.delete",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Failed to delete announcement ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/announcements/:id/toggle",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = ScheduledAnnouncementService.getInstance(client);
      const current = await service.getAnnouncement(id);
      if (!current || current.guildId !== session.guildId) {
        await recordAudit(session, {
          action: "announcement.toggle",
          targetId: id,
          result: "failure",
          errorMessage: "not found or wrong guild",
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Announcement ${id} not found.`,
        });
        return;
      }
      const updated = await service.setAnnouncementEnabled(
        id,
        !current.enabled,
        session.guildId,
      );
      const ok = updated !== null;
      await recordAudit(session, {
        action: "announcement.toggle",
        targetId: id,
        details: { enabled: !current.enabled },
        result: ok ? "success" : "failure",
      });
      flashRedirect(res, "/admin/announcements", {
        type: ok ? "ok" : "err",
        text: ok
          ? `Announcement ${id} ${!current.enabled ? "enabled" : "disabled"}.`
          : `Failed to update announcement ${id}.`,
      });
    }),
  );

  router.post(
    "/announcements/post-vc-stats",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const announcer = VoiceChannelAnnouncer.getInstance(client);
      try {
        await announcer.makeAnnouncement();
        await recordAudit(session, {
          action: "announcement.post-vc-stats",
          result: "success",
        });
        flashRedirect(res, "/admin/announcements", {
          type: "ok",
          text: "Weekly VC stats announcement triggered. Check the configured channel.",
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Manual VC stats announcement failed", err);
        await recordAudit(session, {
          action: "announcement.post-vc-stats",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Failed to post: ${text}`,
        });
      }
    }),
  );

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
      if (question.length > 300) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Question must be 300 characters or fewer.",
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

  router.post(
    "/polls/items/import",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const url = getString(req, "url");
      if (!url) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "URL is required.",
        });
        return;
      }
      const service = PollService.getInstance(client);
      try {
        const results = await service.importFromUrl(
          url,
          session.guildId,
          session.discordUserId,
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
            url,
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
        logger.error("Poll import failed", err);
        await recordAudit(session, {
          action: "poll-item.import",
          details: { url },
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

  // ============================================================
  // Reaction Roles (issue #384)
  // ============================================================

  router.post(
    "/reaction-roles/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const name = getString(req, "name");
      const emoji = getString(req, "emoji");

      if (!name || !emoji) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Role name and emoji are both required.",
        });
        return;
      }

      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.createReactionRole(
          session.guildId,
          name,
          emoji,
        );
        await recordAudit(session, {
          action: "reactionrole.create",
          targetId: result.roleId ?? null,
          details: {
            roleName: name,
            emoji,
            categoryId: result.categoryId,
            channelId: result.channelId,
            messageId: result.messageId,
          },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Create reaction role failed", err);
        await recordAudit(session, {
          action: "reactionrole.create",
          details: { roleName: name, emoji },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to create reaction role: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/reaction-roles/archive",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const roleName = getString(req, "roleName");
      if (!roleName) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Role name is required.",
        });
        return;
      }
      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.archiveReactionRole(
          session.guildId,
          roleName,
        );
        await recordAudit(session, {
          action: "reactionrole.archive",
          targetId: roleName,
          details: { roleName },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Archive reaction role failed", err);
        await recordAudit(session, {
          action: "reactionrole.archive",
          targetId: roleName,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to archive ${roleName}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/reaction-roles/unarchive",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const roleName = getString(req, "roleName");
      if (!roleName) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Role name is required.",
        });
        return;
      }
      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.unarchiveReactionRole(
          session.guildId,
          roleName,
        );
        await recordAudit(session, {
          action: "reactionrole.unarchive",
          targetId: roleName,
          details: { roleName },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Unarchive reaction role failed", err);
        await recordAudit(session, {
          action: "reactionrole.unarchive",
          targetId: roleName,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to unarchive ${roleName}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/reaction-roles/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const roleName = getString(req, "roleName");
      if (!roleName) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Role name is required.",
        });
        return;
      }
      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.deleteReactionRole(
          session.guildId,
          roleName,
        );
        await recordAudit(session, {
          action: "reactionrole.delete",
          targetId: roleName,
          details: { roleName },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete reaction role failed", err);
        await recordAudit(session, {
          action: "reactionrole.delete",
          targetId: roleName,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to delete ${roleName}: ${text}`,
        });
      }
    }),
  );

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
      if (title.length > 256) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Title must be 256 characters or fewer.",
        });
        return;
      }
      if (content.length > 4000) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Content must be 4000 characters or fewer.",
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
        flashRedirect(res, "/admin/notices", {
          type: "ok",
          text: enabled
            ? `Created notice ${notice._id} and posted to channel.`
            : `Created notice ${notice._id}. Enable notices.enabled to post it to a channel.`,
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
        if (enabled) {
          const manager = NoticesChannelManager.getInstance(client);
          if (notice.messageId) {
            await manager.deleteNoticeMessage(notice.messageId);
          }
          const newMessageId = await manager.postNotice(notice);
          if (newMessageId) {
            notice.messageId = newMessageId;
            await notice.save();
          }
        }

        await recordAudit(session, {
          action: "notice.update",
          targetId: id,
          details: { title, category, order, reposted: enabled },
          result: "success",
        });
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

  // ============================================================
  // Database — dbtrunk (issue #384)
  // ============================================================

  router.post(
    "/database/run-cleanup",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const service = VoiceChannelTruncationService.getInstance(client);
      try {
        const stats = await service.runCleanup();
        const skipped =
          stats.errors.length === 1 &&
          stats.errors[0] === "Cleanup skipped: minimum interval not met";
        const hasErrors = stats.errors.length > 0 && !skipped;
        await recordAudit(session, {
          action: "dbtrunk.run",
          details: {
            sessionsRemoved: stats.sessionsRemoved,
            dataAggregated: stats.dataAggregated,
            executionTime: stats.executionTime,
            errors: hasErrors ? stats.errors.length : 0,
            skipped,
          },
          result: hasErrors ? "failure" : "success",
          errorMessage: hasErrors ? stats.errors.slice(0, 3).join("; ") : null,
        });
        if (skipped) {
          flashRedirect(res, "/admin/database", {
            type: "warn",
            text: "Cleanup skipped: 24-hour minimum interval not met since the last run.",
          });
          return;
        }
        if (hasErrors) {
          flashRedirect(res, "/admin/database", {
            type: "err",
            text: `Cleanup finished with errors: ${stats.errors.slice(0, 3).join("; ")}`,
          });
          return;
        }
        flashRedirect(res, "/admin/database", {
          type: "ok",
          text: `Cleanup complete. Removed ${stats.sessionsRemoved} sessions across ${stats.dataAggregated} users in ${stats.executionTime}ms.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("dbtrunk run failed", err);
        await recordAudit(session, {
          action: "dbtrunk.run",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/database", {
          type: "err",
          text: `Cleanup failed: ${text}`,
        });
      }
    }),
  );

  // ============================================================
  // Voice Channels (issue #384)
  // ============================================================

  router.post(
    "/voice-channels/reload",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const manager = VoiceChannelManager.getInstance(client);
      try {
        await manager.cleanupEmptyChannels();
        await recordAudit(session, {
          action: "voicechannels.reload",
          result: "success",
        });
        flashRedirect(res, "/admin/voice-channels", {
          type: "ok",
          text: "Cleaned up empty voice channels.",
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("VC reload failed", err);
        await recordAudit(session, {
          action: "voicechannels.reload",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/voice-channels", {
          type: "err",
          text: `Cleanup failed: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/voice-channels/force-reload",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const manager = VoiceChannelManager.getInstance(client);
      try {
        await manager.cleanupEmptyChannels();
        const guild = await client.guilds.fetch(session.guildId);
        await manager.ensureLobbyChannels(guild);
        await recordAudit(session, {
          action: "voicechannels.force-reload",
          result: "success",
        });
        flashRedirect(res, "/admin/voice-channels", {
          type: "ok",
          text: "Force cleanup complete. Unmanaged channels removed and lobby channels ensured.",
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("VC force-reload failed", err);
        await recordAudit(session, {
          action: "voicechannels.force-reload",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/voice-channels", {
          type: "err",
          text: `Force cleanup failed: ${text}`,
        });
      }
    }),
  );

  return router;
}
