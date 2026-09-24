import mongoose, { Document, Schema } from "mongoose";

/**
 * Persisted result of the Web UI update check (#1029).
 *
 * A single row (`key: "latest-release"`) holding the last successful
 * lookup of the latest KoolBot release, so a restart — or a later failed
 * check — still has something to show, and the release version the
 * `core.updates.*` log channel was last told about, so a restart does not
 * repost the same "update available" note.
 *
 * This is public release metadata only: nothing about members, the guild
 * or the instance is stored here, so it is not part of the member data
 * export/reset registry.
 */
export interface IVersionCheckState extends Document {
  key: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  publishedAt: Date | null;
  fetchedAt: Date | null;
  notifiedVersion: string | null;
}

const VersionCheckStateSchema = new Schema<IVersionCheckState>(
  {
    key: { type: String, required: true, unique: true },
    latestVersion: { type: String, default: null },
    releaseUrl: { type: String, default: null },
    publishedAt: { type: Date, default: null },
    fetchedAt: { type: Date, default: null },
    notifiedVersion: { type: String, default: null },
  },
  { timestamps: false },
);

export const VersionCheckState = mongoose.model<IVersionCheckState>(
  "VersionCheckState",
  VersionCheckStateSchema,
);
