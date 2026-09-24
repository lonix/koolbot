/**
 * Leaderboard Roles — tier editor save and run now (#985).
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { ConfigService } from "../../../services/config-service.js";
import { settingsMetadata } from "../../../services/config-schema.js";
import { LeaderboardRoleService } from "../../../services/leaderboard-role-service.js";
import { recordAudit } from "../../audit.js";
import {
  parseTierConfig,
  serializeTiers,
  tierRoleProblem,
  validateTierRows,
  type LeaderboardTier,
} from "../../leaderboard-tiers.js";
import {
  flashRedirect,
  requireSessionContext,
  asyncHandler,
} from "./helpers.js";

const PAGE = "/admin/leaderboard-roles";
const TIERS_KEY = "leaderboard_roles.tiers";

/**
 * Whether the submitted rows are exactly the stored tiers — the same
 * `topN:roleId` pairs the service would act on, ignoring blank rows, order
 * and spacing. A submission the service itself would parse differently (a
 * malformed or repeated row) never counts as unchanged.
 */
function sameTiers(
  topNs: readonly string[],
  roleIds: readonly string[],
  stored: string,
): boolean {
  const entries: string[] = [];
  for (let i = 0; i < Math.max(topNs.length, roleIds.length); i++) {
    const topN = (topNs[i] ?? "").trim();
    const roleId = (roleIds[i] ?? "").trim();
    if (topN || roleId) entries.push(`${topN}:${roleId}`);
  }
  const submitted = parseTierConfig(entries.join(","));
  return (
    submitted.ignored.length === 0 &&
    serializeTiers(submitted.tiers) ===
      serializeTiers(parseTierConfig(stored).tiers)
  );
}

function toArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  return typeof raw === "string" ? [raw] : [];
}

/**
 * Check every tier's role against the live guild: it must exist, not be
 * @everyone or integration-managed, and sit below the bot's highest role.
 * Fails closed — if the guild can't be read the save is refused rather than
 * storing roles nobody checked.
 */
async function findTierRoleProblem(
  client: Client,
  guildId: string,
  tiers: readonly LeaderboardTier[],
): Promise<string | null> {
  if (tiers.length === 0) return null;
  let guild;
  try {
    guild = await client.guilds.fetch(guildId);
    await guild.roles.fetch();
  } catch (err) {
    logger.warn("leaderboard tiers: guild fetch failed", err);
    return "Could not read the server's roles from Discord to check them. Try again.";
  }
  const me =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    return "Could not read the bot's own roles from Discord to check the tiers. Try again.";
  }
  const botHighest = me.roles.highest.position;
  for (const tier of tiers) {
    const role = guild.roles.cache.get(tier.roleId) ?? null;
    const problem = tierRoleProblem(role, guild.id, botHighest);
    if (problem) return `Top ${tier.topN}: ${problem}.`;
  }
  return null;
}

