import {
  KNOWN_BOTS,
  KOOLBOT_FEATURES,
  findKnownBot,
  type CapabilityCoverage,
  type CoverageLevel,
  type KnownBot,
  type KoolBotFeatureId,
} from "../content/known-bots.js";
import type { ScanBot, ServerScan } from "./server-scan-service.js";
import { GUILD_MEMBERS_INTENT_HOWTO } from "../utils/guild-members-intent.js";

/**
 * Bot replacement report (#1026). Pure: turns a `ServerScan` plus the stored
 * config into per-bot cards and a combined summary. It reads nothing from
 * Discord or Mongo and changes nothing, so the adoption page stays read-only.
 */

export type BotKind = "catalogued" | "custom" | "unknown";

export type SummaryKind =
  "full" | "partial" | "none" | "keep" | "custom" | "unknown";

export interface ReportCapability {
  id: string;
  label: string;
  coverage: CapabilityCoverage;
  /** The KoolBot feature that covers it, when there is one. */
  featureLabel: string | null;
  enabledKey: string | null;
  /** `null` when the capability has no feature to be enabled. */
  enabled: boolean | null;
  webPath: string | null;
  /** Switch-over steps (only for `full` and `partial`). */
  steps: readonly string[];
}

export interface ReportLeftovers {
  /** Channels the bot writes most messages to (needs message sampling). */
  ownedChannels: Array<{
    id: string;
    name: string;
    typeName?: string;
    usedBy: string[];
  }>;
  /** Channels with a member-specific overwrite for the bot itself. */
  memberOverwriteChannels: Array<{
    id: string;
    name: string;
    typeName?: string;
  }>;
  /** KoolBot features already bound to one of the bot's channels. */
  boundFeatures: Array<{
    channel: string;
    typeName?: string;
    features: string[];
  }>;
}

export interface BotCard {
  userId: string;
  tag: string | null;
  kind: BotKind;
  name: string;
  description: string | null;
  /** Source and date the catalogue entry was checked against; null when unverified. */
  verifiedAgainst: string | null;
  summaryKind: SummaryKind;
  summary: string;
  capabilities: ReportCapability[];
  /** Integration roles of the bot. Managed, so KoolBot shows them as locked. */
  roleNames: string[];
  leftovers: ReportLeftovers;
}

export interface SharedCapability {
  id: string;
  label: string;
  bots: string[];
  /** Best level any provider reaches, after counting KoolBot. */
  koolbot: CoverageLevel;
}

export interface CombinedSummary {
  /** Capabilities KoolBot covers (fully or partly) for the detected bots. */
  covered: SharedCapability[];
  /** Capabilities more than one detected bot provides. */
  duplicated: SharedCapability[];
  /** Capabilities nothing in KoolBot covers yet (planned, none or keep). */
  uncovered: SharedCapability[];
  /** Bots whose every capability KoolBot covers fully. */
  removableAfterSwitch: string[];
  /** Plain-language headline. */
  headline: string;
  /** Features KoolBot offers that are not switched on. */
  koolbotAdds: string[];
}

export interface BotReplacementReport {
  cards: BotCard[];
  combined: CombinedSummary;
  /** Shown above the report when detection may be incomplete. */
  warnings: string[];
}

const RANK: Record<CoverageLevel, number> = {
  full: 4,
  partial: 3,
  planned: 2,
  none: 1,
  keep: 0,
};

function isEnabled(config: Record<string, unknown>, key: string): boolean {
  return config[key] === true;
}

function toCapability(
  cap: KnownBot["capabilities"][number],
  config: Record<string, unknown>,
): ReportCapability {
  const covered =
    cap.coverage.level === "full" || cap.coverage.level === "partial";
  const feature = cap.feature ? KOOLBOT_FEATURES[cap.feature] : null;
  return {
    id: cap.id,
    label: cap.label,
    coverage: cap.coverage,
    featureLabel: feature?.label ?? null,
    enabledKey: feature?.enabledKey ?? null,
    enabled: feature ? isEnabled(config, feature.enabledKey) : null,
    webPath: feature?.webPath ?? null,
    steps: covered && feature ? feature.steps : [],
  };
}

/** Headline for one catalogued bot. */
export function summariseCapabilities(
  capabilities: ReadonlyArray<{ coverage: CapabilityCoverage }>,
): { kind: SummaryKind; text: string } {
  // Only a bot whose every capability is `keep` is classified as keep. A
  // `keep` capability inside a mixed bot counts against full replacement:
  // removing the bot would lose the part KoolBot will not replace.
  const total = capabilities.length;
  if (total > 0 && capabilities.every((c) => c.coverage.level === "keep")) {
    return { kind: "keep", text: "Keep: KoolBot does not replace this bot" };
  }
  const full = capabilities.filter((c) => c.coverage.level === "full").length;
  const partial = capabilities.filter(
    (c) => c.coverage.level === "partial",
  ).length;
  if (full === total) {
    return { kind: "full", text: "Can fully replace" };
  }
  if (full + partial === 0) {
    return { kind: "none", text: "No overlap" };
  }
  const base = `Can replace ${full + partial} of ${total} features`;
  return {
    kind: "partial",
    text: partial > 0 ? `${base} (${partial} only partly)` : base,
  };
}

