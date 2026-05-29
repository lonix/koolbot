/**
 * Prometheus / OpenMetrics instrumentation (issue #509).
 *
 * Exposes a single pull-based `/metrics` endpoint that an operator can
 * scrape with Prometheus (or any OpenMetrics-compatible collector). The
 * endpoint lives on the same Express server as `/health` (port 3000) and
 * is entirely opt-in:
 *
 *   - `METRICS_ENABLED=false` (default) → the route is never registered,
 *     so the server returns 404 exactly as before.
 *   - `METRICS_TOKEN=<secret>` → requests must carry a matching
 *     `Authorization: Bearer <secret>` header or they get 401.
 *
 * Both vars are bootstrap config read from `.env` via `config/env.ts`;
 * nothing here touches MongoDB.
 *
 * The module owns a private registry (rather than the prom-client global
 * default) so importing it has no global side effects and tests can reason
 * about exactly which series exist.
 */
import { NextFunction, Request, Response, Router } from "express";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";

export const registry = new Registry();

// Node.js process metrics (process_cpu_*, process_resident_memory_bytes,
// nodejs_*, etc.) — provided automatically by prom-client.
collectDefaultMetrics({ register: registry });

/**
 * Slash commands invoked, labelled by `command` and `status` (`ok`/`error`).
 */
export const commandInvocations = new Counter({
  name: "koolbot_command_invocations_total",
  help: "Slash commands invoked, labelled by command and status",
  labelNames: ["command", "status"] as const,
  registers: [registry],
});

/**
 * Discord.js gateway events received, labelled by `event`.
 */
export const discordEvents = new Counter({
  name: "koolbot_discord_events_total",
  help: "Discord.js events received, labelled by event",
  labelNames: ["event"] as const,
  registers: [registry],
});

/**
 * `1` while the bot is connected to Discord, `0` after disconnect.
 */
export const botUp = new Gauge({
  name: "koolbot_up",
  help: "1 while the bot is connected to Discord, 0 after disconnect",
  registers: [registry],
});

// Pull-based gauge: the current value is read at scrape time from a
// provider registered by the bot (see setVoiceSessionsProvider). Keeping
// the data source behind a callback avoids a hard import cycle between this
// module and the VoiceChannelManager singleton.
let voiceSessionsProvider: (() => number) | null = null;

export const voiceSessionsActive = new Gauge({
  name: "koolbot_voice_sessions_active",
  help: "Current number of active managed voice channels",
  registers: [registry],
  collect(): void {
    if (!voiceSessionsProvider) return;
    try {
      this.set(voiceSessionsProvider());
    } catch (err) {
      logger.error("Error reading active voice session count for metrics", err);
    }
  },
});

/**
 * Register the callback used to populate `koolbot_voice_sessions_active`
 * at scrape time. Called once during bot initialization.
 */
export function setVoiceSessionsProvider(provider: () => number): void {
  voiceSessionsProvider = provider;
}

/** Record a single slash-command invocation outcome. */
export function recordCommandInvocation(
  command: string,
  status: "ok" | "error",
): void {
  commandInvocations.inc({ command, status });
}

/** Record a received Discord gateway event by name. */
export function recordDiscordEvent(event: string): void {
  discordEvents.inc({ event });
}

/** Set the `koolbot_up` gauge to reflect Discord connectivity. */
export function setBotUp(up: boolean): void {
  botUp.set(up ? 1 : 0);
}

export function isMetricsEnabled(): boolean {
  return env.metrics.enabled;
}

/**
 * Constant-time comparison of two strings that first guards on length.
 * `timingSafeEqual` throws when the buffers differ in length, so we check
 * that up front (the length of a secret is not itself sensitive here).
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Express middleware enforcing the optional bearer token. When
 * `METRICS_TOKEN` is unset the endpoint is open (operators are expected to
 * gate it with network ACLs in that case); when set, a missing or
 * mismatched `Authorization: Bearer <token>` header yields 401.
 */
export function metricsAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = env.metrics.token;
  if (!token) {
    next();
    return;
  }

  const header = req.get("authorization") || "";
  const expected = `Bearer ${token}`;
  if (safeEqual(header, expected)) {
    next();
    return;
  }

  res
    .status(401)
    .set("WWW-Authenticate", "Bearer")
    .type("text/plain")
    .send("Unauthorized");
}

/** Express handler that renders the registry in OpenMetrics text format. */
export async function metricsHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = await registry.metrics();
    res.set("Content-Type", registry.contentType);
    res.send(body);
  } catch (err) {
    logger.error("Error rendering metrics", err);
    res.status(500).type("text/plain").send("Internal Server Error");
  }
}

/**
 * Build the `/metrics` router. Returns `null` when metrics are disabled so
 * the caller mounts nothing and unknown paths stay 404.
 */
export function createMetricsRouter(): Router | null {
  if (!isMetricsEnabled()) {
    logger.debug("METRICS_ENABLED is not true; /metrics not mounted");
    return null;
  }
  const router = Router();
  router.get("/metrics", metricsAuth, metricsHandler);
  logger.info(
    `Metrics endpoint mounted at /metrics${
      env.metrics.token ? " (bearer-token protected)" : ""
    }`,
  );
  return router;
}
