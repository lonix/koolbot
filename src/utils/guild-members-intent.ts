/**
 * Operator-facing wording for turning the privileged GuildMembers intent on
 * (#1121). The bot only requests the intent when `GUILD_MEMBERS_INTENT=true`
 * is set (`config/env.ts`, #1038); the Developer Portal toggle merely permits
 * it, and requesting it while the toggle is off makes login fail. Keep every
 * "how do I enable it" text on this constant so it cannot drift again.
 */
export const GUILD_MEMBERS_INTENT_HOWTO =
  'Set GUILD_MEMBERS_INTENT=true in the bot\'s environment and restart it. The "Server Members Intent" toggle must already be on in the Discord developer portal, or login will fail.';
