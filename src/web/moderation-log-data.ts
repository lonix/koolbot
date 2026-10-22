/**
 * Shared reads behind the admin Moderation and Command audit pages and the
 * moderator's `/me/moderation` pages (#1320). One implementation of each query
 * and label lookup, so what a moderator sees is what the admin page shows.
 *
 * Nothing here writes, and nothing reads message content or attachments: a log
 * row is the member, the moderator, the action and the stated reason.
 */

import type { ChannelType, Client } from "discord.js";
import type mongoose from "mongoose";
import logger from "../utils/logger.js";
import { DiscordCommandAuditLog } from "../models/discord-command-audit-log.js";
import type { IModerationLog } from "../models/moderation-log.js";
import type { IModerationCase } from "../models/moderation-case.js";
import type { CommandAuditRow, ModerationRow } from "./admin-views.js";

/** Discord's cap on user ids per batched guild-member fetch. */
const MEMBER_FETCH_BATCH = 100;

/**
 * Display names for the given user ids. The member cache answers first and the
 * misses are batched into `fetch({ user: [...] })` calls of at most 100, because a page of 50
 * rows can reference ~100 distinct ids and per-id fetches would be slow and
 * rate-limit-prone. Ids that stay unresolved (the member left) are simply
 * absent, so callers fall back to the raw snowflake. Never throws.
 */
export async function resolveMemberLabels(
  client: Client,
  guildId: string,
  ids: ReadonlySet<string>,
  seed: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, string>> {
  const labels = new Map<string, string>(seed);
  if (ids.size === 0) return labels;
  try {
    const guild = await client.guilds.fetch(guildId);
    const missing: string[] = [];
    for (const id of ids) {
      const cached = guild.members.cache.get(id);
      if (cached) {
        labels.set(id, cached.displayName ?? cached.user.username);
      } else {
        missing.push(id);
      }
    }
    // Discord accepts at most 100 ids per request. Each batch stands alone:
    // one that fails leaves its own ids as raw ids and keeps the others' names.
    for (let i = 0; i < missing.length; i += MEMBER_FETCH_BATCH) {
      const fetched = await guild.members
        .fetch({ user: missing.slice(i, i + MEMBER_FETCH_BATCH) })
        .catch(() => null);
      if (fetched) {
        for (const [id, member] of fetched) {
          labels.set(id, member.displayName ?? member.user.username);
        }
      }
    }
  } catch (err) {
    logger.debug("moderation page member-label fetch failed", err);
  }
  return labels;
}

/** The ids on a page of log rows that need a name (not the guild-level anti-raid rows). */
export function logRowUserIds(
  docs: readonly IModerationLog[],
  guildId: string,
): Set<string> {
  const ids = new Set<string>();
  for (const d of docs) {
    // Anti-raid lockdown rows concern the server, so their user is the guild
    // id (#1045): not a member, and not worth a lookup.
    if (d.userId !== guildId) ids.add(d.userId);
    if (d.moderatorId) ids.add(d.moderatorId);
  }
  return ids;
}

/** Log rows as the table renders them. `caseId` is the case opened on the row, if any. */
export function toModerationRows(
  docs: readonly IModerationLog[],
  casesByEntry: ReadonlyMap<string, IModerationCase>,
  labels: ReadonlyMap<string, string>,
): ModerationRow[] {
  return docs.map((d) => {
    const entryCase = casesByEntry.get(
      String(d._id as mongoose.Types.ObjectId),
    );
    return {
      entryId: String(d._id),
      caseId: entryCase ? String(entryCase._id) : null,
      caseNumber: entryCase?.caseNumber ?? null,
      caseStatus: entryCase?.status ?? null,
      createdAt:
        d.createdAt instanceof Date
          ? d.createdAt.toISOString()
          : String(d.createdAt ?? ""),
      userId: d.userId,
      userLabel: labels.get(d.userId) ?? d.userId,
      moderatorId: d.moderatorId ?? null,
      moderatorLabel: d.moderatorId
        ? (labels.get(d.moderatorId) ?? d.moderatorId)
        : null,
      action: d.action,
      reason: d.reason ?? null,
      source: d.source,
    };
  });
}

// ---------- Command audit ----------

export interface CommandAuditFilters {
  commandName: string;
  userId: string;
  result: string;
  from: string;
  to: string;
}

/** Filters as the pages read them from the query string, normalised. */
export function readCommandAuditFilters(
  query: Record<string, unknown>,
): CommandAuditFilters {
  const str = (name: string): string => {
    const raw = query[name];
    return typeof raw === "string" ? raw.trim() : "";
  };
  const result = str("result");
  return {
    commandName: str("command"),
    userId: str("user"),
    result:
      result === "success" || result === "error" || result === "denied"
        ? result
        : "",
    from: str("from"),
    to: str("to"),
  };
}

/** The Mongo query for a set of filters, scoped to the guild. */
export function buildCommandAuditQuery(
  guildId: string,
  filters: CommandAuditFilters,
): Record<string, unknown> {
  const query: Record<string, unknown> = { guildId };
  if (filters.commandName) query.commandName = filters.commandName;
  if (filters.userId) query.discordUserId = filters.userId;
  if (filters.result) query.result = filters.result;

  const dateRange: Record<string, Date> = {};
  const parsedFrom = filters.from ? new Date(filters.from) : null;
  const parsedTo = filters.to ? new Date(filters.to) : null;
  if (parsedFrom && !Number.isNaN(parsedFrom.getTime())) {
    dateRange.$gte = parsedFrom;
  }
  if (parsedTo && !Number.isNaN(parsedTo.getTime())) {
    // Treat `to` as inclusive end-of-day so date pickers behave intuitively.
    const inclusive = new Date(parsedTo);
    inclusive.setHours(23, 59, 59, 999);
    dateRange.$lte = inclusive;
  }
  if (Object.keys(dateRange).length > 0) {
    query.createdAt = dateRange;
  }
  return query;
}

/**
 * The page to fetch and show: the requested one, pulled back to the last page
 * that exists. Used BEFORE reading rows, so a bookmarked page that fell out of
 * range (retention cleanup, a narrower filter) shows the last page rather than
 * an empty one under a page number that does not exist.
 */
export function effectivePage(
  requested: number,
  total: number,
  pageSize: number,
): number {
  const last = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, requested), last);
}

