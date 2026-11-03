/**
 * The shared step of a plain form route that may create the channel its Picker
 * asked for (#1665): the Announcements create and one-off forms and the Polls
 * schedule forms. See `form-channel-create.ts` for the rules.
 */

import type { Client } from "discord.js";
import {
  createFormChannel,
  type FormChannel,
} from "../../form-channel-create.js";
import type { FormValues } from "../../form-errors.js";
import { recordAudit } from "../../audit.js";
import { refuseForm, type requireSessionContext } from "./helpers.js";

/**
 * The channel a checked form posts to. A form that asked for a new channel
 * creates it here (the permission is checked again on the server) and the
 * caller stores or posts with its id; a failed create refuses the form with
 * the error under the Channel field and the typed name kept, and nothing is
 * stored. Resolves to `null` when the response has been sent. Call it only
 * after the form's other fields passed and the row it edits is known to exist.
 */
export async function createPendingChannel(
  client: Client,
  req: Parameters<typeof refuseForm>[0],
  res: Parameters<typeof refuseForm>[1],
  page: string,
  formId: string,
  action: string,
  session: ReturnType<typeof requireSessionContext>,
  form: {
    pendingChannel: string | null;
    channelId: string;
    values: FormValues;
  },
): Promise<{ channelId: string; channel: FormChannel | null } | null> {
  if (form.pendingChannel === null) {
    return { channelId: form.channelId, channel: null };
  }
  const made = await createFormChannel(
    client,
    res,
    session.guildId,
    session.discordUserId,
    form.pendingChannel,
  );
  if (made.ok) return { channelId: made.channel.id, channel: made.channel };
  await recordAudit(session, {
    action,
    details: { channelName: form.pendingChannel },
    result: "failure",
    errorMessage: made.error,
  });
  await refuseForm(req, res, {
    page,
    formId,
    errors: { channelId: made.error },
    values: form.values,
  });
  return null;
}
