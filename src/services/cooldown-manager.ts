export class CooldownManager {
  private cooldowns: Map<string, Map<string, number>> = new Map();
  private rateLimits: Map<string, number[]> = new Map();

  public isOnCooldown(
    userId: string,
    command: string,
    cooldownSeconds: number,
  ): boolean {
    const now = Date.now();
    const userCooldowns = this.cooldowns.get(userId) || new Map();
    const lastUsed = userCooldowns.get(command);

    if (!lastUsed) {
      return false;
    }

    const cooldownTime = lastUsed + cooldownSeconds * 1000;
    return now < cooldownTime;
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
    const userCooldowns = this.cooldowns.get(userId);
    if (!userCooldowns) {
      return 0;
    }

    const lastUsed = userCooldowns.get(command);
    if (!lastUsed) {
      return 0;
    }

    const cooldownTime = lastUsed + cooldownSeconds * 1000;
    const remaining = Math.ceil((cooldownTime - Date.now()) / 1000);
    return remaining > 0 ? remaining : 0;
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
    const now = Date.now();
    const userCommands = this.rateLimits.get(userId) || [];
    const windowMs = windowSeconds * 1000;
    const cutoffTime = now - windowMs;

    // Filter out commands outside the time window
    const recentCommands = userCommands.filter((time) => time > cutoffTime);

    return recentCommands.length >= maxCommands;
  }

  /**
   * Track a command execution for rate limiting
   * @param userId - User ID
   * @param windowSeconds - Time window in seconds (used for cleanup)
   */
  public trackCommandExecution(userId: string, windowSeconds: number): void {
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
}
