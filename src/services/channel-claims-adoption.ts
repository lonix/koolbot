import type { Guild } from "discord.js";
import { RoleGroupService, type RoleGroupView } from "./role-group-service.js";
import { ServerScanService, type ServerScan } from "./server-scan-service.js";
import {
  planAdoption,
  type AdoptionPlan,
  type PlanIssue,
} from "./server-adoption-planner.js";
import {
  buildClaimsDesiredState,
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

/** Plan the given claims against the live server. Read-only. */
export async function planChannelClaims(
  guild: Guild,
  adminUserId: string,
  claims: readonly ChannelClaim[],
  approvedAt: string,
): Promise<ClaimsPlan> {
  const [scan, groups] = await Promise.all([
    ServerScanService.getInstance(guild.client).scanGuild(guild, {
      adminUserId,
    }),
    RoleGroupService.getInstance().list(guild.id),
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
    approvedAt,
  });
  const plan = planAdoption(scan.scanned, built.desired, {
    approverId: adminUserId,
    gateTargetIds: built.gateTargetIds,
  });
  const { errors, warnings } = splitIssues(built.issues);
  return { scan, groups, plan, errors, warnings };
}
