/**
 * Voice channels — cleanup actions.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { VoiceChannelManager } from "../../../services/voice-channel-manager.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  requireSessionContext,
  asyncHandler,
} from "./helpers.js";

export function createVoiceChannelsRouter(client: Client): Router {
  const router = Router();

  // ============================================================
  // Voice Channels (issue #384)
  // ============================================================

  router.post(
    "/voice-channels/force-reload",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const manager = VoiceChannelManager.getInstance(client);
      try {
        // The sweep no-ops (without throwing) when voice management is
        // disabled or misconfigured, e.g. the lobby cannot be brought online
        // (#843); tell the admin rather than claim channels were removed.
        const swept = await manager.cleanupEmptyChannels();
        const guild = await client.guilds.fetch(session.guildId);
        const lobbyEnsured = await manager.ensureLobbyChannels(guild);
        // cleanupEmptyChannels() returns false both when it never ran and
        // when it ran but could not finish, so word this as "did not
        // complete" rather than asserting nothing happened.
        const skipped = [
          ...(swept ? [] : ["the cleanup sweep did not complete"]),
          ...(lobbyEnsured ? [] : ["the lobby could not be ensured"]),
        ];
        await recordAudit(session, {
          action: "voicechannels.force-reload",
          result: skipped.length === 0 ? "success" : "failure",
          ...(skipped.length > 0 && { errorMessage: skipped.join("; ") }),
          details: { swept, lobbyEnsured },
        });
        flashRedirect(
          res,
          "/admin/voice-channels",
          skipped.length === 0
            ? {
                type: "ok",
                text: "Force cleanup complete. Empty unmanaged channels removed (occupied ones are kept until they empty) and the lobby ensured.",
              }
            : {
                type: "warn",
                text: `Force cleanup incomplete: ${skipped.join(" and ")}. Voice channel management is disabled or misconfigured — check the bot logs.`,
              },
        );
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
