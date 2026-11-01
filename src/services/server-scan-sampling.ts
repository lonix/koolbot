/**
 * The rules and the report of the Server scan's bot message sampling (#1630).
 * Kept apart from `server-scan-service.ts` so the page can print the same
 * numbers the scan uses without importing the service.
 */

/** Why the bot message sampling stopped before the last channel. */
export type SamplingStopReason = "no-access" | "failed";

/**
 * What the bot message sampling covered. Holds counts and one channel, never
 * anything a member wrote.
 */
export interface ScanSampling {
  /** Text channels whose last messages were read. */
  channelsRead: number;
  /** Text channels it set out to read: the cap, or fewer when the server has fewer. */
  channelsPlanned: number;
  /** All text channels the scan found, so the page can say the cap left some out. */
  textChannels: number;
  /** The cap on channels read. */
  channelLimit: number;
  /** Set when reading stopped early; the channel it could not read and why. */
  stoppedAt: { id: string; name: string; reason: SamplingStopReason } | null;
}

/** Messages read per channel when sampling who writes in it. */
export const SAMPLE_MESSAGES_PER_CHANNEL = 25;
/** Default cap on text channels read by the sampling. */
export const SAMPLE_CHANNEL_LIMIT = 40;
/** A channel needs at least this many messages to be judged. */
export const SAMPLE_MIN_MESSAGES = 5;
/** Share of the sample one bot must have written to count as the one that writes in a channel. */
export const SAMPLE_OWNER_SHARE = 0.6;
