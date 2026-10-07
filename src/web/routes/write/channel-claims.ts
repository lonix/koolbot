/**
 * Channel Claims — preview and apply (#1022).
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf`.
 *
 * Nothing here writes to Discord directly. `/adopt/claims/preview` plans the
 * submitted claims and renders the diff; `/adopt/claims/apply` re-plans the
 * same claims, refuses if the server changed since the preview, and hands the
 * plan to the adoption engine, which snapshots every edit before applying it.
 */

import { Router } from "express";
import { ChannelType, Client, type Guild } from "discord.js";
import logger from "../../../utils/logger.js";
import { RoleGroupService } from "../../../services/role-group-service.js";
import {
  claimsPlanIsApplicable,
  claimsRevalidator,
  planChannelClaims,
} from "../../../services/channel-claims-adoption.js";
import {
  claimsFromForm,
  claimsFromPayload,
} from "../../../services/channel-claims-form.js";
import { ServerAdoptionService } from "../../../services/server-adoption-service.js";
import { recordAudit } from "../../audit.js";
import { getDisplayedRemainingMs } from "../../admin-layout.js";
import type { FlashMessage } from "../../admin-views.js";
import { renderChannelClaimsPage } from "../../channel-claims-view.js";
import {
  asyncHandler,
  flashRedirect,
  getCsrfFromReq,
  getString,
  navStatusForPage,
  requireSessionContext,
} from "./helpers.js";

const PAGE = "/admin/adopt/claims";
function readFlash(req: {
  query: Record<string, unknown>;
}): FlashMessage | null {
  const type = String(req.query.flash ?? "");
  const text = String(req.query.msg ?? "");
  if (!text || (type !== "ok" && type !== "warn" && type !== "err"))
    return null;
  return { type, text: text.slice(0, 500) };
}

const MAX_APPROVAL_AGE_MS = 60 * 60 * 1000;

export function createChannelClaimsRouter(client: Client): Router {
  const router = Router();

  async function fetchGuild(guildId: string): Promise<Guild | null> {
    try {
      return await client.guilds.fetch(guildId);
    } catch (error) {
      logger.warn("channel claims: guild fetch failed", error);
      return null;
    }
  }

  const channelList = async (
    guild: Guild,
  ): Promise<Array<{ id: string; kind: string; parentId: string | null }>> => {
    const fetched = await guild.channels.fetch();
    return [...fetched.values()].flatMap((c) =>
      c
        ? [
            {
              id: c.id,
              kind: c.type === ChannelType.GuildCategory ? "category" : "other",
              parentId: "parentId" in c ? (c.parentId ?? null) : null,
            },
          ]
        : [],
    );
  };

  async function pageBase(
    req: Parameters<typeof requireSessionContext>[0],
  ): Promise<{
    csrfToken: string;
    remainingMs: number;
    navFeatureStatus: Awaited<ReturnType<typeof navStatusForPage>>;
  }> {
    const session = requireSessionContext(req);
    return {
      csrfToken: getCsrfFromReq(req),
      remainingMs: getDisplayedRemainingMs(session),
      navFeatureStatus: await navStatusForPage(),
    };
  }

  router.get(
    "/adopt/claims",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const base = await pageBase(req);
      const guild = await fetchGuild(session.guildId);
      let scan = null;
      let error: string | undefined;
      let groups: Awaited<ReturnType<RoleGroupService["list"]>> = [];
      if (!guild) {
        error = "Discord couldn't be reached.";
      } else {
        try {
          const planned = await planChannelClaims(
            guild,
            session.discordUserId,
            [],
            new Date().toISOString(),
          );
          scan = planned.scan;
          groups = planned.groups;
        } catch (err) {
          logger.warn("channel claims: scan failed", err);
          error = err instanceof Error ? err.message : String(err);
        }
      }
      const jobParam = req.query.job;
      res.type("text/html").send(
        renderChannelClaimsPage({
          ...base,
          scan,
          error,
          groups,
          claims: [],
          plan: null,
          problems: [],
          approvedAt: null,
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
    "/adopt/claims/preview",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const base = await pageBase(req);
      const guild = await fetchGuild(session.guildId);
      if (!guild) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "Discord couldn't be reached, so nothing was planned.",
        });
        return;
      }
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const parsed = claimsFromForm(body, await channelList(guild));
      const approvedAt = new Date().toISOString();
      const planned = await planChannelClaims(
        guild,
        session.discordUserId,
        parsed.claims,
        approvedAt,
      );
      res.type("text/html").send(
        renderChannelClaimsPage({
          ...base,
          scan: planned.scan,
          groups: planned.groups,
          claims: parsed.claims,
          plan: planned,
          problems: parsed.problems,
          approvedAt,
        }),
      );
    }),
  );

  router.post(
    "/adopt/claims/apply",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const planId = getString(req, "planId");
      const at = getString(req, "at");
      const stamp = Date.parse(at);
      const age = Date.now() - stamp;
      if (Number.isNaN(stamp) || age > MAX_APPROVAL_AGE_MS || age < -60_000) {
        flashRedirect(res, PAGE, {
          type: "warn",
          text: "That preview is too old. Preview the changes again, then apply.",
        });
        return;
      }
      const guild = await fetchGuild(session.guildId);
      if (!guild) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "Discord couldn't be reached, so nothing was applied.",
        });
        return;
      }
      const ids = new Set((await channelList(guild)).map((c) => c.id));
      const parsed = claimsFromPayload(getString(req, "payload"), ids);
      if (!parsed) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "The preview couldn't be read. Preview the changes again.",
        });
        return;
      }
      const built = await planChannelClaims(
        guild,
        session.discordUserId,
        parsed.claims,
        new Date(stamp).toISOString(),
      );
      if (built.plan.id !== planId) {
        flashRedirect(res, PAGE, {
          type: "warn",
          text: "The server or your choices changed since you previewed the plan. Preview again and review the updated plan.",
        });
        return;
      }
      if (!claimsPlanIsApplicable(built)) {
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
          // Required for the destructive "replace permissions" steps: the
          // engine re-checks the live server before running them.
          revalidate: claimsRevalidator(
            guild,
            session.discordUserId,
            parsed.claims,
            new Date(stamp).toISOString(),
          ),
        });
        await recordAudit(session, {
          action: "adopt.claims.apply",
          targetId: built.plan.id,
          details: {
            operations: built.plan.operations.length,
            channels: parsed.claims.length,
          },
          result: "success",
        });
        res.redirect(303, `${PAGE}?job=${encodeURIComponent(job.id)}`);
      } catch (error) {
        const text = error instanceof Error ? error.message : "Unknown error";
        logger.error("channel claims: apply failed to start", error);
        await recordAudit(session, {
          action: "adopt.claims.apply",
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
