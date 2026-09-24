import type { Client } from "discord.js";
import logger from "../utils/logger.js";
import { getBotVersion } from "../utils/version.js";
import {
  classifyUpdate,
  compareVersions,
  formatVersion,
  parseVersion,
  type UpdateKind,
} from "../utils/semver.js";
import { ConfigService } from "./config-service.js";
import { DiscordLogger } from "./discord-logger.js";
import { VersionCheckState } from "../models/version-check-state.js";

/**
 * Web UI update check (#1029): compares the running version with the latest
 * published KoolBot release so an operator can see from the admin panel
 * that their self-hosted instance is out of date.
 *
 * Privacy: the lookup is a plain anonymous `GET` of public release metadata.
 * It sends nothing about this instance — no version, guild or identifier,
 * and no header beyond a generic `User-Agent` (GitHub rejects requests
 * without one) and `Accept`. `core.updatecheck.enabled = false` turns it
 * off entirely; the Web UI then shows only the running version.
 *
 * The result is cached in memory (and persisted in `VersionCheckState` so a
 * restart or a later failed check still has the last good answer). Checks
 * run at startup, every 12 hours, and on demand from the dashboard's
 * "Check now" button, which is throttled so it can't eat GitHub's
 * unauthenticated rate limit (60 requests/hour per IP).
 */

export const RELEASES_API_URL =
  "https://api.github.com/repos/lonix/koolbot/releases/latest";
export const RELEASES_PAGE_URL = "https://github.com/lonix/koolbot/releases";

/** A generic agent string: identifies the software, never the instance. */
export const UPDATE_CHECK_USER_AGENT = "KoolBot-UpdateCheck";

export const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Minimum gap between two network checks, even when forced. */
export const MIN_CHECK_GAP_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const STATE_KEY = "latest-release";

export type VersionCheckStatus =
  | "disabled" // core.updatecheck.enabled is off
  | "unchecked" // enabled, but no check has succeeded yet
  | "error" // the latest check failed (the last good result may still exist)
  | "unknown-running" // the running version can't be compared
  | "up-to-date"
  | "update-available"
  | "ahead"; // running a version newer than the latest release (dev build)

export interface LatestRelease {
  version: string;
  url: string;
  publishedAt: Date | null;
  fetchedAt: Date;
}

export interface VersionCheckSnapshot {
  enabled: boolean;
  running: string;
  latest: LatestRelease | null;
  status: VersionCheckStatus;
  /** Set whenever `latest` is newer than `running`, even while `status` is `error`. */
  updateKind: UpdateKind | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
}

type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/**
 * Only link to release notes on the project's own GitHub releases page; an
 * unexpected `html_url` in the response falls back to a URL built from the
 * tag, so the dashboard never renders an arbitrary link.
 */
function releaseUrlFor(tag: string, htmlUrl: unknown): string {
  const fallback = `${RELEASES_PAGE_URL}/tag/${encodeURIComponent(tag)}`;
  if (typeof htmlUrl !== "string") return fallback;
  // Parse rather than prefix-match: `new URL` resolves `..` segments, so a
  // value like `…/releases/../issues` is judged by where it really points.
  let parsed: URL;
  try {
    parsed = new URL(htmlUrl);
  } catch {
    return fallback;
  }
  const allowed = new URL(RELEASES_PAGE_URL);
  if (
    parsed.origin !== allowed.origin ||
    !parsed.pathname.startsWith(`${allowed.pathname}/`) ||
    parsed.username ||
    parsed.password
  ) {
    return fallback;
  }
  return parsed.toString();
}

function describeRateLimit(headers: {
  get(name: string): string | null;
}): string {
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return `Rate-limited by GitHub until ${new Date(reset * 1000).toISOString()}.`;
  }
  return "Rate-limited by GitHub.";
}

export class VersionCheckService {
  private static instance: VersionCheckService | undefined;

  private readonly configService: ConfigService;
  private readonly fetchImpl: FetchLike;
  private client: Client | null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<VersionCheckSnapshot> | null = null;
  private stateLoaded = false;

  private enabled = true;
  private latest: LatestRelease | null = null;
  private lastAttemptAt: Date | null = null;
  private lastError: string | null = null;
  private notifiedVersion: string | null = null;

  /**
   * A Settings write to `core.updatecheck.enabled` takes effect at once:
   * turning it off drops the banner badge on the very next page, and
   * turning it on runs a check, without waiting for `/config reload`.
   */
  private readonly onConfigChange = (key: string): void => {
    if (key !== "core.updatecheck.enabled") return;
    this.onReload().catch((err) => {
      logger.error("Update check after a settings change failed:", err);
    });
  };

