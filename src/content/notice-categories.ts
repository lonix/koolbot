import { ColorResolvable } from "discord.js";

/**
 * Display config (emoji, embed color, label) for each notice category.
 * Keyed by the `Notice.category` field — keep keys in sync with the
 * Notice model's allowed category values.
 */

export interface NoticeCategoryInfo {
  emoji: string;
  color: ColorResolvable;
  label: string;
}

export const NOTICE_CATEGORIES = {
  general: {
    emoji: "📋",
    color: 0x5865f2 as ColorResolvable,
    label: "General",
  },
  rules: { emoji: "📜", color: 0xe74c3c as ColorResolvable, label: "Rules" },
  info: {
    emoji: "ℹ️",
    color: 0x3498db as ColorResolvable,
    label: "Information",
  },
  help: { emoji: "❓", color: 0x9b59b6 as ColorResolvable, label: "Help" },
  "game-servers": {
    emoji: "🎮",
    color: 0x2ecc71 as ColorResolvable,
    label: "Game Servers",
  },
} as const satisfies Record<string, NoticeCategoryInfo>;

export type NoticeCategoryKey = keyof typeof NOTICE_CATEGORIES;
