/**
 * The per-server lock for writes that create roles (#1618).
 *
 * Roles and channels are different domains: a role create never touches the
 * channel list, so it does not take the channel lock (`channel-write-lock.ts`)
 * and a channel create does not wait for it. What needs serialising is two
 * role creations that read the roles, both find no role of a name, and both
 * create it; `applyRolePlan` (`role-create.ts`) takes this lock, reads the
 * roles fresh inside it and plans again.
 *
 * The mechanism is the channel lock's (`withKeyedLock`): in this process only,
 * a bounded wait (`CHANNEL_LOCK_WAIT_MS`), cancellable while waiting, released
 * when the work ends. Everything in that file's rules
 * applies here: it is not re-entrant, and every read made inside it goes
 * through `readWithin`.
 *
 * Known limit: other code creates roles outside this lock. The server adoption
 * engine (Role groups, `DiscordAdoptionGateway.createRole`) is guarded by its
 * own database lock, and `applyRolePlan` refuses while an adoption apply is
 * active (a bounded read inside this lock), but an apply that starts after that
 * check is not serialised with it. The reaction-role services
 * (`reaction-role-service.ts`, `reaction-role-group-service.ts`) create roles
 * under `reactionRoleGuildLock` and are not serialised with this lock either;
 * they are not wired in. In both cases the plan's re-read inside this lock
 * still sees a role they had already finished creating.
 */

import { createKeyedLock } from "../utils/keyed-lock.js";
import { withKeyedLock, type ChannelLockResult } from "./channel-write-lock.js";

export const roleWriteLock = createKeyedLock();

/** What an admin reads when the wait ran out. */
export const ROLE_LOCK_BUSY_MESSAGE =
  "Another change to this server's roles is still running, so nothing was changed. Try again in a moment.";

/** Run `work` once every earlier role write for `guildId` has finished; see `withKeyedLock`. */
export function withRoleLock<T>(
  guildId: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<ChannelLockResult<T>> {
  return withKeyedLock(roleWriteLock, guildId, work, signal);
}