  private readonly onReload = async (): Promise<void> => {
    const wasEnabled = this.enabled;
    await this.refreshEnabled();
    // Check straight away when the check was just switched back on (the
    // persisted result may be stale) or has never produced a result.
    if (this.enabled && (!wasEnabled || !this.latest)) {
      await this.checkNow();
    }
  };

  private constructor(client: Client | null, fetchImpl?: FetchLike) {
    this.client = client;
    this.configService = ConfigService.getInstance();
    this.fetchImpl =
      fetchImpl ??
      ((input, init): ReturnType<FetchLike> =>
        fetch(input, init) as ReturnType<FetchLike>);
  }

  public static getInstance(
    client?: Client,
    fetchImpl?: FetchLike,
  ): VersionCheckService {
    if (!VersionCheckService.instance) {
      VersionCheckService.instance = new VersionCheckService(
        client ?? null,
        fetchImpl,
      );
    } else if (client && !VersionCheckService.instance.client) {
      VersionCheckService.instance.client = client;
    }
    return VersionCheckService.instance;
  }

  /** The instance if one was constructed, without creating one. */
  public static peek(): VersionCheckService | undefined {
    return VersionCheckService.instance;
  }

  public static reset(): void {
    VersionCheckService.instance?.destroy();
    VersionCheckService.instance = undefined;
  }

  /**
   * Load the persisted result, run a first check, and arm the 12-hour
   * interval. The interval is armed even while the check is disabled: each
   * tick re-reads `core.updatecheck.enabled`, so turning it on from the
   * Settings page takes effect without a restart.
   */
  public async start(): Promise<void> {
    if (this.interval) return;
    await this.loadState();
    await this.refreshEnabled();
    this.configService.registerReloadCallback(this.onReload);
    this.configService.addChangeListener(this.onConfigChange);
    this.interval = setInterval(() => {
      this.checkNow().catch((err) => {
        logger.error("Update check failed:", err);
      });
    }, CHECK_INTERVAL_MS);
    this.interval.unref?.();
    if (this.enabled) {
      // Don't hold up startup on a network round-trip.
      void this.checkNow().catch((err) => {
        logger.error("Initial update check failed:", err);
      });
    } else {
      logger.info("Update check disabled (core.updatecheck.enabled = false)");
    }
  }

