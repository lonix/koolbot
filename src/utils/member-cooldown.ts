import { CooldownManager } from "../services/cooldown-manager.js";

/**
 * One shared, in-memory per-member limiter for member-triggered actions
 * (#1141, #1147). It is a thin facade over {@link CooldownManager}, which
 * already owns the expiry and the periodic sweep, so there is exactly one
 * implementation of "has this member done X recently".
 *
 * State lives in this process only and resets on restart: a cooldown is an
 * abuse brake, not a record, so it is deliberately not persisted (and so is
 * not a member data store for `user-data-registry.ts`).
 *
 * `scope` names the action (and, where it matters, the guild), e.g.
 * `ticket-open:<guildId>`. A limit of `0` or less disables the check.
 */

let limiter: CooldownManager | null = null;

function manager(): CooldownManager {
  limiter ??= new CooldownManager();
  return limiter;
}

/** Seconds the member still has to wait for `scope`, or 0 when they may go. */
export function cooldownRemaining(
  scope: string,
  userId: string,
  seconds: number,
): number {
  if (!(seconds > 0)) return 0;
  return manager().getRemainingCooldown(userId, scope, seconds);
}

/**
 * Start the member's cooldown for `scope` now. Pass the configured duration:
 * when it is not positive the limit is off and nothing is recorded, so an
 * action done while it was off is never retroactively limited and no entry is
 * left that the sweep would not know how to expire.
 */
export function startCooldown(
  scope: string,
  userId: string,
  seconds: number,
): void {
  if (!(seconds > 0)) return;
  manager().setCooldown(userId, scope);
  // Registers the window so the periodic sweep can evict the entry.
  manager().getRemainingCooldown(userId, scope, seconds);
}

/** Forget the member's cooldown for `scope` (e.g. the action failed). */
export function clearMemberCooldown(scope: string, userId: string): void {
  manager().clearCooldown(userId, scope);
}

/**
 * Burst limit: allow `max` actions per `windowSeconds` per member and scope.
 * Records the attempt when allowed. Returns 0 when allowed, otherwise the
 * seconds until the oldest counted action leaves the window. For actions that
 * can legitimately repeat (picking several roles) where a flat cooldown would
 * punish normal use.
 */
export function consumeBurst(
  scope: string,
  userId: string,
  max: number,
  windowSeconds: number,
): number {
  if (!(max > 0) || !(windowSeconds > 0)) return 0;
  const key = `${scope}:${userId}`;
  const m = manager();
  if (m.isRateLimited(key, max, windowSeconds)) {
    return Math.max(1, m.getRateLimitReset(key, max, windowSeconds));
  }
  m.trackCommandExecution(key, windowSeconds);
  return 0;
}

/**
 * Like {@link consumeBurst}, but the slot is an owned reservation that can be
 * given back: when the guarded action fails after reserving, `release()`
 * returns exactly that slot, so a failed action does not count. The slot is
 * still taken up front, so concurrent attempts see it. `wait` is 0 when
 * reserved, otherwise the seconds to wait (and `release` is a no-op).
 */
export function reserveBurst(
  scope: string,
  userId: string,
  max: number,
  windowSeconds: number,
): { wait: number; release: () => void } {
  const none = { wait: 0, release: (): void => {} };
  if (!(max > 0) || !(windowSeconds > 0)) return none;
  const key = `${scope}:${userId}`;
  const m = manager();
  if (m.isRateLimited(key, max, windowSeconds)) {
    return {
      wait: Math.max(1, m.getRateLimitReset(key, max, windowSeconds)),
      release: (): void => {},
    };
  }
  const stamp = m.trackCommandExecution(key, windowSeconds);
  let released = false;
  return {
    wait: 0,
    release: (): void => {
      if (released) return;
      released = true;
      m.releaseCommandExecution(key, stamp);
    },
  };
}

/** Wording for a refusal, e.g. "12 seconds" or "5 minutes". */
export function waitText(seconds: number): string {
  if (seconds >= 120) return `${Math.ceil(seconds / 60)} minutes`;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** Drop all state. For tests. */
export function resetMemberCooldowns(): void {
  limiter?.destroy();
  limiter = null;
}
