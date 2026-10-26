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
  storedTiersFromSnapshot,
  TIERS_KEY,
  tierRoleProblem,
  checkTierRows,
  type LeaderboardTier,
} from "../../leaderboard-tiers.js";
import {
  flashRedirect,
  requireSessionContext,
  asyncHandler,
  findGroupRoleReuse,
  refuseForm,
} from "./helpers.js";
import {
  addFieldError,
  type FormErrors,
  type FormValues,
} from "../../form-errors.js";
import { LEADERBOARD_TIERS_FORM, tierFieldKey } from "../../admin-views.js";

const PAGE = "/admin/leaderboard-roles";

/**
 * The stored `leaderboard_roles.tiers` value, or null when it can't be read.
 * `ConfigService.getString` swallows read failures and returns the default,
 * which here would make an outage look like "no tiers" and let a save
 * overwrite the real ones. `getAll` rejects instead, so it is the strict
 * read; only when no row is stored does the env / default fallback apply.
 */
async function readStoredTiers(config: ConfigService): Promise<string | null> {
  let rows: Awaited<ReturnType<ConfigService["getAll"]>>;
  try {
    rows = await config.getAll();
  } catch (err) {
    logger.warn("leaderboard tiers: config read failed", err);
    return null;
  }
  return storedTiersFromSnapshot(rows) ?? config.getString(TIERS_KEY, "");
}

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
 * What the tiers form submitted, as the refused form shows it (#1523): every
 * row exactly as typed (not trimmed), under the key `topN-<row>` / `roleId-<row>`,
 * plus how many rows to draw. Rows are drawn from this, not from the stored
 * tiers, so a row that was added and never saved keeps its values.
 */
function tiersFormValues(
  topNs: readonly string[],
  roleIds: readonly string[],
): FormValues {
  const count = Math.max(topNs.length, roleIds.length);
  const values: FormValues = { rows: String(count) };
  for (let i = 0; i < count; i++) {
    values[tierFieldKey("topN", i)] = topNs[i] ?? "";
    values[tierFieldKey("roleId", i)] = roleIds[i] ?? "";
  }
  return values;
}

/** A tier role the live guild rules out. `topN` is null when it is not about one tier. */
interface TierRoleProblem {
  message: string;
  topN: number | null;
}

/**
 * {@link TierRoleProblem} as the line under the row's role field. It keeps the
 * "Top N:" lead, so the flash the page falls back to still names the tier.
 */
function fieldMessage(problem: TierRoleProblem): string {
  return /pick a different/.test(problem.message)
    ? problem.message
    : `${problem.message} Pick a different role.`;
}

/**
 * Check every tier's role against the live guild: it must exist, not be
 * @everyone or integration-managed, and sit below the bot's highest role.
 * A role with Administrator or another powerful permission is refused too
 * (#1145), except a role in `keep` (the tiers' current roles): an existing
 * choice is not blocked on every unrelated save, it just stops being granted.
 * Fails closed — if the guild can't be read the save is refused rather than
 * storing roles nobody checked.
 */
async function findTierRoleProblem(
  client: Client,
  guildId: string,
  tiers: readonly LeaderboardTier[],
  keep: readonly string[] = [],
): Promise<TierRoleProblem | null> {
  if (tiers.length === 0) return null;
  let guild;
  try {
    guild = await client.guilds.fetch(guildId);
    await guild.roles.fetch();
  } catch (err) {
    logger.warn("leaderboard tiers: guild fetch failed", err);
    return {
      message:
        "Could not read the server's roles from Discord to check them. Try again.",
      topN: null,
    };
  }
  const me =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    return {
      message:
        "Could not read the bot's own roles from Discord to check the tiers. Try again.",
      topN: null,
    };
  }
  const botHighest = me.roles.highest.position;
  for (const tier of tiers) {
    const role = guild.roles.cache.get(tier.roleId) ?? null;
    const problem = tierRoleProblem(role, guild.id, botHighest, {
      allowPrivileged: keep.includes(tier.roleId),
    });
    if (problem)
      return { message: `Top ${tier.topN}: ${problem}.`, topN: tier.topN };
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
      const before = await readStoredTiers(config);
      if (before === null) {
        const text =
          "Could not read the stored tiers, so nothing was saved (saving could overwrite them). Try again.";
        await recordAudit(session, {
          action: "leaderboard-roles.tiers",
          targetId: TIERS_KEY,
          result: "failure",
          errorMessage: "stored tiers unreadable",
        });
        flashRedirect(res, PAGE, { type: "err", text });
        return;
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

      const rows = checkTierRows(topNs, roleIds);
      const errors: FormErrors = {};
      for (const e of rows.errors) {
        addFieldError(errors, tierFieldKey(e.field, e.index), e.message);
      }
      // The submitted row each tier came from, so a refusal about a tier lands
      // on that row's field.
      const rowOfTopN = (topN: number): number =>
        topNs.findIndex((raw) => Number(raw.trim()) === topN);
      const values = tiersFormValues(topNs, roleIds);
      const refuse = (): Promise<boolean> =>
        refuseForm(req, res, {
          page: PAGE,
          formId: LEADERBOARD_TIERS_FORM,
          errors,
          values,
        });
      if (rows.errors.length > 0) {
        await recordAudit(session, {
          action: "leaderboard-roles.tiers",
          targetId: TIERS_KEY,
          result: "failure",
          errorMessage: rows.errors[0].flat,
        });
        await refuse();
        return;
      }

      const after = serializeTiers(rows.tiers);

      const problem = await findTierRoleProblem(
        client,
        session.guildId,
        rows.tiers,
        parseTierConfig(before).tiers.map((t) => t.roleId),
      );
      if (problem) {
        await recordAudit(session, {
          action: "leaderboard-roles.tiers",
          targetId: TIERS_KEY,
          details: { before, attempted: after },
          result: "failure",
          errorMessage: problem.message,
        });
        const row = problem.topN === null ? -1 : rowOfTopN(problem.topN);
        if (row >= 0) {
          // About one tier's role: mark it in its row. A failed Discord read
          // is not about a field and stays a page flash.
          addFieldError(
            errors,
            tierFieldKey("roleId", row),
            fieldMessage(problem),
          );
          await refuse();
        } else {
          flashRedirect(res, PAGE, { type: "err", text: problem.message });
        }
        return;
      }

      // A role that backs a role group can't become a reward role (#1023).
      // Roles the tiers already held are left alone.
      const heldRoles = parseTierConfig(before).tiers.map((t) => t.roleId);
      const reuse = await findGroupRoleReuse(
        session.guildId,
        rows.tiers.map((t) => t.roleId),
        heldRoles,
      );
      if (reuse) {
        await recordAudit(session, {
          action: "leaderboard-roles.tiers",
          targetId: TIERS_KEY,
          details: { before, attempted: after },
          result: "failure",
          errorMessage: reuse,
        });
        // Which tier's role it is: ask once per tier, on this rare path only.
        for (const tier of rows.tiers) {
          const row = rowOfTopN(tier.topN);
          if (
            row >= 0 &&
            (await findGroupRoleReuse(
              session.guildId,
              [tier.roleId],
              heldRoles,
            ))
          ) {
            addFieldError(errors, tierFieldKey("roleId", row), reuse);
          }
        }
        if (Object.keys(errors).length > 0) {
          await refuse();
        } else {
          flashRedirect(res, PAGE, { type: "err", text: reuse });
        }
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
            ? `${skipped.length} tier(s) skipped: ${[
                ...new Set(
                  skipped.map((t) =>
                    t.skippedReason === "role-privileged"
                      ? "role has powerful permissions or is the admin role"
                      : t.skippedReason === "role-unverified"
                        ? "role could not be read, retry"
                        : "role not found",
                  ),
                ),
              ].join("; ")}`
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
              ? t.skippedReason === "role-privileged"
                ? `Top ${t.topN} @${t.roleName}: not granted (powerful or admin role), −${t.removed.length}`
                : t.skippedReason === "role-unverified"
                  ? `Top ${t.topN} @${t.roleName}: not granted (role could not be read, try again), −${t.removed.length}`
                  : `Top ${t.topN}: skipped (role not found)`
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
