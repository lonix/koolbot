export class CooldownManager {
  private cooldowns: Map<string, Map<string, number>> = new Map();
  private rateLimits: Map<string, number[]> = new Map();

  // Largest windows observed across calls. Used by the periodic sweep so it
  // can safely evict entries that are guaranteed to be expired even though
  // the per-call cooldown/window durations are not stored on each entry.
  private maxCooldownMs = 0;
  private maxRateWindowMs = 0;

  // Run a safety-net sweep every 5 minutes to evict entries belonging to
  // users who went inactive and will never trigger lazy eviction on read.
  private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanupInterval();
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.sweepExpiredEntries();
    }, CooldownManager.CLEANUP_INTERVAL_MS);

    // Don't keep the event loop alive solely for this background sweep.
    this.cleanupInterval.unref?.();
  }

  /**
   * Evict entries that are guaranteed to be expired. Inner cooldown entries
   * older than the largest observed cooldown window are removed, and rate
   * limit arrays that no longer contain any in-window timestamps are dropped.
   * Empty user buckets are deleted entirely so neither Map grows with the
   * total number of distinct users/commands ever seen.
   */
  private sweepExpiredEntries(): void {
    const now = Date.now();

    if (this.maxCooldownMs > 0) {
      const cooldownCutoff = now - this.maxCooldownMs;
      for (const [userId, userCooldowns] of this.cooldowns) {
        for (const [command, lastUsed] of userCooldowns) {
          if (lastUsed <= cooldownCutoff) {
            userCooldowns.delete(command);
          }
        }
        if (userCooldowns.size === 0) {
          this.cooldowns.delete(userId);
        }
      }
    }

    if (this.maxRateWindowMs > 0) {
      const rateCutoff = now - this.maxRateWindowMs;
      for (const [userId, timestamps] of this.rateLimits) {
        const recent = timestamps.filter((time) => time > rateCutoff);
        if (recent.length === 0) {
          this.rateLimits.delete(userId);
        } else if (recent.length !== timestamps.length) {
          this.rateLimits.set(userId, recent);
        }
      }
    }
  }

  /**
   * Stop the background cleanup sweep. Safe to call multiple times.
   */
  public destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  public isOnCooldown(
    userId: string,
    command: string,
    cooldownSeconds: number,
  ): boolean {
    this.trackCooldownWindow(cooldownSeconds);

    const now = Date.now();
    const userCooldowns = this.cooldowns.get(userId);
    if (!userCooldowns) {
      return false;
    }

    const lastUsed = userCooldowns.get(command);
    if (lastUsed === undefined) {
      return false;
    }

    const cooldownTime = lastUsed + cooldownSeconds * 1000;
    if (now < cooldownTime) {
      return true;
    }

    // Expired — evict lazily so stale entries don't accumulate.
    userCooldowns.delete(command);
    if (userCooldowns.size === 0) {
      this.cooldowns.delete(userId);
    }
    return false;
  }

  public setCooldown(userId: string, command: string): void {
    const now = Date.now();
    const userCooldowns = this.cooldowns.get(userId) || new Map();
    userCooldowns.set(command, now);
    this.cooldowns.set(userId, userCooldowns);
  }

  public getRemainingCooldown(
    userId: string,
    command: string,
    cooldownSeconds: number,
  ): number {
    this.trackCooldownWindow(cooldownSeconds);

    const userCooldowns = this.cooldowns.get(userId);
    if (!userCooldowns) {
      return 0;
    }

    const lastUsed = userCooldowns.get(command);
    if (lastUsed === undefined) {
      return 0;
    }

    const cooldownTime = lastUsed + cooldownSeconds * 1000;
    const remaining = Math.ceil((cooldownTime - Date.now()) / 1000);
    if (remaining > 0) {
      return remaining;
    }

    // Expired — evict lazily so stale entries don't accumulate.
    userCooldowns.delete(command);
    if (userCooldowns.size === 0) {
      this.cooldowns.delete(userId);
    }
    return 0;
  }

  public clearCooldown(userId: string, command: string): void {
    const userCooldowns = this.cooldowns.get(userId);
    if (userCooldowns) {
      userCooldowns.delete(command);
      if (userCooldowns.size === 0) {
        this.cooldowns.delete(userId);
      }
    }
  }

  public clearAllCooldowns(): void {
    this.cooldowns.clear();
  }

  /**
   * Check if a user has exceeded the rate limit
   * @param userId - User ID
   * @param maxCommands - Maximum number of commands allowed
   * @param windowSeconds - Time window in seconds
   * @returns true if rate limit exceeded, false otherwise
   */
  public isRateLimited(
    userId: string,
    maxCommands: number,
    windowSeconds: number,
  ): boolean {
    this.trackRateWindow(windowSeconds);

    const now = Date.now();
    const userCommands = this.rateLimits.get(userId);
    if (!userCommands) {
      return false;
    }

    const windowMs = windowSeconds * 1000;
    const cutoffTime = now - windowMs;

    // Filter out commands outside the time window
    const recentCommands = userCommands.filter((time) => time > cutoffTime);

    // Evict the user key once their window has fully expired so the Map does
    // not retain an entry for every user who ever ran a command.
    if (recentCommands.length === 0) {
      this.rateLimits.delete(userId);
      return false;
    }

    return recentCommands.length >= maxCommands;
  }

  /**
   * Track a command execution for rate limiting
   * @param userId - User ID
   * @param windowSeconds - Time window in seconds (used for cleanup)
   */
  public trackCommandExecution(userId: string, windowSeconds: number): void {
    this.trackRateWindow(windowSeconds);

    const now = Date.now();
    const userCommands = this.rateLimits.get(userId) || [];
    const windowMs = windowSeconds * 1000;
    const cutoffTime = now - windowMs;

    // Clean up old entries and add new one
    const recentCommands = userCommands.filter((time) => time > cutoffTime);
    recentCommands.push(now);
    this.rateLimits.set(userId, recentCommands);
  }

  /**
   * Get the number of commands executed within the time window
   * @param userId - User ID
   * @param windowSeconds - Time window in seconds
   * @returns number of commands executed
   */
  public getCommandCount(userId: string, windowSeconds: number): number {
    this.trackRateWindow(windowSeconds);

    const now = Date.now();
    const userCommands = this.rateLimits.get(userId) || [];
    const windowMs = windowSeconds * 1000;
    const cutoffTime = now - windowMs;

    return userCommands.filter((time) => time > cutoffTime).length;
  }

  /**
   * Get remaining time until rate limit resets
   * @param userId - User ID
   * @param maxCommands - Maximum number of commands allowed
   * @param windowSeconds - Time window in seconds
   * @returns seconds until the oldest command in the window expires
   */
  public getRateLimitReset(
    userId: string,
    maxCommands: number,
    windowSeconds: number,
  ): number {
    this.trackRateWindow(windowSeconds);

    const now = Date.now();
    const userCommands = this.rateLimits.get(userId) || [];
    const windowMs = windowSeconds * 1000;
    const cutoffTime = now - windowMs;

    // Get recent commands
    const recentCommands = userCommands.filter((time) => time > cutoffTime);

    // If not rate limited, return 0
    if (recentCommands.length < maxCommands) {
      return 0;
    }

    // Return time until the oldest command expires
    const oldestCommand = recentCommands[0];
    const resetTime = oldestCommand + windowMs;
    const remaining = Math.ceil((resetTime - now) / 1000);
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Clear rate limit data for a specific user
   * @param userId - User ID
   */
  public clearRateLimit(userId: string): void {
    this.rateLimits.delete(userId);
  }

  /**
   * Clear all rate limit data
   */
  public clearAllRateLimits(): void {
    this.rateLimits.clear();
  }

  private trackCooldownWindow(cooldownSeconds: number): void {
    const ms = cooldownSeconds * 1000;
    if (ms > this.maxCooldownMs) {
      this.maxCooldownMs = ms;
    }
  }

  private trackRateWindow(windowSeconds: number): void {
    const ms = windowSeconds * 1000;
    if (ms > this.maxRateWindowMs) {
      this.maxRateWindowMs = ms;
    }
  }
}
