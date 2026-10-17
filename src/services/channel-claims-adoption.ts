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
import {
  DEFAULT_PAIR_EMOJI,
  detectFeeds,
  detectRolePairings,
  judgeRecordedPairings,
  type RolePairing,
} from "./channel-claims-suggestions.js";

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
  /** The claims that were planned, after "accept all detected pairs". */
  claims: ChannelClaim[];
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
  options: {
    acceptAllPairs?: boolean;
    /** Emoji the admin typed per category id, used by "accept all". */
    pairEmojis?: Readonly<Record<string, string>>;
    /**
     * Registrations a pending plan already recorded (category id, role id). They
     * are judged again for safety but not re-detected, so a plan that also gated
     * the category for another role can resume its registration.
     */
    recordedPairings?: ReadonlyArray<{ categoryId: string; roleId: string }>;
  } = {},
): Promise<ClaimsPlan> {
  const [scan, groups, migrated] = await Promise.all([
    ServerScanService.getInstance(guild.client).scanGuild(guild, {
      adminUserId,
    }),
    RoleGroupService.getInstance().list(guild.id),
    voiceMigrationDone(guild.id),
  ]);
  const detected = detectRolePairings(scan, groups);
  const recorded = judgeRecordedPairings(
    scan,
    groups,
    options.recordedPairings ?? [],
  );
  const recordedCategories = new Set(recorded.map((p) => p.categoryId));
  const pairings = [
    ...detected.filter((p) => !recordedCategories.has(p.categoryId)),
    ...recorded,
  ];
  const finalClaims = options.acceptAllPairs
    ? acceptAllPairs(claims, pairings, options.pairEmojis)
    : [...claims];
  const built = buildClaimsDesiredState(finalClaims, {
    scanned: scan.scanned,
    groups,
    integrationRoleIds: new Set(
      scan.roles.filter((r) => r.botId !== null).map((r) => r.id),
    ),
    syncedToParent: new Map(scan.channels.map((c) => [c.id, c.syncedToParent])),
    membersIntent: scan.readiness.membersIntent,
    suggestedPrefix: scan.naming.suggestedPrefix,
    voiceMigrationDone: migrated,
    pairings: new Map(pairings.map((p) => [p.categoryId, p])),
    feeds: detectFeeds(scan),
    approvedAt,
  });
  const plan = planAdoption(scan.scanned, built.desired, {
    approverId: adminUserId,
    gateTargetIds: built.gateTargetIds,
  });
  const { errors, warnings } = splitIssues(built.issues);
  return { scan, groups, plan, claims: finalClaims, errors, warnings };
}

/**
 * "Accept all detected pairs": register every proposed pairing the admin has
 * not decided on yet. A category that already has a claim keeps its own action
 * and gains the pairing; refused and already-registered pairings are never
 * added.
 */
export function acceptAllPairs(
  claims: readonly ChannelClaim[],
  pairings: readonly RolePairing[],
  emojis: Readonly<Record<string, string>> = {},
): ChannelClaim[] {
  const out = claims.map((c) => ({ ...c }));
  for (const p of pairings) {
    if (p.state !== "proposed") continue;
    const own = out.find((c) => c.channelId === p.categoryId);
    if (own) {
      own.registerPairing = true;
      // An emoji already chosen for this pairing wins; otherwise the typed one.
      if (!own.pairEmoji?.trim() && emojis[p.categoryId]?.trim()) {
        own.pairEmoji = emojis[p.categoryId].trim();
      }
      continue;
    }
    out.push({
      channelId: p.categoryId,
      action: "leave",
      registerPairing: true,
      pairEmoji: emojis[p.categoryId]?.trim() || DEFAULT_PAIR_EMOJI,
    });
  }
  return out;
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
    const effective = claimsForRevalidation(claims, pending);
    const fresh = await planChannelClaims(
      guild,
      adminUserId,
      effective,
      approvedAt,
      {
        recordedPairings: pending.flatMap((op) =>
          op.type === "reactionrole.register"
            ? [{ categoryId: op.categoryId, roleId: op.roleId }]
            : [],
        ),
      },
    );
    const problems = [...fresh.plan.errors, ...fresh.errors].map(
      (e) => e.message,
    );
    problems.push(...staleDestructiveSteps(pending, fresh.plan.operations));
    return problems;
  };
}

/**
 * The claims to plan again for a live-state check. The destructive phase
 * re-checks after the additive steps (including the registrations) have
 * landed. A category gated for more roles by this very plan is no longer
 * "gated by exactly one role", so detecting its pairing again would fail the
 * plan on its own changes. A registration is not pending then (the pre-apply
 * check lists every step, the later one only the destructive ones), so it is
 * not planned again; everything else is checked as before.
 */
export function claimsForRevalidation(
  claims: readonly ChannelClaim[],
  pending: readonly PlanOperation[],
): ChannelClaim[] {
  // Only a category whose registration is still pending keeps it: one that
  // already registered may no longer look like a pairing (the plan gated it
  // for more roles), and planning it again would block the others' retry.
  const pendingCategories = new Set(
    pending.flatMap((op) =>
      op.type === "reactionrole.register" ? [op.categoryId] : [],
    ),
  );
  return claims.map((c) => ({
    ...c,
    registerPairing: !!c.registerPairing && pendingCategories.has(c.channelId),
  }));
}
