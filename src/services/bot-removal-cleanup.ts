import type { Guild } from "discord.js";
import {
  findKnownBot,
  KNOWN_BOTS,
  type KnownBot,
} from "../content/known-bots.js";
import { claimKeyFor, staleDestructiveSteps } from "./channel-claims.js";
import {
  planAdoption,
  type AdoptionPlan,
  type PlanIssue,
  type PlanOperation,
} from "./server-adoption-planner.js";
import {
  ServerScanService,
  type ScanChannel,
  type ServerScan,
} from "./server-scan-service.js";
import logger from "../utils/logger.js";
import { restoreProblems } from "./adoption-rollback-check.js";
import type { AdoptionSnapshotRecord } from "./server-adoption-service.js";

/**
 * Cleanup plan for a bot the admin already removed by hand (#1179, part of the
 * server-adoption work #1017). KoolBot never removes another bot: this only
 * offers to tidy what a removed bot left behind, through the adoption engine
 * (preview first, snapshot before apply, rollback from the adoption history).
 *
 * This slice covers detection, removing the member-specific permission
 * overwrites that still point at the removed bot, and flagging the settings
 * bound to its channels. Discord removes a bot's managed role itself but not
 * those overwrites. Claiming its channels stays on Channel Claims (this page
 * links there) and archiving or deleting its channels is not offered.
 *
 * The engine classes an overwrite removal as destructive, so each removal needs
 * a per-channel approval (the admin's tick) and the apply form's separate
 * destructive confirmation. Nothing here is on by default.
 */

export type CandidateEvidence = "catalogue" | "owner-hint" | "orphan-overwrite";

export interface CandidateChannel {
  id: string;
  name: string;
  /** Discord channel type name (`GuildVoice`), so the page can label it. */
  typeName?: string;
}

export interface CandidateOwnedChannel extends CandidateChannel {
  usedBy: string[];
  /** The feature the Server scan's Claim link would prefill, or null. */
  claimKey: string | null;
}

export interface RemovedBotCandidate {
  userId: string;
  name: string;
  evidence: CandidateEvidence;
  /**
   * The scan cannot tell whether the account is still in the server: it is
   * only a cached member without an integration role, or a bare overwrite.
   * `confirmRemovedBots` asks Discord before such a candidate is listed.
   */
  needsCheck: boolean;
  /** Why this id is offered, in plain words. */
  reason: string;
  /** Channels with a member overwrite for the removed bot (what the plan removes). */
  overwriteChannels: CandidateChannel[];
  /** Channels it mostly wrote to (needs channel ownership hints). */
  ownedChannels: CandidateOwnedChannel[];
  /** KoolBot features bound to a channel the bot touched. */
  boundFeatures: Array<{
    channel: string;
    typeName?: string;
    features: string[];
  }>;
}

const EVIDENCE_RANK: Record<CandidateEvidence, number> = {
  catalogue: 0,
  "owner-hint": 1,
  "orphan-overwrite": 2,
};

/**
 * Bots that were in the server and are not now, found from what they left. A
 * member overwrite for an account that is not a current bot is only offered
 * when something says it was a bot: a catalogue id, or a channel it mostly
 * wrote to (ownership hints). A bare leftover overwrite could equally belong to
 * a person who left or who is still here, so it is offered last.
 *
 * The scan is not proof of membership. Only the bot itself, the owner, the
 * admin and a bot with an integration role (Discord removes that role when the
 * bot leaves) count as present. A bot that is merely in the member cache may
 * have left (the cache is not refreshed), and an account named by an
 * overwrite may be a current member; both are `needsCheck` and are only listed
 * after `confirmRemovedBots` has asked Discord. Pure: reads only the scan.
 */
