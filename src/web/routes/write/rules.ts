/**
 * Rules acceptance — post the rules message, record current role holders and
 * apply the rollout plan (#1024).
 *
 * Mounted by `createWriteRouter` behind `requireSession`, the admin check and
 * `requireCsrf`. Discord is written only by posting the message and, for the
 * rollout, through the adoption engine (plan → snapshot → apply).
 */

import { Router } from "express";
import { Client, type Guild } from "discord.js";
import logger from "../../../utils/logger.js";
import {
  RulesService,
  ROLE_PROBLEM_TEXT,
} from "../../../services/rules-service.js";
import {
  planRulesGate,
  rulesPlanIsApplicable,
} from "../../../services/rules-adoption.js";
import { ServerAdoptionService } from "../../../services/server-adoption-service.js";
import { ConfigService } from "../../../services/config-service.js";
import { recordAudit } from "../../audit.js";
import { parseRulesOptions } from "../../rules-page.js";
import {
  asyncHandler,
  flashRedirect,
  requireSessionContext,
} from "./helpers.js";

const PAGE = "/admin/rules";

export function createRulesRouter(client: Client): Router {
  const router = Router();

  async function fetchGuild(guildId: string): Promise<Guild | null> {
    try {
      return await client.guilds.fetch(guildId);
    } catch (error) {
      logger.warn("rules: guild fetch failed", error);
      return null;
    }
  }

  router.post(
    "/rules/post",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const config = ConfigService.getInstance();
      if (!(await config.getBoolean("rules.enabled", false))) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "Turn on Rules acceptance in Settings first.",
        });
        return;
      }
      const guild = await fetchGuild(session.guildId);
      if (!guild) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "Discord couldn't be reached.",
        });
        return;
      }
      const result =
        await RulesService.getInstance(client).postOrUpdateMessage(guild);
      await recordAudit(session, {
        action: "rules.post",
        targetId: result.messageId ?? "",
        details: { action: result.action ?? null },
        result: result.ok ? "success" : "failure",
        errorMessage: result.error,
      });
      flashRedirect(
        res,
        PAGE,
        result.ok
          ? {
              type: "ok",
              text:
                result.action === "updated"
                  ? "The rules message was updated."
                  : "The rules message was posted.",
            }
          : {
              type: "err",
              text: result.error ?? "Could not post the message.",
            },
      );
    }),
  );

  router.post(
    "/rules/sync",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const guild = await fetchGuild(session.guildId);
      if (!guild) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "Discord couldn't be reached.",
        });
        return;
      }
      try {
        const result =
          await RulesService.getInstance(client).recordExistingHolders(guild);
        if ("problem" in result) {
          await recordAudit(session, {
            action: "rules.record-holders",
            details: { problem: result.problem },
            result: "failure",
          });
          flashRedirect(res, PAGE, {
            type: "err",
            text: `Nothing was recorded. ${ROLE_PROBLEM_TEXT[result.problem]}`,
          });
          return;
        }
        const recorded = result.recorded;
        await recordAudit(session, {
          action: "rules.record-holders",
          details: { recorded },
          result: "success",
        });
        flashRedirect(res, PAGE, {
          type: "ok",
          text: `${recorded} current role holder(s) recorded as accepted.`,
        });
      } catch (error) {
        logger.warn("rules: recording holders failed", error);
        flashRedirect(res, PAGE, {
          type: "err",
          text: "The member list couldn't be read. Is the Server Members intent on?",
        });
      }
    }),
  );

  router.post(
    "/rules/apply",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const options = parseRulesOptions(body);
      const planId = typeof body["planId"] === "string" ? body["planId"] : "";
      const guild = await fetchGuild(session.guildId);
      if (!guild) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "Discord couldn't be reached, so nothing was applied.",
        });
        return;
      }
      const built = await planRulesGate(guild, session.discordUserId, options);
      if (built.plan.id !== planId) {
        flashRedirect(res, PAGE, {
          type: "warn",
          text: "The server changed since you previewed the plan. Preview again and apply the updated plan.",
        });
        return;
      }
      if (!rulesPlanIsApplicable(built)) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "This plan can't be applied. Resolve the listed problems first.",
        });
        return;
      }
      const engine = await ServerAdoptionService.getInstance(client, guild);
      try {
        const job = engine.startApply(built.plan, {
          actor: session,
        });
        await recordAudit(session, {
          action: "rules.apply",
          targetId: built.plan.id,
          details: { operations: built.plan.operations.length },
          result: "success",
        });
        res.redirect(303, `${PAGE}?job=${encodeURIComponent(job.id)}`);
      } catch (error) {
        const text = error instanceof Error ? error.message : "Unknown error";
        logger.error("rules: apply failed to start", error);
        await recordAudit(session, {
          action: "rules.apply",
          targetId: built.plan.id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, PAGE, { type: "err", text });
      }
    }),
  );

  return router;
}
