/**
 * Adopt existing Discord scheduled events as KoolBot events (#1034).
 *
 * Mounted by `createWriteRouter` behind `requireSession`, the admin check and
 * `requireCsrf`. `GET /adopt/events` lists the server's events and, when asked,
 * previews adopting the chosen ones; `POST /adopt/events/apply` re-plans the
 * same choice, refuses if the server changed since the preview, and hands the
 * plan to the adoption engine (snapshot first). Nothing here writes to a
 * Discord event, and rollback lives on the Adoption page.
 */

import { Router } from "express";
import { Client, type Guild } from "discord.js";
import logger from "../../../utils/logger.js";
import {
  eventPlanIsApplicable,
  planEventAdoption,
} from "../../../services/event-adoption.js";
import { ServerAdoptionService } from "../../../services/server-adoption-service.js";
import { recordAudit } from "../../audit.js";
import { getDisplayedRemainingMs } from "../../admin-layout.js";
import type { FlashMessage } from "../../admin-views.js";
import {
  EVENT_ADOPTION_PATH,
  renderEventAdoptionPage,
} from "../../event-adoption-view.js";
import {
  asyncHandler,
  flashRedirect,
  getCsrfFromReq,
  navStatusForPage,
  requireSessionContext,
} from "./helpers.js";

const SNOWFLAKE = /^\d{5,25}$/;

function readFlash(req: {
  query: Record<string, unknown>;
}): FlashMessage | null {
  const type = String(req.query.flash ?? "");
  const text = String(req.query.msg ?? "");
  if (!text || (type !== "ok" && type !== "warn" && type !== "err"))
    return null;
  return { type, text: text.slice(0, 500) };
}

/** The chosen event ids from a query string or form body. */
export function parseEventIds(source: Record<string, unknown>): string[] {
  const raw = source["ev"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return [...new Set(list.map(String).filter((id) => SNOWFLAKE.test(id)))];
}

export function createEventAdoptionRouter(client: Client): Router {
  const router = Router();

  async function fetchGuild(guildId: string): Promise<Guild | null> {
    try {
      return await client.guilds.fetch(guildId);
    } catch (error) {
      logger.warn("event adoption: guild fetch failed", error);
      return null;
    }
  }

  router.get(
    "/adopt/events",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const query = req.query as Record<string, unknown>;
      const selected = parseEventIds(query);
      const guild = await fetchGuild(session.guildId);
      let planned = null;
      let error: string | undefined;
      if (!guild) {
        error = "Discord couldn't be reached.";
      } else {
        try {
          planned = await planEventAdoption(
            guild,
            session.discordUserId,
            selected,
          );
        } catch (err) {
          logger.warn("event adoption: scan failed", err);
          error = err instanceof Error ? err.message : String(err);
        }
      }
      const jobParam = query["job"];
      res.type("text/html").send(
        renderEventAdoptionPage({
          csrfToken: getCsrfFromReq(req),
          remainingMs: getDisplayedRemainingMs(session),
          navFeatureStatus: await navStatusForPage(),
          planned,
          error,
          previewing: query["preview"] !== undefined,
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
    "/adopt/events/apply",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const planId = typeof body["planId"] === "string" ? body["planId"] : "";
      const selected = parseEventIds(body);
      const guild = await fetchGuild(session.guildId);
      if (!guild) {
        flashRedirect(res, EVENT_ADOPTION_PATH, {
          type: "err",
          text: "Discord couldn't be reached, so nothing was adopted.",
        });
        return;
      }
      const built = await planEventAdoption(
        guild,
        session.discordUserId,
        selected,
      );
      if (built.plan.id !== planId) {
        flashRedirect(res, EVENT_ADOPTION_PATH, {
          type: "warn",
          text: "The events changed since you previewed the plan. Preview again and review the updated plan.",
        });
        return;
      }
      if (!eventPlanIsApplicable(built)) {
        flashRedirect(res, EVENT_ADOPTION_PATH, {
          type: "err",
          text: "This plan can't be applied. Resolve the listed problems first.",
        });
        return;
      }
      const engine = await ServerAdoptionService.getInstance(client, guild);
      try {
        const job = engine.startApply(built.plan, { actor: session });
        await recordAudit(session, {
          action: "adopt.events.apply",
          targetId: built.plan.id,
          details: { operations: built.plan.operations.length },
          result: "success",
        });
        res.redirect(
          303,
          `${EVENT_ADOPTION_PATH}?job=${encodeURIComponent(job.id)}`,
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : "Unknown error";
        logger.error("event adoption: apply failed to start", error);
        await recordAudit(session, {
          action: "adopt.events.apply",
          targetId: built.plan.id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, EVENT_ADOPTION_PATH, { type: "err", text });
      }
    }),
  );

  return router;
}
