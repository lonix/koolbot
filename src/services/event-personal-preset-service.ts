import { EventGroupPersonalPreset } from "../models/event-group-personal-preset.js";
import { EventGroupPreset as EventGroupPresetModel } from "../models/event-group-preset.js";
import {
  createLibraryPresetLocked,
  createLock,
  DUPLICATE_NAME,
  isDuplicateKey,
  MAX_PERSONAL_PRESETS,
  parsePersonalPresetId,
  personalPresetId,
  presetToFormValues,
  rowToEntry,
  toDoc,
  validatePresetForm,
  type PresetData,
  type PresetEntry,
  type WriteResult,
} from "./event-group-preset-service.js";
import { createKeyedLock } from "../utils/keyed-lock.js";
import logger from "../utils/logger.js";

/**
 * A host's personal event group presets (#1216): create, edit, delete, list,
 * and the admin's publish into the server library.
 *
 * Reuses the library's model of a preset (`PresetData`, `validatePresetForm`,
 * `toDoc`, the ids and the resolver in `event-group-preset-service.ts`); only
 * the ownership rules are new:
 *
 * - Every read and write of a personal row filters on `{ guildId, ownerId }`
 *   as well as the id, so an id that belongs to another host is "not found",
 *   never an error that confirms it exists.
 * - A host keeps at most `MAX_PERSONAL_PRESETS` (in the preset service),
 *   counted and inserted under a per-owner lock.
 * - Publishing COPIES the content into the library (`publishedFrom` on the
 *   copy names the personal row's id, never its owner), so the copy keeps
 *   working and stays when its author resets their data or deletes the preset.
 */

/** Serialises the count-then-insert of a create per host. */
const personalCreateLock = createKeyedLock();

const NOT_FOUND = "That preset was not found.";

/** One host's presets, sorted by name. Throws on a read failure (the caller says so). */
export async function listPersonalPresets(
  guildId: string,
  ownerId: string,
): Promise<PresetEntry[]> {
  if (!guildId || !ownerId) return [];
  const rows = await EventGroupPersonalPreset.find({ guildId, ownerId })
    .sort({ nameKey: 1 })
    .lean();
  return (rows as unknown as Parameters<typeof rowToEntry>[0][]).map((r) =>
    rowToEntry(r, "personal"),
  );
}

export function createPersonalPreset(
  guildId: string,
  ownerId: string,
  data: PresetData,
): Promise<WriteResult<{ id: string }>> {
  if (!guildId || !ownerId) {
    return Promise.resolve({ ok: false, error: NOT_FOUND });
  }
  return personalCreateLock.run(`${guildId}:${ownerId}`, async () => {
    try {
      const count = await EventGroupPersonalPreset.countDocuments({
        guildId,
        ownerId,
      });
      if (count >= MAX_PERSONAL_PRESETS) {
        return {
          ok: false as const,
          error: `You already have ${MAX_PERSONAL_PRESETS} presets, which is the most. Delete one first.`,
        };
      }
      const created = await EventGroupPersonalPreset.create({
        guildId,
        ownerId,
        ...toDoc(data),
      });
      return { ok: true as const, id: personalPresetId(created._id) };
    } catch (err) {
      if (isDuplicateKey(err)) {
        return {
          ok: false as const,
          error:
            "You already have a preset with that name (names are compared ignoring case).",
        };
      }
      logger.error("event presets: personal create failed", err);
      return {
        ok: false as const,
        error: "Saving the preset failed. Try again.",
      };
    }
  });
}

export async function updatePersonalPreset(
  guildId: string,
  ownerId: string,
  id: string,
  data: PresetData,
): Promise<WriteResult> {
  const rowId = parsePersonalPresetId(id);
  if (!rowId || !guildId || !ownerId) return { ok: false, error: NOT_FOUND };
  try {
    const updated = await EventGroupPersonalPreset.findOneAndUpdate(
      { _id: rowId, guildId, ownerId },
      { $set: toDoc(data) },
      { returnDocument: "after", runValidators: true },
    );
    return updated ? { ok: true } : { ok: false, error: NOT_FOUND };
  } catch (err) {
    if (isDuplicateKey(err)) {
      return {
        ok: false,
        error:
          "You already have a preset with that name (names are compared ignoring case).",
      };
    }
    logger.error("event presets: personal update failed", err);
    return { ok: false, error: "Saving the preset failed. Try again." };
  }
}

export async function deletePersonalPreset(
  guildId: string,
  ownerId: string,
  id: string,
): Promise<WriteResult<{ name: string }>> {
  const rowId = parsePersonalPresetId(id);
  if (!rowId || !guildId || !ownerId) return { ok: false, error: NOT_FOUND };
  try {
    const row = (await EventGroupPersonalPreset.findOneAndDelete({
      _id: rowId,
      guildId,
      ownerId,
    })) as { name: string } | null;
    return row ? { ok: true, name: row.name } : { ok: false, error: NOT_FOUND };
  } catch (err) {
    logger.error("event presets: personal delete failed", err);
    return { ok: false, error: "Deleting the preset failed. Try again." };
  }
}

