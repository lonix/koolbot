import { AuditLogEvent, type Guild } from "discord.js";
import logger from "./logger.js";

/** The audit log entry must be this recent to be taken for the change just seen. */
const AUDIT_WINDOW_MS = 5000;

/**
 * Who made the channel change that was just seen, when the audit log says.
 * Looks at the newest `ChannelUpdate` entry and accepts it only when it names
 * this channel and is a few seconds old. Needs View Audit Log; without it, or
 * on any failure, returns null, so callers must treat the executor as unknown.
 */
export async function findChannelUpdateExecutor(
  guild: Guild,
  channelId: string,
): Promise<{ id: string; name: string | null } | null> {
  try {
    const auditLogs = await guild.fetchAuditLogs({
      type: AuditLogEvent.ChannelUpdate,
      limit: 1,
    });
    const entry = auditLogs.entries.first();
    if (
      entry &&
      entry.targetId === channelId &&
      Date.now() - entry.createdTimestamp < AUDIT_WINDOW_MS &&
      entry.executor
    ) {
      return {
        id: entry.executor.id,
        name: entry.executor.displayName || entry.executor.username || null,
      };
    }
  } catch (error) {
    logger.debug("Could not fetch audit logs for a channel change:", error);
  }
  return null;
}
