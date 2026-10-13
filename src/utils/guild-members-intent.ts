/**
 * Operator-facing wording for turning the privileged GuildMembers intent on
 * (#1121, #1132). The bot only requests the intent when
 * `GUILD_MEMBERS_INTENT=true` is set (`config/env.ts`, #1038); the Developer
 * Portal toggle merely permits it, and requesting it while the toggle is off
 * makes login fail. So the portal step must come first. Every "how do I enable
 * it" text (startup warnings, web notices, setting descriptions) uses this
 * constant so the two steps, and their order, cannot drift again;
 * `__tests__/utils/guild-members-intent.test.ts` fails on a hand-written copy.
 */
export const GUILD_MEMBERS_INTENT_HOWTO =
  'First turn on the "Server Members Intent" toggle in the Discord developer portal (the bot cannot log in if it requests the intent while the toggle is off), then set GUILD_MEMBERS_INTENT=true in the bot\'s environment and restart it.';
