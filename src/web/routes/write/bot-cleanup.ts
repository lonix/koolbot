/**
 * Cleanup after a removed bot (#1179), part of the server-adoption work.
 *
 * Mounted by `createWriteRouter` behind `requireSession`, the admin check and
 * `requireCsrf`. `GET /adopt/cleanup` lists the removed bots found in a fresh
 * scan and, when asked, previews removing the chosen permission overwrites.
 * `POST /adopt/cleanup/apply` plans the same choice again, refuses if the
 * server changed since the preview, and hands the plan to the adoption engine
 * (snapshot first; rollback lives on Adoption history). KoolBot never removes
 * the bot itself and nothing here archives or deletes a channel.
 */

import { Router } from "express";
import { Client, type Guild } from "discord.js";
import logger from "../../../utils/logger.js";
import {
  cleanupPlanIsApplicable,
  cleanupRevalidator,
  findRemovedBotCandidates,
  planBotCleanup,
  type BotCleanupPlan,
} from "../../../services/bot-removal-cleanup.js";
import { ServerScanService } from "../../../services/server-scan-service.js";
import { ServerAdoptionService } from "../../../services/server-adoption-service.js";
import {
  DESTRUCTIVE_CONFIRM_FIELD,
  hasDestructiveSteps,
} from "../../adoption-diff.js";
import { recordAudit } from "../../audit.js";
import { getDisplayedRemainingMs } from "../../admin-layout.js";
import type { FlashMessage } from "../../admin-views.js";
import {
  BOT_CLEANUP_PATH,
  renderBotCleanupPage,
} from "../../bot-cleanup-view.js";
import {
  asyncHandler,
  flashRedirect,
  getCheckbox,
  getCsrfFromReq,
  navStatusForPage,
  requireSessionContext,
} from "./helpers.js";

const SNOWFLAKE = /^\d{5,25}$/;
/** A preview older than this must be made again before it is applied. */
export const CLEANUP_PREVIEW_TTL_MS = 30 * 60 * 1000;

function readFlash(req: {
  query: Record<string, unknown>;
}): FlashMessage | null {
  const type = String(req.query.flash ?? "");
  const text = String(req.query.msg ?? "");
  if (!text || (type !== "ok" && type !== "warn" && type !== "err"))
    return null;
  return { type, text: text.slice(0, 500) };
}

function one(source: Record<string, unknown>, key: string): string {
  const raw = source[key];
  return typeof raw === "string" ? raw : "";
}

