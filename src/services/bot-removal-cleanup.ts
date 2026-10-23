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
import { ServerScanService, type ServerScan } from "./server-scan-service.js";

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
  boundFeatures: Array<{ channel: string; features: string[] }>;
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
  for (const ch of scan.channels) {
    for (const o of ch.overwrites) {
      if (o.type !== "member") continue;
      if (findKnownBot(o.id, catalog)) note(o.id, "catalogue");
      // The forced single-member lookup that confirms it needs no intent.
      else note(o.id, "orphan-overwrite");
    }
    if (ch.ownerHint) {
      note(
        ch.ownerHint.botId,
        findKnownBot(ch.ownerHint.botId, catalog) ? "catalogue" : "owner-hint",
      );
    }
  }
  const out: RemovedBotCandidate[] = [];
  for (const [userId, evidence] of ids) {
    const overwriteChannels = scan.channels
      .filter((c) =>
        c.overwrites.some((o) => o.type === "member" && o.id === userId),
      )
      .map((c) => ({ id: c.id, name: c.name }));
    const ownedChannels = scan.channels
      .filter((c) => c.ownerHint?.botId === userId)
      .map((c) => ({
        id: c.id,
        name: c.name,
        usedBy: c.usedBy,
        claimKey: claimKeyFor(c),
      }));
    const touched = new Set([
      ...overwriteChannels.map((c) => c.id),
      ...ownedChannels.map((c) => c.id),
    ]);
    const boundFeatures = scan.channels
      .filter((c) => touched.has(c.id) && c.usedBy.length > 0)
      .map((c) => ({ channel: c.name, features: c.usedBy }));
    const known = findKnownBot(userId, catalog);
    const tag = scan.channels.find((c) => c.ownerHint?.botId === userId)
      ?.ownerHint?.botTag;
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
  options: { limit?: number; after?: string | null } = {},
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
    if (i <= cursor) continue; // asked on an earlier view
    if (asked >= limit) {
      next = last;
      continue;
    }
    asked += 1;
    last = c.userId;
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
