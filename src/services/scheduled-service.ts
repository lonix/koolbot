import { CronJob } from "cron";
import type { Client } from "discord.js";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import {
  sanitizeCronExpression,
  validateCronExpression,
} from "../utils/cron.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

/**
 * Per-service wording for the shared lifecycle logs.
 *
 * Only the parts that genuinely differ between services are options; every
 * other log line is derived from `label` so the lifecycle reads the same in
 * the logs whichever service produced it.
 */
export interface ScheduledServiceOptions {
  /**
   * Service name as it appears in lifecycle logs — `"Birthday service"`.
   * Lower-cased for the sentence-internal uses ("Reloading birthday
   * service..."), so write it capitalised.
   */
  readonly label: string;
  /**
   * Logged instead of arming the job when the feature is off —
   * `"Birthdays are disabled"`. Free text because the subject is plural for
   * some features and singular for others.
   */
  readonly disabledMessage: string;
  /** Context passed to `validateCronExpression` — `"birthdays"`. */
  readonly cronContext: string;
  /**
   * Noun for the run-level logs — `"Birthday run"`, `"Event scan"`. Used as
   * `"<runLabel> aborted: feature disabled"`.
   */
  readonly runLabel: string;
}

/**
 * The shared lifecycle of KoolBot's cron-driven services (#851).
 *
 * Six services (birthdays, digest, rewind nudge, events, reminders and
 * leaderboard roles) had carried their own copy of the same
 * `start` / `runNow` / `runOnce` / `reload` / `destroy` skeleton: read the
 * enablement key, sanitize and validate the cron expression, arm a `CronJob`,
 * guard against overlapping runs, and stop/re-arm the job when `/config
 * reload` fires. The copies had already drifted — some coalesced concurrent
 * runs and some did not, some logged the next run time and some did not — so
 * the behaviour a reader inferred from one service was not the behaviour of
 * the next.
 *
 * Subclasses now supply only the three things that are actually per-service:
 * whether the feature is enabled, which cron expression to arm, and the work
 * itself. They keep their own singleton `getInstance` / `reset` — the base
 * class deliberately stays out of instance management, which varies in how
 * strictly each service rejects a second client.
 *
 * Two guarantees the base class makes, which callers rely on:
 *
 * - **Runs never overlap.** `runNow()` coalesces concurrent callers onto the
 *   in-flight run, so a slow run and the next cron tick cannot double-deliver.
 * - **A failing run never escapes the cron tick.** The scheduled callback
 *   logs and swallows, because an unhandled rejection there would take the
 *   process down.
 *
 * @typeParam TSummary What one run reports. Services that return a summary
 * object for the WebUI's "run now" buttons pass it here; services whose runs
 * report nothing use the `void` default. `runNow()` widens it with `null`,
 * which means "no run happened" because the feature is disabled — a caller
 * that arrives while a run is in flight joins that run and gets its result.
 */
export abstract class ScheduledService<TSummary = void> {
  protected readonly client: Client;
  protected readonly configService: ConfigService;

  private readonly options: ScheduledServiceOptions;
  private job: CronJob | null = null;
  private initialized = false;
  private inFlight: Promise<TSummary | null> | null = null;

  protected constructor(client: Client, options: ScheduledServiceOptions) {
    this.client = client;
    this.options = options;
    this.configService = ConfigService.getInstance();
    this.configService.registerReloadCallback(() => this.onConfigReload());
  }

  /**
   * Whether the feature is currently enabled. Read fresh on every start,
   * reload and run, so toggling the key takes effect without a restart.
   */
  protected abstract isEnabled(): Promise<boolean>;

  /**
   * The cron expression to arm, read fresh on every start and reload. Return
   * the raw config value — the base class sanitizes and validates it.
   */
  protected abstract resolveSchedule(): Promise<string>;

  /**
   * One pass of the scheduled work. Called only when the feature is enabled
   * and no other run is in flight, so implementations need no guard of their
   * own.
   */
  protected abstract runOnce(): Promise<TSummary>;

