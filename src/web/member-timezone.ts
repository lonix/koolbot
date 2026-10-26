/**
 * The zone member and host pages show times in (#1538): the one the member
 * chose on the Timezone tab, else the server's zone, as the tab says.
 *
 * Routes read it once per request and pass the zone to the formatters in
 * `utils/timezone.ts` (`formatDateTimeInZone` for an instant with its zone
 * named, `formatInZone` for a calendar day). The moderator pages and the admin
 * pages do not use it: they show UTC on purpose, see `me-moderation-page.ts`.
 */

import { UserNotificationPrefsService } from "../services/user-notification-prefs-service.js";
import { resolveTimezone } from "../utils/timezone.js";

/**
 * The IANA zone to show `userId`'s times in. Never throws: an unset,
 * invalid or unreadable preference falls back to the server zone.
 */
export async function readMemberZone(
  userId: string,
  guildId: string,
): Promise<string> {
  const stored = await UserNotificationPrefsService.getInstance().getTimezone(
    userId,
    guildId,
  );
  return resolveTimezone(stored);
}