export function createLeaderboardRolesRouter(client: Client): Router {
  const router = Router();

  router.post(
    "/leaderboard-roles/tiers",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const topNs = toArray(body["topN"]);
      const roleIds = toArray(body["roleId"]);
      const config = ConfigService.getInstance();
      let before: string;
      try {
        before = await config.getString(TIERS_KEY, "");
      } catch {
        before = "";
      }
      // Saving the editor unchanged must leave the stored string exactly as
      // it was — including its order and spacing — so compare the tiers the
      // service would act on rather than the raw text. Checked before the
      // editor's stricter rules, so an existing config those rules would
      // reject (e.g. a Top N above the editor's cap) still round-trips.
      if (sameTiers(topNs, roleIds, before)) {
        flashRedirect(res, PAGE, {
          type: "ok",
          text: "Tiers unchanged — nothing to save.",
        });
        return;
      }

      const rows = validateTierRows(topNs, roleIds);
      if (!rows.ok) {
        await recordAudit(session, {
          action: "leaderboard-roles.tiers",
          targetId: TIERS_KEY,
          result: "failure",
          errorMessage: rows.error,
        });
        flashRedirect(res, PAGE, { type: "err", text: rows.error });
        return;
      }

      const after = serializeTiers(rows.tiers);

      const problem = await findTierRoleProblem(
        client,
        session.guildId,
        rows.tiers,
      );
      if (problem) {
        await recordAudit(session, {
          action: "leaderboard-roles.tiers",
          targetId: TIERS_KEY,
          details: { before, attempted: after },
          result: "failure",
          errorMessage: problem,
        });
        flashRedirect(res, PAGE, { type: "err", text: problem });
        return;
      }

      const meta = settingsMetadata[TIERS_KEY];
      try {
        await config.set(TIERS_KEY, after, meta.description, meta.category);
        await recordAudit(session, {
          action: "leaderboard-roles.tiers",
          targetId: TIERS_KEY,
          details: { before, after },
          result: "success",
        });
        const n = rows.tiers.length;
        flashRedirect(res, PAGE, {
          type: "ok",
          text:
            n === 0
              ? "Tiers cleared. Current holders lose their reward roles on the next recalculation — use Run now to do it immediately."
              : `Saved ${n} tier${n === 1 ? "" : "s"}. They apply on the next recalculation, which also takes back the roles of removed tiers — use Run now to apply them immediately.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("leaderboard tiers save failed", err);
        await recordAudit(session, {
          action: "leaderboard-roles.tiers",
          targetId: TIERS_KEY,
          details: { before, attempted: after },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, PAGE, {
          type: "err",
          text: `Failed to save tiers: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/leaderboard-roles/run-now",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const service = LeaderboardRoleService.getInstance(client);
      try {
        const summary = await service.runNow();
        if (!summary) {
          // null covers every "nothing ran" path: the feature is off, voice
          // tracking is off, GUILD_ID is unset or the guild is unreachable,
          // or the run failed (the service logs which).
          await recordAudit(session, {
            action: "leaderboard-roles.run-now",
            result: "failure",
            errorMessage: "recalculation did not run",
          });
          flashRedirect(res, PAGE, {
            type: "warn",
            text: "Recalculation did not run. Check that leaderboard roles and voice tracking are enabled and GUILD_ID is set; the bot log has the details.",
          });
          return;
        }
        const retired = summary.retired ?? [];
        const skipped = summary.tiers.filter((t) => t.skippedReason);
        const retainedCount = retired.reduce(
          (n, r) => n + r.retained.length,
          0,
        );
        const added = summary.tiers.reduce((n, t) => n + t.added.length, 0);
        const removed =
          summary.tiers.reduce((n, t) => n + t.removed.length, 0) +
          retired.reduce((n, r) => n + r.removed.length, 0);
        const problems = [
          skipped.length > 0
            ? `${skipped.length} tier(s) skipped: role not found`
            : "",
          retainedCount > 0
            ? `${retainedCount} removed-tier revoke(s) failed; retried next run`
            : "",
        ].filter(Boolean);
        await recordAudit(session, {
          action: "leaderboard-roles.run-now",
          details: {
            period: summary.period,
            tiers: summary.tiers.map((t) => ({
              topN: t.topN,
              roleId: t.roleId,
              added: t.added.length,
              removed: t.removed.length,
              skippedReason: t.skippedReason ?? null,
            })),
            retired: retired.map((r) => ({
              roleId: r.roleId,
              removed: r.removed.length,
              retained: r.retained.length,
            })),
          },
          result: problems.length > 0 ? "failure" : "success",
          errorMessage: problems.length > 0 ? problems.join("; ") : null,
        });
        const perTier = summary.tiers
          .map((t) =>
            t.skippedReason
              ? `Top ${t.topN}: skipped (role not found)`
              : `Top ${t.topN} @${t.roleName}: +${t.added.length} / −${t.removed.length}`,
          )
          .concat(
            retired.map(
              (r) =>
                `Removed tier @${r.roleName}: −${r.removed.length}${r.retained.length > 0 ? ` (${r.retained.length} failed, retried next run)` : ""}`,
            ),
          )
          .join(" · ");
        flashRedirect(res, PAGE, {
          type: problems.length > 0 ? "warn" : "ok",
          text: `Recalculated (${summary.period}): ${added} granted, ${removed} revoked. ${perTier}`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("leaderboard roles run-now failed", err);
        await recordAudit(session, {
          action: "leaderboard-roles.run-now",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, PAGE, {
          type: "err",
          text: `Recalculation failed: ${text}`,
        });
      }
    }),
  );

  return router;
}
