import type { Guild } from "discord.js";
import logger from "../utils/logger.js";
import { ManagedVoiceMigration } from "../models/managed-voice-channel.js";
import { RoleGroupService, type RoleGroupView } from "./role-group-service.js";
import { ServerScanService, type ServerScan } from "./server-scan-service.js";
import {
  planAdoption,
  type AdoptionPlan,
  type PlanIssue,
  type PlanOperation,
} from "./server-adoption-planner.js";
import {
  buildClaimsDesiredState,
  staleDestructiveSteps,
  splitIssues,
  type ChannelClaim,
} from "./channel-claims.js";

/**
 * Glue between channel claims (#1022) and the adoption engine (#1018): scan the
 * server, translate the admin's claims into a desired state, and plan it. The
 * result is previewed; only the apply step writes, through the engine, which
 * snapshots every edit first.
 */

export interface ClaimsPlan {
  scan: ServerScan;
  groups: RoleGroupView[];
  plan: AdoptionPlan;
  /** Blocking problems found while translating the claims. */
  errors: PlanIssue[];
  /** Advice that doesn't stop an apply. */
  warnings: PlanIssue[];
}

export function claimsPlanIsApplicable(p: ClaimsPlan): boolean {
  return (
    p.plan.errors.length === 0 &&
    p.errors.length === 0 &&
    p.plan.operations.length > 0
  );
}

/** Has the first managed-only voice cleanup already run for this server? */
async function voiceMigrationDone(guildId: string): Promise<boolean> {
  try {
    return !!(await ManagedVoiceMigration.findOne({ guildId }).lean());
  } catch (error) {
    // Unknown: assume it has not run, which only makes the check stricter.
    logger.debug("channel claims: voice migration lookup failed", error);
    return false;
  }
}

/** Plan the given claims against the live server. Read-only. */
export async function planChannelClaims(
  guild: Guild,
  adminUserId: string,
  claims: readonly ChannelClaim[],
  approvedAt: string,
): Promise<ClaimsPlan> {
  const [scan, groups, migrated] = await Promise.all([
    ServerScanService.getInstance(guild.client).scanGuild(guild, {
      adminUserId,
    }),
    RoleGroupService.getInstance().list(guild.id),
    voiceMigrationDone(guild.id),
  ]);
  const built = buildClaimsDesiredState(claims, {
    scanned: scan.scanned,
    groups,
    integrationRoleIds: new Set(
      scan.roles.filter((r) => r.botId !== null).map((r) => r.id),
    ),
    syncedToParent: new Map(scan.channels.map((c) => [c.id, c.syncedToParent])),
    membersIntent: scan.readiness.membersIntent,
    suggestedPrefix: scan.naming.suggestedPrefix,
    voiceMigrationDone: migrated,
    approvedAt,
  });
  const plan = planAdoption(scan.scanned, built.desired, {
    approverId: adminUserId,
    gateTargetIds: built.gateTargetIds,
  });
  const { errors, warnings } = splitIssues(built.issues);
  return { scan, groups, plan, errors, warnings };
}

/**
 * The live-state check the engine requires before it runs destructive steps
 * (it runs once before applying and again before the destructive phase, after
 * the additive steps have landed). Re-plans the same claims against the live
 * server and refuses if the fresh plan has blocking problems, or no longer
 * contains a destructive step that is still pending, e.g. because someone
 * changed that channel's permissions in the meantime.
 */
export function claimsRevalidator(
  guild: Guild,
  adminUserId: string,
  claims: readonly ChannelClaim[],
  approvedAt: string,
): (pending: PlanOperation[]) => Promise<string[]> {
  return async (pending) => {
    const fresh = await planChannelClaims(
      guild,
      adminUserId,
      claims,
      approvedAt,
    );
    const problems = [...fresh.plan.errors, ...fresh.errors].map(
      (e) => e.message,
    );
    problems.push(...staleDestructiveSteps(pending, fresh.plan.operations));
    return problems;
  };
}
