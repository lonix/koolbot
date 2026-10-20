import { readDesignTokensJson } from "./design-tokens.js";

/**
 * The one place a Discord embed accent colour is chosen (#1324, epic #1314).
 * Pick the kind by meaning; the value comes from the `embed-*` tokens in
 * `docs/design/tokens.json`, so the bar colours are changed there and nowhere
 * else. Do not write `setColor(0x...)` anywhere else
 * (`__tests__/utils/embed-style-guard.test.ts` fails on it).
 *
 * - `brand`: KoolBot's own messages (help, welcome, announcements by default)
 * - `ok`: something worked or is on
 * - `warn`: needs attention
 * - `danger`: failed, removed or punitive
 * - `neutral`: plain information; also the default when a community has not
 *   chosen a colour (a colour the community chose always wins over this)
 * - `lore`: activity and history (stats, Rewind, digest, quotes, achievements)
 */
export type EmbedColorKind =
  "brand" | "ok" | "warn" | "danger" | "neutral" | "lore";

export interface TokenFile {
  color: { tokens: { name: string; value: string }[] };
}

const KINDS: readonly EmbedColorKind[] = [
  "brand",
  "ok",
  "warn",
  "danger",
  "neutral",
  "lore",
];

let cache: Map<EmbedColorKind, number> | null = null;

/** Follow `{alias}` values (e.g. `embed-warn` -> `warn`) down to a `#rrggbb`. */
function resolve(
  byName: Map<string, string>,
  name: string,
  seen: string[] = [],
): number {
  if (seen.includes(name)) {
    throw new Error(
      `Design token alias cycle: ${[...seen, name].join(" -> ")}`,
    );
  }
  const raw = byName.get(name);
  if (raw === undefined) throw new Error(`Design token "${name}" is missing`);
  const alias = /^\{([a-z0-9-]+)\}$/.exec(raw);
  if (alias) return resolve(byName, alias[1], [...seen, name]);
  const hex = /^#([0-9a-fA-F]{6})$/.exec(raw);
  if (!hex) {
    throw new Error(`Design token "${name}" is not a #rrggbb colour: ${raw}`);
  }
  return parseInt(hex[1], 16);
}

/** Resolve the six `embed-*` tokens of a parsed `tokens.json`. Throws on a missing or malformed one. */
export function resolveEmbedColors(
  file: TokenFile,
): Map<EmbedColorKind, number> {
  const byName = new Map(file.color.tokens.map((t) => [t.name, t.value]));
  const resolved = new Map<EmbedColorKind, number>();
  for (const kind of KINDS) {
    resolved.set(kind, resolve(byName, `embed-${kind}`));
  }
  return resolved;
}

function load(): Map<EmbedColorKind, number> {
  cache ??= resolveEmbedColors(readDesignTokensJson() as TokenFile);
  return cache;
}

/** The embed accent colour (`0xRRGGBB`) for a kind, from the design tokens. */
export function embedColor(kind: EmbedColorKind): number {
  return load().get(kind) as number;
}

/** Test seam: drop the resolved colours so the next call re-reads the tokens. */
export function resetEmbedStyleForTests(): void {
  cache = null;
}
