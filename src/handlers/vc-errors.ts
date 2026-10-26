import type { ErrorMessage } from "../utils/error-reply.js";

/**
 * The failure wording the voice-channel handlers share (#1510), so a refusal
 * reads the same from a button, a menu and a form. Each says what failed and
 * what the member does next (`docs/design/discord.md` → Replies); they are
 * sent through `replyWithError`.
 */

/** A control, menu or form whose custom id this handler cannot read or act on. */
export const VC_OUT_OF_DATE: Readonly<ErrorMessage> = {
  title: "This control is out of date",
  next: "Use the newest controls in your channel.",
};

/** The clicker is not (or no longer) the room's owner. */
export const VC_NOT_OWNER: Readonly<ErrorMessage> = {
  title: "Only the room owner can use these controls",
  next: "Ask the owner, or start your own room from the lobby.",
};

/** The room's channel no longer exists. */
export const VC_CHANNEL_GONE: Readonly<ErrorMessage> = {
  title: "This voice channel is gone",
  next: "Start a new room from the lobby and use the controls there.",
};

/** Presets are switched off in the server's settings. */
export const VC_PRESETS_OFF: Readonly<ErrorMessage> = {
  title: "Presets are switched off",
  next: "Ask an admin to switch on voice channel presets.",
};
