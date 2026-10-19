import mongoose, { Document, Schema } from "mongoose";
import { EVENT_GROUP_KINDS, type EventGroupKind } from "./event-group-kinds.js";

/**
 * A host's personal event group presets (#1216, part of the event groups epic
 * #1187): the same preset shape as the server-wide library
 * (`event-group-preset.ts`), but owned by one member and visible only to them.
 *
 * Why a model of its own and not a flag on the library: the library is guild
 * configuration with no member data in it, and keeping it that way is what
 * lets a published preset survive its author's data reset. A personal preset
 * carries `ownerId`, so it is classified in `user-data-registry.ts` (exported
 * on request, deleted on reset). Publishing copies the content into the library
 * (`publishedFrom` on the library row points back here by this row's id, never
 * by owner), so a reset removes the personal row and leaves the copy standing.
 *
 * Nothing here has a schema default: the service always writes every field
 * (`toDoc` in the preset service), so what is stored is exactly what was
 * validated and a stored document reads back unchanged.
 */

export interface IEventGroupPersonalPresetGroup {
  name: string;
  kind: EventGroupKind;
  size: number | null;
  tag: string;
  marker: string;
}

export interface IEventGroupPersonalPreset extends Document {
  guildId: string;
  /** Discord id of the host who owns the preset. */
  ownerId: string;
  name: string;
  /** Lower-cased, whitespace-collapsed name: unique per owner, ignoring case. */
  nameKey: string;
  description: string;
  groupLabel: string;
  leaderLabel: string;
  channelLeadMinutes: number | null;
  tagsEnabled: boolean;
  groups: IEventGroupPersonalPresetGroup[];
  createdAt: Date;
  updatedAt: Date;
}

const groupSchema = new Schema<IEventGroupPersonalPresetGroup>(
  {
    name: { type: String, required: true, maxlength: 50 },
    kind: { type: String, enum: EVENT_GROUP_KINDS, required: true },
    size: { type: Number, min: 1, max: 99 },
    tag: { type: String, maxlength: 8 },
    marker: { type: String, maxlength: 16 },
  },
  { _id: false },
);

const personalPresetSchema = new Schema<IEventGroupPersonalPreset>(
  {
    guildId: { type: String, required: true },
    ownerId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 50 },
    nameKey: { type: String, required: true },
    description: { type: String, maxlength: 200 },
    groupLabel: { type: String, maxlength: 20 },
    leaderLabel: { type: String, maxlength: 20 },
    channelLeadMinutes: { type: Number, min: 0, max: 1440 },
    tagsEnabled: { type: Boolean },
    groups: { type: [groupSchema], default: undefined },
  },
  { timestamps: true },
);

// One preset per name per owner, ignoring case.
personalPresetSchema.index(
  { guildId: 1, ownerId: 1, nameKey: 1 },
  { unique: true },
);

export const EventGroupPersonalPreset =
  mongoose.model<IEventGroupPersonalPreset>(
    "EventGroupPersonalPreset",
    personalPresetSchema,
  );
