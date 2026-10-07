/**
 * Preset groups for the Reaction Roles "Generate a grouped set" form (#1064).
 *
 * Each preset is a named list of role-name + emoji pairs. Entries are plain
 * data: the service decides what to create, so editing a list here never
 * touches behaviour. A single Discord message can carry at most 20 reactions,
 * so every preset must stay at or under {@link MAX_GROUP_ENTRIES}.
 */

export interface ReactionRoleGroupEntry {
  roleName: string;
  emoji: string;
}

export interface ReactionRoleGroupPreset {
  /** Stable key posted by the form. */
  key: string;
  /** Group title, used for the message heading and the idempotency key. */
  name: string;
  /** Short description shown next to the preset in the form. */
  description: string;
  /** Sensible default mode: regions/countries are pick-one. */
  mode: "unique" | "toggle" | "sticky";
  entries: readonly ReactionRoleGroupEntry[];
}

/** Discord allows 20 distinct reactions per message. */
export const MAX_GROUP_ENTRIES = 20;

export const reactionRoleGroupPresets: readonly ReactionRoleGroupPreset[] = [
  {
    key: "regions",
    name: "Region",
    description: "World regions, pick one.",
    mode: "unique",
    entries: [
      { roleName: "Europe", emoji: "🇪🇺" },
      { roleName: "North America", emoji: "🌎" },
      { roleName: "South America", emoji: "🌴" },
      { roleName: "Asia", emoji: "🌏" },
      { roleName: "Africa", emoji: "🌍" },
      { roleName: "Oceania", emoji: "🦘" },
      { roleName: "Middle East", emoji: "🕌" },
    ],
  },
  {
    key: "countries",
    name: "Country",
    description:
      "20 common countries (Nordics first), pick one. Use a custom group for other lists.",
    mode: "unique",
    entries: [
      { roleName: "Norway", emoji: "🇳🇴" },
      { roleName: "Sweden", emoji: "🇸🇪" },
      { roleName: "Denmark", emoji: "🇩🇰" },
      { roleName: "Finland", emoji: "🇫🇮" },
      { roleName: "Iceland", emoji: "🇮🇸" },
      { roleName: "United Kingdom", emoji: "🇬🇧" },
      { roleName: "Ireland", emoji: "🇮🇪" },
      { roleName: "Germany", emoji: "🇩🇪" },
      { roleName: "Netherlands", emoji: "🇳🇱" },
      { roleName: "France", emoji: "🇫🇷" },
      { roleName: "Spain", emoji: "🇪🇸" },
      { roleName: "Italy", emoji: "🇮🇹" },
      { roleName: "Poland", emoji: "🇵🇱" },
      { roleName: "United States", emoji: "🇺🇸" },
      { roleName: "Canada", emoji: "🇨🇦" },
      { roleName: "Brazil", emoji: "🇧🇷" },
      { roleName: "Australia", emoji: "🇦🇺" },
      { roleName: "Japan", emoji: "🇯🇵" },
      { roleName: "India", emoji: "🇮🇳" },
      { roleName: "South Africa", emoji: "🇿🇦" },
    ],
  },
];

export function findReactionRoleGroupPreset(
  key: string,
): ReactionRoleGroupPreset | undefined {
  return reactionRoleGroupPresets.find((p) => p.key === key);
}
