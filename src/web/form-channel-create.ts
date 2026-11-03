/**
 * A pending channel creation in a plain form (#1665): the Announcements create
 * and one-off forms and the Polls schedule forms. Their `channelId` is not a
 * settings key, so nothing here goes through `coerceConfigValue`; the route
 * reads the posted value with `readPostedChannel` before it validates anything
 * else, and creates the channel only after every other field passed.
 *
 * The creation itself is the Settings pages' (`createPendingChannels`,
 * `setting-create-save.ts`, #1663): the permission is checked again on the
 * server, a name that already exists is selected, the apply runs inside the
 * shared per-server lock and refuses when the server changed meanwhile, and
 * the channel gets no parent and no permission overwrites. This file only adds
 * what a form needs on top: the posted value, and one channel per distinct name.
 */

import type { Client } from "discord.js";
import { normaliseChannelName } from "./channel-create.js";
import { createdNote } from "./setting-create.js";
import { parsePickerCreateValue } from "./setting-pickers.js";

/** What a form's channel field posted: an id as before, a name to create, or a refusal. */
export type PostedChannel =
  | { kind: "id"; id: string }
  | { kind: "create"; name: string }
  | { kind: "refused"; error: string };

/** Read the posted value of a channel field. Always before the value is used as an id. */
export function readPostedChannel(posted: string): PostedChannel {
  const named = parsePickerCreateValue(posted);
  if (!named) return { kind: "id", id: posted };
  return named.ok
    ? { kind: "create", name: named.name }
    : { kind: "refused", error: named.error };
}

/** Why a field that takes only an existing role refuses a `create:` value. */
export const CREATE_NOT_OFFERED_MESSAGE =
  "Pick one from the list; a new one cannot be created from here.";

/** Whether a posted value is a create value (for a field that offers no creation). */
export function isCreateValue(posted: string): boolean {
  return parsePickerCreateValue(posted) !== null;
}

export interface FormChannel {
  id: string;
  /** The name Discord has. */
  name: string;
  /** False when the name already existed and was selected. */
  created: boolean;
}

export type FormChannelResult =
  { ok: true; channels: FormChannel[] } | { ok: false; error: string };

/**
 * Create the channels for the typed names, one per distinct name: two entries
 * that normalise to the same name make ONE channel, and both get its id. The
 * result is in the order of `names`. A failure creates and stores nothing.
 */
export async function createFormChannels(
  client: Client,
  guildId: string,
  actorId: string,
  names: readonly string[],
  signal?: AbortSignal,
): Promise<FormChannelResult> {
  const keyOf = (n: string): string =>
    normaliseChannelName("text", n).toLowerCase();
  const distinct = new Map<string, string>();
  for (const n of names) if (!distinct.has(keyOf(n))) distinct.set(keyOf(n), n);
  // Loaded when a form holds a creation: it pulls in the permission check and
  // the Discord write client, which no other save needs.
  const { createPendingChannels } = await import("./setting-create-save.js");
  const made = await createPendingChannels(
    client,
    guildId,
    actorId,
    [...distinct].map(([key, name]) => ({ key, name })),
    signal,
  );
  if (!made.ok) return made;
  const byKey = new Map(made.channels.map((c) => [c.key, c]));
  return {
    ok: true,
    channels: names.map((n) => {
      const c = byKey.get(keyOf(n)) as NonNullable<
        ReturnType<typeof byKey.get>
      >;
      return { id: c.id, name: c.name, created: c.created };
    }),
  };
}

/** A request's close aborts a creation that still waits for the lock (a closed tab). */
export function abortOnClose(res: {
  once(event: "close", fn: () => void): unknown;
  off(event: "close", fn: () => void): unknown;
  writableEnded: boolean;
  destroyed: boolean;
}): { signal: AbortSignal; done: () => void } {
  const gone = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) gone.abort();
  };
  res.once("close", onClose);
  if (res.destroyed) onClose();
  return { signal: gone.signal, done: () => res.off("close", onClose) };
}

/**
 * The route-level call: create the one channel a form asked for, tied to the
 * request (a closed request abandons a wait for the lock). Call it only after
 * every other field of the form passed, so an invalid form creates nothing.
 */
export async function createFormChannel(
  client: Client,
  res: Parameters<typeof abortOnClose>[0],
  guildId: string,
  actorId: string,
  name: string,
): Promise<{ ok: true; channel: FormChannel } | { ok: false; error: string }> {
  const gone = abortOnClose(res);
  try {
    const made = await createFormChannels(
      client,
      guildId,
      actorId,
      [name],
      gone.signal,
    );
    return made.ok ? { ok: true, channel: made.channels[0] } : made;
  } finally {
    gone.done();
  }
}

/** The plain sentence the flash and the audit entry carry for a channel the save created or selected. */
export function formChannelNote(channel: FormChannel | null): string {
  return channel
    ? createdNote([{ key: "channelId", ...channel }], () => "Channel")
    : "";
}