export interface CommandAuditPageData {
  /** A read failed: the rows and total are not the real ones. */
  unavailable: boolean;
  /** The page the rows belong to (the request, clamped to the last page). */
  page: number;
  total: number;
  rows: CommandAuditRow[];
  userOptions: Array<{ id: string; label: string }>;
}

/**
 * One page of the command audit, with user and channel names resolved.
 * Raw command arguments, custom ids and submitted text are never stored in
 * this collection, so none can be shown. `channelNames` maps channel ids to
 * names; unresolved ids fall back to the id.
 */
export async function loadCommandAuditPage(args: {
  client: Client;
  guildId: string;
  filters: CommandAuditFilters;
  page: number;
  pageSize: number;
  channelNames: ReadonlyMap<string, string>;
  /** Discord type per channel id, so a row can show the channel by kind (#1303). */
  channelTypes: ReadonlyMap<string, ChannelType>;
}): Promise<CommandAuditPageData> {
  const { client, guildId, filters, pageSize, channelNames, channelTypes } =
    args;
  const query = buildCommandAuditQuery(guildId, filters);
  let unavailable = false;
  const total = await DiscordCommandAuditLog.countDocuments(query).catch(() => {
    unavailable = true;
    return 0;
  });
  const page = effectivePage(args.page, total, pageSize);
  const docs = await DiscordCommandAuditLog.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .lean()
    .catch(() => {
      unavailable = true;
      return [] as Array<Record<string, unknown>>;
    });

  // Resolve user labels from the guild member cache so the table shows names
  // rather than raw snowflakes. One fetch per request.
  const userIdsOnPage = new Set<string>();
  for (const d of docs) {
    if (typeof d.discordUserId === "string") userIdsOnPage.add(d.discordUserId);
  }
  const userLabels = new Map<string, string>();
  try {
    const guild = await client.guilds.fetch(guildId);
    for (const id of userIdsOnPage) {
      try {
        const member = await guild.members.fetch(id);
        userLabels.set(id, member.displayName ?? member.user.username);
      } catch {
        // Member left the guild or fetch failed; fall back to ID.
      }
    }
  } catch (err) {
    logger.debug("audit page user-label fetch failed", err);
  }

  const rows: CommandAuditRow[] = docs.map((d) => {
    const userId = String(d.discordUserId ?? "");
    const channelId = typeof d.channelId === "string" ? d.channelId : null;
    return {
      createdAt:
        d.createdAt instanceof Date
          ? d.createdAt.toISOString()
          : String(d.createdAt ?? ""),
      discordUserId: userId,
      userLabel: userLabels.get(userId) ?? userId,
      commandName: String(d.commandName ?? ""),
      subcommand: typeof d.subcommand === "string" ? d.subcommand : null,
      channelId,
      channelLabel: channelId
        ? (channelNames.get(channelId) ?? channelId)
        : null,
      channelType: channelId ? (channelTypes.get(channelId) ?? null) : null,
      result: (d.result as "success" | "error" | "denied") ?? "success",
      errorMessage: typeof d.errorMessage === "string" ? d.errorMessage : null,
      durationMs: typeof d.durationMs === "number" ? d.durationMs : 0,
    };
  });
  const userOptions = Array.from(userIdsOnPage)
    .sort()
    .map((id) => ({ id, label: userLabels.get(id) ?? id }));
  return { unavailable, page, total, rows, userOptions };
}