export function findRemovedBotCandidates(
  scan: ServerScan,
  catalog: readonly KnownBot[] = KNOWN_BOTS,
): RemovedBotCandidate[] {
  const roleProven = scan.bots.filter(
    (b) => b.isKoolBot || b.roleIds.length > 0,
  );
  const cachedOnly = new Set(
    scan.bots
      .filter((b) => !b.isKoolBot && b.roleIds.length === 0)
      .map((b) => b.userId),
  );
  const present = new Set<string>([
    ...roleProven.map((b) => b.userId),
    scan.scanned.botUserId,
    scan.scanned.ownerId,
    scan.scanned.adminUserId,
  ]);
  const ids = new Map<string, CandidateEvidence>();
  const note = (id: string, evidence: CandidateEvidence): void => {
    if (present.has(id)) return;
    const cur = ids.get(id);
    if (cur === undefined || EVIDENCE_RANK[evidence] < EVIDENCE_RANK[cur]) {
      ids.set(id, evidence);
    }
  };
  // Index once: channels by the member their overwrite names, and by the bot
  // an ownership hint names. Per-candidate lookups below are then O(1), not a
  // pass over every channel's overwrites for each account.
  const overwriteIndex = new Map<string, ScanChannel[]>();
  const ownedIndex = new Map<string, ScanChannel[]>();
  const push = (
    map: Map<string, ScanChannel[]>,
    id: string,
    ch: ScanChannel,
  ): void => {
    const list = map.get(id);
    if (!list) map.set(id, [ch]);
    else if (list[list.length - 1] !== ch) list.push(ch);
  };
  const knownCache = new Map<string, boolean>();
  const isKnown = (id: string): boolean => {
    let known = knownCache.get(id);
    if (known === undefined) {
      known = !!findKnownBot(id, catalog);
      knownCache.set(id, known);
    }
    return known;
  };
  for (const ch of scan.channels) {
    for (const o of ch.overwrites) {
      if (o.type !== "member") continue;
      push(overwriteIndex, o.id, ch);
      if (present.has(o.id)) continue;
      // The forced single-member lookup that confirms it needs no intent.
      note(o.id, isKnown(o.id) ? "catalogue" : "orphan-overwrite");
    }
    if (ch.ownerHint) {
      push(ownedIndex, ch.ownerHint.botId, ch);
      note(
        ch.ownerHint.botId,
        isKnown(ch.ownerHint.botId) ? "catalogue" : "owner-hint",
      );
    }
  }
  const out: RemovedBotCandidate[] = [];
  for (const [userId, evidence] of ids) {
    const overwriteChannels = (overwriteIndex.get(userId) ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      typeName: c.typeName,
    }));
    const owned = ownedIndex.get(userId) ?? [];
    const ownedChannels = owned.map((c) => ({
      id: c.id,
      name: c.name,
      typeName: c.typeName,
      usedBy: c.usedBy,
      claimKey: claimKeyFor(c),
    }));
    const touched = new Map<string, ScanChannel>();
    for (const c of [...(overwriteIndex.get(userId) ?? []), ...owned]) {
      touched.set(c.id, c);
    }
    const boundFeatures = [...touched.values()]
      .filter((c) => c.usedBy.length > 0)
      .map((c) => ({
        channel: c.name,
        typeName: c.typeName,
        features: c.usedBy,
      }));
    const known = findKnownBot(userId, catalog);
    const tag = owned[0]?.ownerHint?.botTag;
    out.push({
      userId,
      name: known?.name ?? tag ?? userId,
      evidence,
      needsCheck: evidence === "orphan-overwrite" || cachedOnly.has(userId),
      reason:
        evidence === "catalogue"
          ? "Its id is in the bot catalogue and it is no longer in the server."
          : evidence === "owner-hint"
            ? "It wrote most recent messages in a channel and is no longer in the server."
            : "A permission overwrite names an account Discord says is a bot that has left the server.",
      overwriteChannels,
      ownedChannels,
      boundFeatures,
    });
  }
  return out.sort(
    (a, b) =>
      EVIDENCE_RANK[a.evidence] - EVIDENCE_RANK[b.evidence] ||
      a.name.localeCompare(b.name) ||
      a.userId.localeCompare(b.userId),
  );
}