  public destroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.configService.removeReloadCallback(this.onReload);
    this.configService.removeChangeListener(this.onConfigChange);
  }

  /** Re-read `core.updatecheck.enabled`; returns the fresh value. */
  public async refreshEnabled(): Promise<boolean> {
    try {
      this.enabled = await this.configService.getBoolean(
        "core.updatecheck.enabled",
        true,
      );
    } catch (err) {
      logger.debug("Could not read core.updatecheck.enabled:", err);
    }
    return this.enabled;
  }

  /**
   * Check GitHub for the latest release. Never throws: a failure is
   * recorded in the snapshot (`status: "error"`, `lastError`) and the last
   * successful result is kept. Concurrent calls share one request, and a
   * call within `MIN_CHECK_GAP_MS` of the previous attempt returns the
   * cached result instead of hitting the network again.
   */
  public async checkNow(): Promise<VersionCheckSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runCheck().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runCheck(): Promise<VersionCheckSnapshot> {
    try {
      await this.loadState();
      if (!(await this.refreshEnabled())) return this.getSnapshot();
      if (
        this.lastAttemptAt &&
        Date.now() - this.lastAttemptAt.getTime() < MIN_CHECK_GAP_MS
      ) {
        return this.getSnapshot();
      }
      this.lastAttemptAt = new Date();
      const result = await this.fetchLatest();
      if ("error" in result) {
        this.lastError = result.error;
        logger.warn(`Update check: ${result.error}`);
      } else {
        this.lastError = null;
        this.latest = result;
        await this.saveState();
        await this.maybeNotify();
      }
    } catch (err) {
      // Belt and braces: fetchLatest already maps its own failures.
      this.lastError = "Update check failed unexpectedly.";
      logger.error("Update check failed:", err);
    }
    return this.getSnapshot();
  }

  private async fetchLatest(): Promise<LatestRelease | { error: string }> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(RELEASES_API_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": UPDATE_CHECK_USER_AGENT,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        return { error: "GitHub did not respond in time." };
      }
      return {
        error: `Could not reach GitHub (${err instanceof Error ? err.message : String(err)}).`,
      };
    }

    if (
      res.status === 429 ||
      (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
    ) {
      return { error: describeRateLimit(res.headers) };
    }
    if (res.status === 404) {
      return { error: "No published release was found on GitHub." };
    }
    if (!res.ok) {
      return { error: `GitHub returned HTTP ${res.status}.` };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { error: "GitHub returned an unreadable response." };
    }
    const data = (body ?? {}) as {
      tag_name?: unknown;
      html_url?: unknown;
      published_at?: unknown;
    };
    const tag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
    if (!parseVersion(tag)) {
      return { error: "The latest GitHub release has no version tag." };
    }
    const published =
      typeof data.published_at === "string"
        ? new Date(data.published_at)
        : null;
    return {
      version: formatVersion(tag),
      url: releaseUrlFor(tag, data.html_url),
      publishedAt:
        published && !Number.isNaN(published.getTime()) ? published : null,
      fetchedAt: new Date(),
    };
  }

  /**
   * Post a one-time note to the `core.updates.*` log channel the first time
   * a given newer release is seen. Only marks the version as announced when
   * the category is actually on, so enabling it later still gets the note.
   */
  private async maybeNotify(): Promise<void> {
    const latest = this.latest;
    if (!this.client || !latest) return;
    const kind = classifyUpdate(getBotVersion(), latest.version);
    if (!kind || this.notifiedVersion === latest.version) return;
    try {
      const discordLogger = DiscordLogger.getInstance(this.client);
      if (!(await discordLogger.isCategoryEnabled("updates"))) return;
      const delivered = await discordLogger.logToChannel("updates", {
        title: "⬆️ KoolBot update available",
        description:
          `Running ${formatVersion(getBotVersion())} · latest ${latest.version} (${kind} update).` +
          (kind === "major"
            ? " A major update may include breaking changes — read the release notes first."
            : ""),
        color: "#2563eb",
        fields: [{ name: "Release notes", value: latest.url }],
      });
      // Only a posted note counts: a missing channel or failed send leaves
      // the version unannounced so the next check retries it.
      if (!delivered) return;
      this.notifiedVersion = latest.version;
      await this.saveState();
    } catch (err) {
      logger.error("Could not post the update-available note:", err);
    }
  }

  private async loadState(): Promise<void> {
    if (this.stateLoaded) return;
    try {
      const row = await VersionCheckState.findOne({ key: STATE_KEY }).lean();
      // Only a completed read (a row or none) counts as loaded; a failed
      // one is retried by the next check instead of being given up on.
      this.stateLoaded = true;
      if (!row) return;
      this.notifiedVersion = row.notifiedVersion ?? null;
      if (row.latestVersion && row.releaseUrl && row.fetchedAt) {
        this.latest = {
          version: row.latestVersion,
          url: row.releaseUrl,
          publishedAt: row.publishedAt ?? null,
          fetchedAt: new Date(row.fetchedAt),
        };
      }
    } catch (err) {
      logger.debug("Could not load the persisted update-check state:", err);
    }
  }

  private async saveState(): Promise<void> {
    try {
      await VersionCheckState.updateOne(
        { key: STATE_KEY },
        {
          $set: {
            latestVersion: this.latest?.version ?? null,
            releaseUrl: this.latest?.url ?? null,
            publishedAt: this.latest?.publishedAt ?? null,
            fetchedAt: this.latest?.fetchedAt ?? null,
            notifiedVersion: this.notifiedVersion,
          },
        },
        { upsert: true },
      );
    } catch (err) {
      logger.debug("Could not persist the update-check state:", err);
    }
  }

  /** Synchronous view of the cached result; safe to call on every render. */
  public getSnapshot(): VersionCheckSnapshot {
    const running = getBotVersion();
    const latest = this.latest;
    const updateKind = latest ? classifyUpdate(running, latest.version) : null;
    let status: VersionCheckStatus;
    if (!this.enabled) status = "disabled";
    else if (this.lastError) status = "error";
    else if (!latest) status = "unchecked";
    else {
      const cmp = compareVersions(running, latest.version);
      status =
        cmp === null
          ? "unknown-running"
          : cmp < 0
            ? "update-available"
            : cmp === 0
              ? "up-to-date"
              : "ahead";
    }
    return {
      enabled: this.enabled,
      running,
      latest,
      status,
      updateKind: this.enabled ? updateKind : null,
      lastAttemptAt: this.lastAttemptAt,
      lastError: this.lastError,
    };
  }
}