  /**
   * Arm the cron job. Idempotent: a second call while already initialized
   * warns and returns, so wiring the service up twice cannot stack jobs.
   *
   * A disabled feature and an invalid cron expression both leave the service
   * initialized-but-idle rather than throwing: neither is a fault the caller
   * can act on, and a bad schedule must not stop the bot from booting.
   */
  public async start(): Promise<void> {
    if (this.initialized) {
      logger.warn(`${this.options.label} is already initialized, skipping...`);
      return;
    }

    try {
      if (!(await this.isEnabled())) {
        logger.info(this.options.disabledMessage);
        this.initialized = true;
        return;
      }

      const rawCron = await this.resolveSchedule();
      const cronExpression = sanitizeCronExpression(rawCron);
      if (!validateCronExpression(cronExpression, this.options.cronContext)) {
        logger.error(
          `${this.options.label} not started: invalid cron "${sanitizeForLog(rawCron)}"`,
        );
        this.initialized = true;
        return;
      }

      const job = new CronJob(cronExpression, () => {
        void this.tick();
      });
      job.start();
      this.job = job;

      logger.info(
        `${this.options.label} started (cron: "${cronExpression}", ` +
          `next run: ${job.nextDate().toLocaleString()})`,
      );
      this.initialized = true;
    } catch (error) {
      logger.error(
        `Error starting ${this.options.label.toLowerCase()}:`,
        error,
      );
      throw error;
    }
  }

  /** Stop the job and arm it again from current config. */
  public async reload(): Promise<void> {
    logger.info(`Reloading ${this.options.label.toLowerCase()}...`);
    this.stopJob();
    await this.start();
  }

  /**
   * Stop the job and return the service to its pre-`start()` state. A run
   * already in flight is left to finish — it holds no reference to the job.
   */
  public destroy(): void {
    this.stopJob();
    logger.info(`${this.options.label} destroyed`);
  }

  /**
   * Run the work now, outside the schedule — from the cron tick, a WebUI
   * "run now" button, or a test.
   *
   * Concurrent callers coalesce onto the run already in flight and get its
   * result, so a slow run plus the next tick cannot produce two runs.
   * Resolves to `null` when the feature is disabled and no run happened.
   */
  public async runNow(): Promise<TSummary | null> {
    // `this.inFlight` is the whole overlap guard: it is assigned before the
    // event loop can hand control to another caller, so a second `runNow()`
    // always sees it and joins the run instead of starting one. Services used
    // to carry a separate `isRunning` boolean alongside it; that flag could
    // never be observed set, so it is deliberately not reproduced here.
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.guardedRun();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async guardedRun(): Promise<TSummary | null> {
    if (!(await this.isEnabled())) {
      logger.info(`${this.options.runLabel} aborted: feature disabled`);
      return null;
    }
    return this.runOnce();
  }

  /**
   * The cron callback. Swallows failures after logging them: `CronJob` does
   * not await the callback, so a rejection here would surface as an unhandled
   * rejection and take the process down.
   */
  private async tick(): Promise<void> {
    try {
      await this.runNow();
    } catch (error) {
      logger.error(`${this.options.label}: scheduled run failed:`, error);
    }
  }

  private stopJob(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    this.initialized = false;
  }

  /**
   * Reconcile with config after `/config reload`. Disabling the feature stops
   * the job; enabling it (or changing its schedule) re-arms from the new
   * values. Failures are logged rather than thrown — the reload callback is
   * invoked for every registered service in turn, and one broken service must
   * not stop the rest from reloading.
   */
  private async onConfigReload(): Promise<void> {
    try {
      logger.info(`${this.options.label}: configuration changed, reloading...`);
      const enabled = await this.isEnabled();
      if (!enabled && this.initialized) {
        logger.info(
          `${this.options.label}: feature disabled, stopping cron job...`,
        );
        this.destroy();
      } else if (enabled) {
        await this.reload();
      }
    } catch (error) {
      logger.error(
        `Error reloading ${this.options.label.toLowerCase()} after configuration change:`,
        error,
      );
    }
  }
}
