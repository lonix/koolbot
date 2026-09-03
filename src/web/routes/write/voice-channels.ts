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