// ---------- Admin: all hosts' presets, publish and unpublish ----------

/** Most rows the admin card lists (10 per host leaves room for 50 hosts). */
export const ADMIN_PERSONAL_LIST_MAX = 500;

export interface HostPresetListing {
  entry: PresetEntry;
  ownerId: string;
  /** The id of the library copy, or null when not published. */
  publishedAs: string | null;
}

/**
 * Every host's presets for the admin's publish card, newest owner grouping by
 * owner id then name. Admin-only: the route that calls this is mounted behind
 * the admin check. Throws on a read failure (the caller says so).
 */
export async function listHostPresetsForAdmin(
  guildId: string,
): Promise<{ rows: HostPresetListing[]; truncated: boolean }> {
  const [personal, copies] = await Promise.all([
    EventGroupPersonalPreset.find({ guildId })
      .sort({ ownerId: 1, nameKey: 1 })
      .limit(ADMIN_PERSONAL_LIST_MAX + 1)
      .lean(),
    EventGroupPresetModel.find({
      guildId,
      publishedFrom: { $exists: true },
    }).lean(),
  ]);
  const copyOf = new Map<string, string>();
  for (const c of copies as unknown as Array<{
    _id: unknown;
    publishedFrom?: string;
  }>) {
    if (c.publishedFrom) copyOf.set(c.publishedFrom, `lib:${String(c._id)}`);
  }
  const list = personal as unknown as Array<
    Parameters<typeof rowToEntry>[0] & { ownerId: string }
  >;
  return {
    truncated: list.length > ADMIN_PERSONAL_LIST_MAX,
    rows: list.slice(0, ADMIN_PERSONAL_LIST_MAX).map((row) => ({
      entry: rowToEntry(row, "personal"),
      ownerId: row.ownerId,
      publishedAs: copyOf.get(String(row._id)) ?? null,
    })),
  };
}

/**
 * Publish a host's preset: copy it into the server library, on. The content is
 * validated again with the editor's validator against the current limits (the
 * group cap may have been lowered since it was saved), and the copy goes
 * through the library's own create, so the library cap and the unique-name
 * rule apply exactly as for an admin's own preset. One copy per personal
 * preset: publishing again while the copy exists is refused; once an admin has
 * deleted the copy it can be published again.
 */
export function publishPersonalPreset(
  guildId: string,
  id: string,
  options: { maxCount: number },
): Promise<WriteResult<{ id: string; name: string }>> {
  const rowId = parsePersonalPresetId(id);
  if (!rowId || !guildId) {
    return Promise.resolve({ ok: false, error: NOT_FOUND });
  }
  // The library's create lock: the "already published?" check and the insert
  // must not interleave with another publish or an admin's own create.
  return createLock.run(guildId, async () => {
    try {
      const row = await EventGroupPersonalPreset.findOne({
        _id: rowId,
        guildId,
      }).lean();
      if (!row) return { ok: false as const, error: NOT_FOUND };
      const existing = await EventGroupPresetModel.findOne({
        guildId,
        publishedFrom: rowId,
      }).lean();
      if (existing) {
        return {
          ok: false as const,
          error:
            "That preset is already published. Unpublish it first to publish it again.",
        };
      }
      const entry = rowToEntry(row as never, "personal");
      const checked = validatePresetForm(presetToFormValues(entry), options);
      if (!checked.ok) {
        return {
          ok: false as const,
          error: `It no longer passes the checks: ${checked.errors.join(" ")}`,
        };
      }
      const created = await createLibraryPresetLocked(
        guildId,
        checked.data,
        rowId,
      );
      if (!created.ok) {
        return {
          ok: false as const,
          error:
            created.error === DUPLICATE_NAME
              ? "The server library already has a preset with that name. Ask the host to rename theirs, or delete the library one."
              : created.error,
        };
      }
      return { ok: true as const, id: created.id, name: checked.data.name };
    } catch (err) {
      logger.error("event presets: publish failed", err);
      return {
        ok: false as const,
        error: "Publishing the preset failed. Try again.",
      };
    }
  });
}

/**
 * Unpublish: delete the library copy made from this personal preset. The
 * personal preset itself stays with its host. Any edit an admin made to the
 * copy since is lost with it. Events that already used the copy keep their own
 * groups.
 */
export async function unpublishPersonalPreset(
  guildId: string,
  id: string,
): Promise<WriteResult<{ libraryId: string }>> {
  const rowId = parsePersonalPresetId(id);
  if (!rowId || !guildId) return { ok: false, error: NOT_FOUND };
  try {
    const copy = (await EventGroupPresetModel.findOneAndDelete({
      guildId,
      publishedFrom: rowId,
    })) as { _id: unknown } | null;
    return copy
      ? { ok: true, libraryId: `lib:${String(copy._id)}` }
      : { ok: false, error: "That preset is not published." };
  } catch (err) {
    logger.error("event presets: unpublish failed", err);
    return { ok: false, error: "Unpublishing the preset failed. Try again." };
  }
}
