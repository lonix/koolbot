/**
 * Decide whether the guild command list Discord has registered already
 * matches the payload we are about to bulk-overwrite (#1307).
 *
 * Discord normalises commands on the way back (fills defaults, returns
 * `null` for absent localisations, adds ids/version/application_id, keeps
 * default_member_permissions as a string), so a naive deep-equal reports
 * false differences. Both sides are reduced to a canonical projection of the
 * fields we send, with Discord's defaults applied to missing values.
 *
 * A false "different" only costs one harmless PUT. A false "same" would skip a
 * needed update, so the projection errs towards reporting differences and the
 * caller falls back to the PUT on any doubt or error.
 */

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collection fields must be an array (or dictionary) or absent. Anything else
 * is malformed: throw so commandListsMatch reports "different" and the caller
 * sends the PUT, instead of the projection silently treating it as absent.
 */
function arr(value: Json): Json[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}

function dict(value: Json): Record<string, Json> | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error("expected object");
  return value;
}

function item(value: Json): Record<string, Json> {
  if (!isRecord(value)) throw new Error("expected object");
  return value;
}

/** undefined, null, {} and [] all mean "absent" to Discord. */
function emptyToNull(value: Json): Json {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (isRecord(value) && Object.keys(value).length === 0) return null;
  return value;
}

/** Permission bits arrive as number, bigint or string; compare as strings. */
function str(value: Json): string | null {
  return value === undefined || value === null ? null : String(value);
}

function sortedKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (isRecord(value)) {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortedKeys(value[key]);
    }
    return out;
  }
  return value;
}

function projectOption(raw: Json): Json {
  const option = item(raw);
  const choices = arr(option.choices);
  const nested = arr(option.options);
  return {
    type: option.type,
    name: option.name,
    name_localizations: emptyToNull(dict(option.name_localizations)),
    description: option.description,
    description_localizations: emptyToNull(
      dict(option.description_localizations),
    ),
    required: option.required ?? false,
    autocomplete: option.autocomplete ?? false,
    choices: emptyToNull(
      choices?.map((c) => {
        const choice = item(c);
        return {
          name: choice.name,
          name_localizations: emptyToNull(dict(choice.name_localizations)),
          value: choice.value,
        };
      }) ?? null,
    ),
    channel_types: emptyToNull(arr(option.channel_types)),
    min_value: option.min_value ?? null,
    max_value: option.max_value ?? null,
    min_length: option.min_length ?? null,
    max_length: option.max_length ?? null,
    // Option order is significant (positional), so it is preserved.
    options: emptyToNull(nested?.map(projectOption) ?? null),
  };
}

/**
 * `contexts` / `integration_types` are only compared when we send them:
 * Discord fills them in itself for commands that omit them.
 */
function projectCommand(raw: Json, compareExtras: boolean): Json {
  const command = item(raw);
  const options = arr(command.options);
  const out: Record<string, Json> = {
    type: command.type ?? 1,
    name: command.name,
    name_localizations: emptyToNull(dict(command.name_localizations)),
    description: command.description ?? "",
    description_localizations: emptyToNull(
      dict(command.description_localizations),
    ),
    default_member_permissions: str(command.default_member_permissions),
    dm_permission: command.dm_permission ?? true,
    nsfw: command.nsfw ?? false,
    options: emptyToNull(options?.map(projectOption) ?? null),
  };
  if (compareExtras) {
    out.contexts = emptyToNull(arr(command.contexts));
    out.integration_types = emptyToNull(arr(command.integration_types));
  }
  return out;
}

function canonical(commands: Json[], compareExtras: boolean): string {
  const projected = commands.map((c) => projectCommand(c, compareExtras));
  // Discord returns commands in no guaranteed order: sort by type then name.
  const keyOf = (c: Json): string =>
    isRecord(c) ? `${String(c.type)}:${String(c.name)}` : "";
  projected.sort((a, b) =>
    keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0,
  );
  return JSON.stringify(sortedKeys(projected));
}

/**
 * True only when `registered` provably equals `desired`. Never throws:
 * any unexpected shape or error returns false so the caller sends the PUT.
 */
export function commandListsMatch(
  desired: unknown,
  registered: unknown,
): boolean {
  try {
    if (!Array.isArray(desired) || !Array.isArray(registered)) return false;
    if (desired.length !== registered.length) return false;

    // Round-trip so builders with toJSON()/bigint fields serialise as sent.
    const sent = JSON.parse(
      JSON.stringify(desired, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    ) as Json[];
    const names = new Set<string>();
    for (const c of sent) {
      if (!isRecord(c) || typeof c.name !== "string") return false;
      const key = `${String(c.type ?? 1)}:${c.name}`;
      if (names.has(key)) return false;
      names.add(key);
    }
    // contexts/integration_types are compared only if any sent command has them.
    const compareExtras = sent.some(
      (c) =>
        isRecord(c) &&
        (c.contexts !== undefined || c.integration_types !== undefined),
    );
    return (
      canonical(sent, compareExtras) ===
      canonical(registered as Json[], compareExtras)
    );
  } catch {
    return false;
  }
}