const DISCORD_UNKNOWN_MEMBER = 10007;

function discordCode(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "number" ? code : null;
  }
  return null;
}

/**
 * Ask Discord, not the cache, whether the account is a bot and no longer a
 * member. Only "Unknown Member" counts as gone: a member that is still there,
 * an account that is not a bot, or any read that fails refuses the plan.
 * Returns the problem, or null when the bot is confirmed removed.
 */
export async function verifyBotRemoved(
  guild: Guild,
  userId: string,
): Promise<PlanIssue | null> {
  const { CommandManager } = await import("./command-manager.js");
  const manager = CommandManager.getInstance(guild.client);
  const refuse = (code: string, message: string): PlanIssue => ({
    code,
    message,
    targetId: userId,
  });
  let isBot: boolean;
  try {
    const user = await manager.makeDiscordApiCall(
      () => guild.client.users.fetch(userId),
      "fetch removed bot user",
      15000,
      2,
    );
    isBot = user.bot;
  } catch (error) {
    return refuse(
      "bot-check-failed",
      `Discord could not confirm that ${userId} is a bot (${error instanceof Error ? error.message : "unknown error"}), so nothing was planned.`,
    );
  }
  if (!isBot) {
    return refuse(
      "not-a-bot",
      `${userId} is not a bot account. This cleanup only handles bots you removed.`,
    );
  }
  try {
    await manager.makeDiscordApiCall(
      () => guild.members.fetch({ user: userId, force: true }),
      "check removed bot membership",
      15000,
      2,
      true,
      // The expected Unknown Member of a confirmed absence is not an error;
      // a genuine read failure is logged below, where it is told apart.
      false,
    );
    return refuse(
      "bot-still-present",
      "That bot is still in the server. Remove it in Discord first: KoolBot never removes other bots.",
    );
  } catch (error) {
    const cause = (error as { cause?: unknown } | null)?.cause;
    if (
      discordCode(error) === DISCORD_UNKNOWN_MEMBER ||
      discordCode(cause) === DISCORD_UNKNOWN_MEMBER
    ) {
      return null;
    }
    logger.warn("bot cleanup: membership check failed", error);
    return refuse(
      "membership-check-failed",
      `Discord could not confirm that the bot has left (${error instanceof Error ? error.message : "unknown error"}), so nothing was planned.`,
    );
  }
}

/** Most accounts one view asks Discord about; the next view continues. */
export const CONFIRM_LIMIT = 25;

export interface ConfirmedBots {
  candidates: RemovedBotCandidate[];
  /** Accounts whose check failed this time: not listed, never guessed. */
  unchecked: number;
  /**
   * Where the next view continues (pass it as `after`), or null when every
   * account has been asked about. Candidates are in a fixed order, so
   * consecutive views walk the whole list instead of re-asking the first ones.
   */
  next: string | null;
}

/**
 * Ask Discord about the candidates the scan could not settle (`needsCheck`),
 * at most `limit` per call, starting after the candidate `after`. One that is
 * still a member, or is not a bot, is dropped. One confirmed removed is kept.
 * One whose read fails is dropped and counted in `unchecked`: it is never
 * offered on the strength of the cache. Candidates the scan settled are always
 * returned.
 */
