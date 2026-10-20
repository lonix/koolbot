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

function projectOption(option: Json): Json {
  if (!isRecord(option)) return option;
  const choices = Array.isArray(option.choices)
    ? option.choices.map((c) =>
        isRecord(c)
          ? {
              name: c.name,
              name_localizations: emptyToNull(c.name_localizations),
              value: c.value,
            }
          : c,
      )
    : null;
  return {
    type: option.type,
    name: option.name,
    name_localizations: emptyToNull(option.name_localizations),
    description: option.description,
    description_localizations: emptyToNull(option.description_localizations),
    required: option.required ?? false,
    autocomplete: option.autocomplete ?? false,
    choices: emptyToNull(choices),
    channel_types: emptyToNull(option.channel_types),
    min_value: option.min_value ?? null,
    max_value: option.max_value ?? null,
    min_length: option.min_length ?? null,
    max_length: option.max_length ?? null,
    // Option order is significant (positional), so it is preserved.
    options: Array.isArray(option.options)
      ? emptyToNull(option.options.map(projectOption))
      : null,
  };
}

/**
 * `contexts` / `integration_types` are only compared when we send them:
 * Discord fills them in itself for commands that omit them.
 */
function projectCommand(command: Json, compareExtras: boolean): Json {
  if (!isRecord(command)) return command;
  const out: Record<string, Json> = {
    type: command.type ?? 1,
    name: command.name,
    name_localizations: emptyToNull(command.name_localizations),
    description: command.description ?? "",
    description_localizations: emptyToNull(command.description_localizations),
    default_member_permissions: str(command.default_member_permissions),
    dm_permission: command.dm_permission ?? true,
    nsfw: command.nsfw ?? false,
    options: Array.isArray(command.options)
      ? emptyToNull(command.options.map(projectOption))
      : null,
  };
  if (compareExtras) {
    out.contexts = emptyToNull(command.contexts);
    out.integration_types = emptyToNull(command.integration_types);
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