/** The chosen channel ids from a query string or form body (ids only). */
export function parseChannelIds(source: Record<string, unknown>): string[] {
  const raw = source["ch"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return [
    ...new Set(
      list.filter(
        (v): v is string => typeof v === "string" && SNOWFLAKE.test(v),
      ),
    ),
  ];
}

/**
 * The preview stamp an apply may use: a valid time that is not in the future
 * and not older than the preview window. Null otherwise.
 */
export function parsePreviewStamp(
  raw: string,
  now: number = Date.now(),
): string | null {
  const t = Date.parse(raw);
  if (Number.isNaN(t) || t > now + 60_000 || now - t > CLEANUP_PREVIEW_TTL_MS) {
    return null;
  }
  return new Date(t).toISOString() === raw ? raw : null;
}

export function createBotCleanupRouter(client: Client): Router {
  const router = Router();

  async function fetchGuild(guildId: string): Promise<Guild | null> {
    try {
      return await client.guilds.fetch(guildId);
    } catch (error) {
      logger.warn("bot cleanup: guild fetch failed", error);
      return null;
    }
  }

  router.get(
    "/adopt/cleanup",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const query = req.query as Record<string, unknown>;
      const botRaw = one(query, "bot");
      const botId = SNOWFLAKE.test(botRaw) ? botRaw : null;
      const sampled = query["sample"] === "1";
      const selected = parseChannelIds(query);
      const guild = await fetchGuild(session.guildId);
      let candidates = null;
      let planned: BotCleanupPlan | null = null;
      let error: string | undefined;
      const approvedAt = new Date().toISOString();
      if (!guild) {
        error = "Discord couldn't be reached.";
      } else {
        try {
          if (botId && query["preview"] !== undefined) {
            planned = await planBotCleanup(
              guild,
              session.discordUserId,
              botId,
              selected,
              approvedAt,
              { sampleMessages: sampled },
            );
            candidates = findRemovedBotCandidates(planned.scan);
          } else {
            const scan = await ServerScanService.getInstance(client).scanGuild(
              guild,
              { adminUserId: session.discordUserId, sampleMessages: sampled },
            );
            candidates = findRemovedBotCandidates(scan);
          }
        } catch (err) {
          logger.warn("bot cleanup: scan failed", err);
          candidates = null;
          planned = null;
          error = err instanceof Error ? err.message : String(err);
        }
      }
      const jobParam = query["job"];
      res.type("text/html").send(
        renderBotCleanupPage({
          csrfToken: getCsrfFromReq(req),
          remainingMs: getDisplayedRemainingMs(session),
          navFeatureStatus: await navStatusForPage(),
          botId,
          candidates,
          planned,
          selectedChannelIds: planned ? planned.channelIds : selected,
          sampled,
          approvedAt: planned ? approvedAt : null,
          error,
          jobId:
            typeof jobParam === "string" && /^[0-9a-f-]{36}$/i.test(jobParam)
              ? jobParam
              : null,
          flash: readFlash(req),
        }),
      );
    }),
  );

  router.post(
    "/adopt/cleanup/apply",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const planId = one(body, "planId");
      const botId = one(body, "bot");
      const sampled = body["sample"] === "1";
      const channelIds = parseChannelIds(body);
      const approvedAt = parsePreviewStamp(one(body, "at"));
      if (!SNOWFLAKE.test(botId) || !approvedAt) {
        flashRedirect(res, BOT_CLEANUP_PATH, {
          type: "warn",
          text: "That preview expired or is incomplete. Preview the cleanup again, then apply.",
        });
        return;
      }
      const guild = await fetchGuild(session.guildId);
      if (!guild) {
        flashRedirect(res, BOT_CLEANUP_PATH, {
          type: "err",
          text: "Discord couldn't be reached, so nothing was applied.",
        });
        return;
      }
      let built: BotCleanupPlan;
      try {
        built = await planBotCleanup(
          guild,
          session.discordUserId,
          botId,
          channelIds,
          approvedAt,
          { sampleMessages: sampled },
        );
      } catch (err) {
        // A failed read of the server refuses; it never falls back to the preview.
        logger.warn("bot cleanup: re-plan failed", err);
        flashRedirect(res, BOT_CLEANUP_PATH, {
          type: "err",
          text: "The server couldn't be read, so nothing was applied.",
        });
        return;
      }
      if (built.plan.id !== planId) {
        flashRedirect(res, BOT_CLEANUP_PATH, {
          type: "warn",
          text: "The server or your choices changed since you previewed the plan. Preview again and review the updated plan.",
        });
        return;
      }
      if (!cleanupPlanIsApplicable(built)) {
        flashRedirect(res, BOT_CLEANUP_PATH, {
          type: "err",
          text: "This plan can't be applied. Resolve the listed problems first.",
        });
        return;
      }
      // Checked on the plan that is about to run, not on what the browser claims.
      if (
        hasDestructiveSteps(built.plan) &&
        !getCheckbox(req, DESTRUCTIVE_CONFIRM_FIELD)
      ) {
        flashRedirect(res, BOT_CLEANUP_PATH, {
          type: "warn",
          text: "This plan removes permission overwrites. Tick the separate confirmation for them, then apply.",
        });
        return;
      }
      const engine = await ServerAdoptionService.getInstance(client, guild);
      try {
        const job = engine.startApply(built.plan, {
          actor: session,
          revalidate: cleanupRevalidator(
            guild,
            session.discordUserId,
            botId,
            channelIds,
            approvedAt,
            { sampleMessages: sampled },
          ),
        });
        await recordAudit(session, {
          action: "adopt.cleanup.apply",
          targetId: built.plan.id,
          details: {
            removedBotId: botId,
            operations: built.plan.operations.length,
            channels: built.channelIds.length,
          },
          result: "success",
        });
        res.redirect(
          303,
          `${BOT_CLEANUP_PATH}?job=${encodeURIComponent(job.id)}`,
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : "Unknown error";
        logger.error("bot cleanup: apply failed to start", error);
        await recordAudit(session, {
          action: "adopt.cleanup.apply",
          targetId: built.plan.id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, BOT_CLEANUP_PATH, { type: "err", text });
      }
    }),
  );

  return router;
}