function leftoversFor(bot: ScanBot, scan: ServerScan): ReportLeftovers {
  const ownedChannels = scan.channels
    .filter((c) => c.ownerHint?.botId === bot.userId)
    .map((c) => ({
      id: c.id,
      name: c.name,
      typeName: c.typeName,
      usedBy: c.usedBy,
    }));
  const memberOverwriteChannels = scan.channels
    .filter((c) =>
      c.overwrites.some((o) => o.type === "member" && o.id === bot.userId),
    )
    .map((c) => ({ id: c.id, name: c.name, typeName: c.typeName }));
  const touched = new Set<string>([
    ...ownedChannels.map((c) => c.id),
    ...bot.overwriteChannelIds,
  ]);
  const boundFeatures = scan.channels
    .filter((c) => touched.has(c.id) && c.usedBy.length > 0)
    .map((c) => ({
      channel: c.name,
      typeName: c.typeName,
      features: c.usedBy,
    }));
  return { ownedChannels, memberOverwriteChannels, boundFeatures };
}

function shareOf(
  map: Map<string, { label: string; bots: string[]; best: CoverageLevel }>,
): SharedCapability[] {
  return [...map.entries()].map(([id, v]) => ({
    id,
    label: v.label,
    bots: v.bots,
    koolbot: v.best,
  }));
}

export function buildBotReplacementReport(
  scan: ServerScan,
  config: Record<string, unknown>,
  catalog: readonly KnownBot[] = KNOWN_BOTS,
): BotReplacementReport {
  const roleName = new Map(scan.roles.map((r) => [r.id, r.name]));
  const others = scan.bots.filter((b) => !b.isKoolBot);
  const cards: BotCard[] = others.map((bot) => {
    const entry = findKnownBot(bot.userId, catalog);
    const roleNames = bot.roleIds.map((id) => roleName.get(id) ?? id);
    const leftovers = leftoversFor(bot, scan);
    const display = bot.tag ?? bot.userId;
    if (entry) {
      const capabilities = entry.capabilities.map((c) =>
        toCapability(c, config),
      );
      const s = summariseCapabilities(capabilities);
      return {
        userId: bot.userId,
        tag: bot.tag,
        kind: "catalogued",
        name: entry.name,
        description: entry.description,
        verifiedAgainst: entry.verifiedAgainst ?? null,
        summaryKind: s.kind,
        summary: s.text,
        capabilities,
        roleNames,
        leftovers,
      };
    }
    // Not in the catalogue: only a bot Discord has not verified is called
    // custom. A missing flag (`null`) stays unknown; no claims either way.
    const custom = bot.verified === false;
    return {
      userId: bot.userId,
      tag: bot.tag,
      kind: custom ? "custom" : "unknown",
      name: display,
      description: null,
      verifiedAgainst: null,
      summaryKind: custom ? "custom" : "unknown",
      summary: custom
        ? "Community-built bot; KoolBot doesn't try to replace it"
        : "Not in the catalogue; no claims made",
      capabilities: [],
      roleNames,
      leftovers,
    };
  });

  const catalogued = cards.filter((c) => c.kind === "catalogued");
  const byCap = new Map<
    string,
    { label: string; bots: string[]; best: CoverageLevel }
  >();
  for (const card of catalogued) {
    for (const cap of card.capabilities) {
      const cur = byCap.get(cap.id) ?? {
        label: cap.label,
        bots: [],
        best: cap.coverage.level,
      };
      if (!cur.bots.includes(card.name)) cur.bots.push(card.name);
      if (RANK[cap.coverage.level] > RANK[cur.best])
        cur.best = cap.coverage.level;
      byCap.set(cap.id, cur);
    }
  }
  const all = shareOf(byCap);
  const covered = all.filter(
    (c) => c.koolbot === "full" || c.koolbot === "partial",
  );
  const uncovered = all.filter((c) => !covered.includes(c));
  const duplicated = all.filter((c) => c.bots.length > 1);
  const removableAfterSwitch = catalogued
    .filter((c) => c.summaryKind === "full")
    .map((c) => c.name);

  const koolbotAdds = (Object.keys(KOOLBOT_FEATURES) as KoolBotFeatureId[])
    .map((id) => KOOLBOT_FEATURES[id])
    .filter((f) => !isEnabled(config, f.enabledKey))
    .map((f) => f.label);

  const overlapping = catalogued.filter(
    (c) => c.summaryKind === "full" || c.summaryKind === "partial",
  );
  let headline: string;
  if (overlapping.length === 0) {
    headline =
      koolbotAdds.length > 0
        ? `No overlapping bots found. KoolBot adds: ${koolbotAdds.join(", ")}.`
        : "No overlapping bots found. Every KoolBot feature on this list is already on.";
  } else if (removableAfterSwitch.length > 0) {
    headline = `After the switch you could consider removing: ${removableAfterSwitch.join(", ")}.`;
  } else {
    headline = `KoolBot covers part of what ${overlapping.map((c) => c.name).join(", ")} do. None can be removed outright yet.`;
  }

  const warnings: string[] = [];
  if (!scan.readiness.membersIntent) {
    warnings.push(
      `The bot is not requesting the GuildMembers intent, so a bot without an integration role may be missing from this list. ${GUILD_MEMBERS_INTENT_HOWTO}`,
    );
  }

  return {
    cards,
    combined: {
      covered,
      duplicated,
      uncovered,
      removableAfterSwitch,
      headline,
      koolbotAdds,
    },
    warnings,
  };
}