export async function confirmRemovedBots(
  guild: Guild,
  candidates: readonly RemovedBotCandidate[],
  options: {
    limit?: number;
    after?: string | null;
    /** Always asked about, whatever the cursor and limit say (the chosen bot). */
    include?: string | null;
  } = {},
): Promise<ConfirmedBots> {
  const limit = options.limit ?? CONFIRM_LIMIT;
  const cursor = options.after
    ? candidates.findIndex((c) => c.userId === options.after)
    : -1;
  const out: RemovedBotCandidate[] = [];
  let unchecked = 0;
  let asked = 0;
  let next: string | null = null;
  let last: string | null = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    if (!c.needsCheck) {
      out.push(c);
      continue;
    }
    const inWindow = i > cursor && asked < limit;
    if (!inWindow && c.userId !== options.include) {
      // Either asked on an earlier view, or left for the next one.
      if (i > cursor) next = last;
      continue;
    }
    // The chosen bot outside this view's window costs one extra lookup and
    // leaves the cursor alone.
    if (inWindow) {
      asked += 1;
      last = c.userId;
    }
    const problem = await verifyBotRemoved(guild, c.userId);
    if (problem === null) out.push({ ...c, needsCheck: false });
    else if (
      problem.code !== "bot-still-present" &&
      problem.code !== "not-a-bot"
    ) {
      unchecked += 1;
    }
  }
  return { candidates: out, unchecked, next };
}

export interface BotCleanupPlan {
  scan: ServerScan;
  candidate: RemovedBotCandidate | null;
  plan: AdoptionPlan;
  /** The channels whose overwrite the plan removes (validated selection). */
  channelIds: string[];
  /** Blocking problems found before the engine planned anything. */
  errors: PlanIssue[];
}

export function cleanupPlanIsApplicable(p: BotCleanupPlan): boolean {
  return (
    p.errors.length === 0 &&
    p.plan.errors.length === 0 &&
    p.plan.operations.length > 0
  );
}

/**
 * Plan the cleanup of one removed bot against the live server. Read-only. Only
 * the chosen channels' overwrite for that bot is removed; the approval for each
 * is the admin's tick, stamped `approvedAt` so the plan id reproduces.
 */
export async function planBotCleanup(
  guild: Guild,
  adminUserId: string,
  botId: string,
  channelIds: readonly string[],
  approvedAt: string,
  options: { sampleMessages?: boolean } = {},
): Promise<BotCleanupPlan> {
  const scan = await ServerScanService.getInstance(guild.client).scanGuild(
    guild,
    { adminUserId, sampleMessages: options.sampleMessages },
  );
  const errors: PlanIssue[] = [];
  const candidate =
    findRemovedBotCandidates(scan).find((c) => c.userId === botId) ?? null;
  const selected: string[] = [];
  if (
    !candidate &&
    scan.bots.some((b) => b.userId === botId && b.roleIds.length > 0)
  ) {
    errors.push({
      code: "bot-still-present",
      message:
        "That bot is still in the server. Remove it in Discord first: KoolBot never removes other bots.",
      targetId: botId,
    });
  } else if (!candidate) {
    errors.push({
      code: "not-a-removed-bot",
      message:
        "That account is not a removed bot this server knows about. Open the report again and pick one from the list.",
      targetId: botId,
    });
  } else {
    const problem = await verifyBotRemoved(guild, botId);
    if (problem) errors.push(problem);
    const allowed = new Set(candidate.overwriteChannels.map((c) => c.id));
    for (const id of new Set(channelIds)) {
      if (allowed.has(id)) selected.push(id);
      else {
        errors.push({
          code: "channel-not-eligible",
          message:
            "A chosen channel has no overwrite for this bot any more. Preview again.",
          targetId: id,
        });
      }
    }
  }
  const plan = planAdoption(
    scan.scanned,
    errors.length > 0
      ? {}
      : {
          overwriteRemovals: selected.map((channelId) => ({
            channelId,
            targetId: botId,
          })),
          approvals: selected.map((channelId) => ({
            kind: "overwrite.remove" as const,
            targetId: `${channelId}:${botId}`,
            approvedBy: adminUserId,
            approvedAt,
          })),
        },
    // A bot only the member cache still remembers counts as "another bot" to
    // the planner. Every removal here targets the account verified gone above,
    // so lifting that guard opens nothing else.
    { approverId: adminUserId, allowOtherBotOverwrites: true },
  );
  if (
    errors.length === 0 &&
    plan.errors.length === 0 &&
    plan.operations.length > 0
  ) {
    for (const problem of undoProblems(
      scan.scanned,
      plan,
      selected,
      botId,
      adminUserId,
      approvedAt,
    )) {
      errors.push({
        code: "undo-unsafe",
        message: `This could not be restored from Adoption history right now: ${problem.replace(/[.\s]+$/, "")}. Fix that in Discord (for example give the bot's role the missing permission), then preview again.`,
      });
    }
  }
  if (candidate) {
    for (const b of candidate.boundFeatures) {
      plan.warnings.push({
        code: "feature-bound",
        message: `"${b.channel}" is bound to ${b.features.join(", ")} and stays so. Check that it still works without the removed bot, or rebind it on Channel claims.`,
      });
    }
    for (const c of candidate.ownedChannels) {
      if (c.usedBy.length === 0) continue;
      plan.warnings.push({
        code: "owned-channel-bound",
        message: `"${c.name}" was mostly written by the removed bot and is bound to ${c.usedBy.join(", ")}.`,
        targetId: c.id,
      });
    }
  }
  return { scan, candidate, plan, channelIds: selected, errors };
}

