/**
 * Scheduled announcements — create/update/delete/toggle/send-now.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { ScheduledAnnouncementService } from "../../../services/scheduled-announcement-service.js";
import { VoiceChannelAnnouncer } from "../../../services/voice-channel-announcer.js";
import type { IScheduledAnnouncement } from "../../../models/scheduled-announcement.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  getString,
  getCheckbox,
  normalizeCron,
  validCron,
  parseHexColor,
  requireSessionContext,
  asyncHandler,
  TEXT_LIMITS,
  firstLengthError,
} from "./helpers.js";

export function createAnnouncementsRouter(client: Client): Router {
  const router = Router();

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
      // Reject oversized text up front so the operator gets a readable flash
      // rather than a Discord rejection at send time or a Mongoose error (#508).
      const lengthError = firstLengthError([
        {
          label: "Message",
          value: message,
          max: TEXT_LIMITS.announcementMessage,
        },
        {
          label: "Embed title",
          value: embedTitle,
          max: TEXT_LIMITS.embedTitle,
        },
        {
          label: "Embed description",
          value: embedDescription,
          max: TEXT_LIMITS.embedDescription,
        },
      ]);
      if (lengthError) {
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: lengthError,
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
    "/announcements/:id/post-now",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = ScheduledAnnouncementService.getInstance(client);
      try {
        const ok = await service.postAnnouncementNow(id, session.guildId);
        await recordAudit(session, {
          action: "announcement.post-now",
          targetId: id,
          result: ok ? "success" : "failure",
          errorMessage: ok ? null : "not found or wrong guild",
        });
        flashRedirect(res, "/admin/announcements", {
          type: ok ? "ok" : "err",
          text: ok
            ? `Posted announcement ${id}. Check the configured channel.`
            : `Announcement ${id} not found.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Manual announcement post failed", err);
        await recordAudit(session, {
          action: "announcement.post-now",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Failed to post announcement ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/announcements/post-once",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const channelId = getString(req, "channelId");
      const message = getString(req, "message");
      const placeholders = getCheckbox(req, "placeholders");
      const embedTitle = getString(req, "embedTitle");
      const embedDescription = getString(req, "embedDescription");
      const embedColorHex = getString(req, "embedColor");

      if (!channelId || !message) {
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: "Channel and message are both required.",
        });
        return;
      }
      // Reject oversized text up front, mirroring the create route (#508).
      const lengthError = firstLengthError([
        {
          label: "Message",
          value: message,
          max: TEXT_LIMITS.announcementMessage,
        },
        {
          label: "Embed title",
          value: embedTitle,
          max: TEXT_LIMITS.embedTitle,
        },
        {
          label: "Embed description",
          value: embedDescription,
          max: TEXT_LIMITS.embedDescription,
        },
      ]);
      if (lengthError) {
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: lengthError,
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
        await service.postOnce({
          guildId: session.guildId,
          channelId,
          message,
          embedData,
          placeholders,
        });
        await recordAudit(session, {
          action: "announcement.post-once",
          details: { channelId, placeholders, hasEmbed: !!embedData },
          result: "success",
        });
        flashRedirect(res, "/admin/announcements", {
          type: "ok",
          text: "One-off announcement posted. Check the configured channel.",
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("One-off announcement post failed", err);
        await recordAudit(session, {
          action: "announcement.post-once",
          details: { channelId, placeholders },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Failed to post announcement: ${text}`,
        });
      }
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

  return router;
}
