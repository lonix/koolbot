import mongoose, { Document, Schema } from "mongoose";
import { EVENT_GROUP_KINDS, type EventGroupKind } from "./event-group-kinds.js";

/**
 * The server-wide event group preset library (#1200, part of the event groups
 * epic #1187).
 *
 * Two small guild-scoped collections:
 *
 * - `EventGroupPreset`: the admin's own presets, same shape as the built-ins in
 *   `src/content/event-group-presets.ts`, plus an `enabled` switch. The preset's
 *   id as the rest of the code sees it is `lib:` + the row's ObjectId, so it
 *   survives renames and edits and can never collide with `builtin:`.
 * - `EventGroupPresetToggle`: one row per built-in preset that an admin has
 *   switched off or on. A built-in with no row is ON, which is what keeps an
 *   install that has never opened the page (or has no such collection yet)
 *   behaving exactly as it did before the library existed.
 *
 * Neither holds member data: the actor of a change is in the Web UI audit log,
 * so no user-id field is stored here.
 */

export interface IEventGroupPresetGroup {
  name: string;
  kind: EventGroupKind;
  size: number | null;
  tag: string;
  marker: string;
}

export interface IEventGroupPreset extends Document {
  guildId: string;
  name: string;
  /** Lower-cased, whitespace-collapsed name: the case-insensitive unique key. */
  nameKey: string;
  description: string;
  groupLabel: string;
  leaderLabel: string;
  /** Minutes before the start that channels are created; null = server default. */
  channelLeadMinutes: number | null;
  /** Default for the event form's clan tags box (#1194); a row without it means off. */
  tagsEnabled: boolean;
  groups: IEventGroupPresetGroup[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const groupSchema = new Schema<IEventGroupPresetGroup>(
  {
    name: { type: String, required: true, maxlength: 50 },
    kind: { type: String, enum: EVENT_GROUP_KINDS, default: "team" },
    size: { type: Number, default: null, min: 1, max: 99 },
    tag: { type: String, default: "", maxlength: 8 },
    marker: { type: String, default: "", maxlength: 16 },
  },
  { _id: false },
);

const eventGroupPresetSchema = new Schema<IEventGroupPreset>(
  {
    guildId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 50 },
    // Derived from `name` (already limited to 50) by lower-casing, which can
    // make it longer ("İ" lower-cases to two units), so it carries no limit.
    nameKey: { type: String, required: true },
    description: { type: String, default: "", maxlength: 200 },
    groupLabel: { type: String, default: "Team", maxlength: 20 },
    leaderLabel: { type: String, default: "Leader", maxlength: 20 },
    channelLeadMinutes: { type: Number, default: null, min: 0, max: 1440 },
    tagsEnabled: { type: Boolean, default: false },
    groups: { type: [groupSchema], default: [] },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// One preset per name per guild, ignoring case (compared through `nameKey`).
eventGroupPresetSchema.index({ guildId: 1, nameKey: 1 }, { unique: true });

export const EventGroupPreset = mongoose.model<IEventGroupPreset>(
  "EventGroupPreset",
  eventGroupPresetSchema,
);

export interface IEventGroupPresetToggle extends Document {
  guildId: string;
  /** A built-in preset id, e.g. `builtin:wardogs`. */
  builtinId: string;
  enabled: boolean;
}

const toggleSchema = new Schema<IEventGroupPresetToggle>(
  {
    guildId: { type: String, required: true },
    builtinId: { type: String, required: true, maxlength: 64 },
    enabled: { type: Boolean, required: true },
  },
  { timestamps: true },
);

toggleSchema.index({ guildId: 1, builtinId: 1 }, { unique: true });

export const EventGroupPresetToggle = mongoose.model<IEventGroupPresetToggle>(
  "EventGroupPresetToggle",
  toggleSchema,
);
