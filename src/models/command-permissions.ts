import mongoose, { Document, Schema } from "mongoose";

export interface ICommandPermission extends Document {
  commandName: string;
  roleIds: string[];
  guildId: string;
  createdAt: Date;
  updatedAt: Date;
}

const CommandPermissionSchema = new Schema<ICommandPermission>(
  {
    commandName: {
      type: String,
      required: true,
      index: true,
    },
    roleIds: {
      type: [String],
      required: true,
      default: [],
    },
    guildId: {
      type: String,
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// Compound index for efficient queries
CommandPermissionSchema.index({ guildId: 1, commandName: 1 }, { unique: true });

export const CommandPermission = mongoose.model<ICommandPermission>(
  "CommandPermission",
  CommandPermissionSchema,
);