/**
 * Would Restore accept the snapshot this plan is about to create? Runs the very
 * check Adoption history runs (`restoreProblems`) on the record the apply
 * would leave, against the server as it will be after the apply, so a cleanup
 * whose undo the bot's own permissions would refuse (for example an overwrite
 * that allows a permission the bot lacks) is blocked before it runs. Fails
 * closed: a check that throws is a problem.
 */
function undoProblems(
  scanned: ServerScan["scanned"],
  plan: AdoptionPlan,
  channelIds: readonly string[],
  botId: string,
  adminUserId: string,
  approvedAt: string,
): string[] {
  const record = {
    id: "preflight",
    planId: plan.id,
    guildId: plan.guildId,
    appliedBy: adminUserId,
    status: "applied",
    plan,
    baseline: plan.baseline,
    operations: plan.operations.map((o) => ({
      opId: o.id,
      status: "applied",
    })),
    createdRoles: [],
    restoredChannels: [],
    restoredRoles: [],
    restoreIntents: [],
    configOverrides: {},
    rolledBackOps: [],
    memberProgress: {},
    rolledBackBy: null,
  } as unknown as AdoptionSnapshotRecord;
  const chosen = new Set(channelIds);
  const after = {
    ...scanned,
    channels: scanned.channels.map((c) =>
      chosen.has(c.id)
        ? { ...c, overwrites: c.overwrites.filter((o) => o.id !== botId) }
        : c,
    ),
  };
  try {
    return restoreProblems(record, after, {
      actorId: adminUserId,
      deleteCreatedRoles: false,
      approvedAt,
    });
  } catch (error) {
    logger.warn("bot cleanup: restore preflight failed", error);
    return ["the restore check could not be run."];
  }
}

/**
 * The live-state check the engine requires before it runs destructive steps:
 * plans the same cleanup again (which asks Discord whether the bot is still
 * gone) and refuses on any blocking problem or a step that no longer matches.
 */
export function cleanupRevalidator(
  guild: Guild,
  adminUserId: string,
  botId: string,
  channelIds: readonly string[],
  approvedAt: string,
  options: { sampleMessages?: boolean } = {},
): (pending: PlanOperation[]) => Promise<string[]> {
  return async (pending) => {
    const fresh = await planBotCleanup(
      guild,
      adminUserId,
      botId,
      channelIds,
      approvedAt,
      options,
    );
    const problems = [...fresh.errors, ...fresh.plan.errors].map(
      (e) => e.message,
    );
    problems.push(...staleDestructiveSteps(pending, fresh.plan.operations));
    return problems;
  };
}
