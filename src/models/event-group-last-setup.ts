import mongoose, { Document, Schema } from "mongoose";
import { EVENT_GROUP_KINDS, type EventGroupKind } from "./event-group-kinds.js";

/**
 * The group setup a host used for their last event (#1406): the default the
 * event form prefills the next time. One document per host per guild, replaced
 * on every save, so there is nothing to grow and nothing to clean up.
 *
 * Only the setup is kept: the preset id, the rows (name, kind, size, tag,
 * marker), the labels, the lead time and the switches. Never the event, its
 * members, leaders, channel ids or group keys.
 *
 * It carries `ownerId`, so it is classified in `user-data-registry.ts`
 * (exported on request, deleted on reset). Retention is the community's
 * choice: there is no expiry, and the document goes with the member's reset.
 *
 * Nothing here is trusted on read. The form validates what it loads against
 * the limits that apply today (`event-last-setup-service.ts`), because the
 * group cap, the preset library and the text limits can all change after a
 * save.
 */

export interface IEventGroupLastSetupGroup {
  name: string;
  kind: EventGroupKind;
  size: number | null;
  tag: string;
  marker: string;
}

export interface IEventGroupLastSetup extends Document {
  guildId: string;
  /** Discord id of the host the setup belongs to. */
  ownerId: string;
  /** The chosen preset's id, or null for Custom. */
  presetId: string | null;
  groupLabel: string;
  leaderLabel: string;
  channelLeadMinutes: number | null;
  /** The rows, without the captains lobby (that is `captainsLobby`). */
  groups: IEventGroupLastSetupGroup[];
  captainsEnabled: boolean;
  captainCustomisationEnabled: boolean;
  captainsLobby: boolean;
  tagsEnabled: boolean;
  tagsSuffix: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const groupSchema = new Schema<IEventGroupLastSetupGroup>(
  {
    name: { type: String, required: true, maxlength: 50 },
    kind: { type: String, enum: EVENT_GROUP_KINDS, required: true },
    size: { type: Number, min: 1, max: 99 },
    tag: { type: String, maxlength: 8 },
    marker: { type: String, maxlength: 16 },
  },
  { _id: false },
);

const lastSetupSchema = new Schema<IEventGroupLastSetup>(
  {
    guildId: { type: String, required: true },
    ownerId: { type: String, required: true },
    presetId: { type: String, maxlength: 100 },
    groupLabel: { type: String, maxlength: 20 },
    leaderLabel: { type: String, maxlength: 20 },
    channelLeadMinutes: { type: Number, min: 0, max: 1440 },
    groups: { type: [groupSchema], default: undefined },
    captainsEnabled: { type: Boolean },
    captainCustomisationEnabled: { type: Boolean },
    captainsLobby: { type: Boolean },
    tagsEnabled: { type: Boolean },
    tagsSuffix: { type: Boolean },
  },
  { timestamps: true },
);

// One setup per host per guild.
lastSetupSchema.index({ guildId: 1, ownerId: 1 }, { unique: true });

export const EventGroupLastSetup = mongoose.model<IEventGroupLastSetup>(
  "EventGroupLastSetup",
  lastSetupSchema,
);
