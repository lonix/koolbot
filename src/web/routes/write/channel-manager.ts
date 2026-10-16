/**
 * Channel Manager — list, create, edit, reorder and delete categories and
 * text/voice channels (#1065).
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf`. Web UI admin
 * management has no feature switch. Writes go through
 * `CommandManager.makeDiscordApiCall`, and every POST records exactly one
 * audit entry. Deleting refuses channels KoolBot manages
 * and needs the confirmation page's `confirm` field; the confirmation is
 * re-checked here, never trusted from the page.
 */

import { Router } from "express";
import {
  ChannelType,
  Client,
  Routes,
  type Guild,
  type GuildChannelCreateOptions,
  type GuildChannel,
} from "discord.js";
import logger from "../../../utils/logger.js";
import { getErrorMessage } from "../../../utils/error-guards.js";
import { CommandManager } from "../../../services/command-manager.js";
import { recordAudit } from "../../audit.js";
import { getDisplayedRemainingMs } from "../../admin-layout.js";
import { readSignedFlash } from "../../http-flash.js";
import {
  buildChannelTree,
  canMove,
  checkCapacity,
  neighbourOf,
  siblingsOf,
  confirmationToken,
  deleteVerdict,
  isSnowflake,
  resolveParent,
  validateBitrateKbps,
  validateName,
  validateTopic,
  validateUserLimit,
  type ManagedChannelView,
} from "../../channel-manager.js";
import {
  botCanManageChannels,
  fetchChannelViews,
  loadProtection,
  loadRecentChanges,
  maxBitrateOf,
} from "../../channel-manager-data.js";
import {
  CHANNELS_PATH,
  renderChannelDeleteConfirmPage,
  renderChannelManagerPage,
} from "../../channel-manager-view.js";
import {
  asyncHandler,
  flashRedirect,
  getCsrfFromReq,
  navStatusForPage,
  requireSessionContext,
} from "./helpers.js";

const DISCORD_UNKNOWN_CHANNEL = 10003;

/**
 * discord.js's REST client queues a request behind a rate-limit bucket that is
 * exhausted (PATCH /channels/:id allows only a couple of renames and edits per
 * channel every 10 minutes, and the bucket is shared by every field) and waits
 * for the reset, which can be several minutes. If the wait is short we let it
 * run; if Discord says it is longer, we cancel the request and tell the admin.
 */
const RATE_LIMIT_FAST_FAIL_MS = 20_000;

/** Discord told the REST client to wait longer than we are willing to. */
class ChannelRateLimitedError extends Error {
  constructor(readonly waitMs: number) {
    const minutes = Math.ceil(waitMs / 60_000);
    super(
      `Discord is limiting changes to this channel right now (it allows only a few renames and edits per channel every 10 minutes). Nothing was changed and the request was cancelled. Try again in about ${
        waitMs < 60_000
          ? `${Math.ceil(waitMs / 1000)} seconds`
          : `${minutes} minute${minutes === 1 ? "" : "s"}`
      }.`,
    );
    this.name = "ChannelRateLimitedError";
  }
}

/** The part of discord.js's REST client the guard listens to. */
interface RestEvents {
  on?(
    event: "rateLimited",
    listener: (info: {
      majorParameter?: string;
      timeToReset?: number;
      route?: string;
      method?: string;
    }) => void,
  ): unknown;
  off?(event: "rateLimited", listener: (...args: never[]) => void): unknown;
}

/**
 * Run one Discord request through `makeDiscordApiCall`, cancellably. Each
 * attempt gets an AbortSignal. It is aborted when the attempt fails or times
 * out (so a request still queued behind a rate limit is dropped, never applied
 * later behind the admin's back), and when Discord reports a rate-limit wait
 * longer than `RATE_LIMIT_FAST_FAIL_MS` for this request's bucket (the admin
 * hears it at once instead of after the 30 s timeout).
 */
export async function cancellableCall<T>(
  manager: Pick<CommandManager, "makeDiscordApiCall">,
  restClient: unknown,
  fn: (signal: AbortSignal) => Promise<T>,
  opName: string,
  scopeId: string,
  retryOnTimeout: boolean,
): Promise<T> {
  const rest = restClient as RestEvents | undefined;
  const holder: { controller: AbortController | null } = { controller: null };
  const attempt = (): Promise<T> => {
    // A retry must not leave the previous attempt queued.
    holder.controller?.abort();
    const controller = new AbortController();
    holder.controller = controller;
    return new Promise<T>((resolve, reject) => {
      const onLimit = (info: {
        majorParameter?: string;
        timeToReset?: number;
        route?: string;
      }): void => {
        if (info.majorParameter !== scopeId) return;
        logger.warn(
          `channel manager: Discord rate limit on ${opName} (${info.route}), reset in ${info.timeToReset}ms`,
        );
        if ((info.timeToReset ?? 0) > RATE_LIMIT_FAST_FAIL_MS) {
          controller.abort();
          reject(new ChannelRateLimitedError(info.timeToReset ?? 0));
        }
      };
      rest?.on?.("rateLimited", onLimit);
      const detach = (): void => {
        rest?.off?.("rateLimited", onLimit);
      };
      fn(controller.signal).then(
        (value) => {
          detach();
          resolve(value);
        },
        (error: unknown) => {
          detach();
          reject(error);
        },
      );
      // The rate-limit rejection above also has to detach.
      controller.signal.addEventListener("abort", detach, { once: true });
    });
  };
  try {
    return await manager.makeDiscordApiCall(
      attempt,
      opName,
      30000,
      3,
      retryOnTimeout,
    );
  } catch (error) {
    // Cancel whatever is still queued or in flight.
    holder.controller?.abort();
    throw error;
  }
}

interface Outcome {
  ok: boolean;
  text: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

interface ActionContext {
  guild: Guild;
  channels: ManagedChannelView[];
  maxBitrate: number;
  body: Record<string, unknown>;
  params: { id: string };
  reason: string;
  /** Discord REST client, for requests that must be cancellable. */
  rest: Client["rest"];
  /**
   * Run one Discord request through `makeDiscordApiCall`. `fn` gets an
   * AbortSignal that is aborted when the attempt fails or times out, so a
   * request still queued behind a rate limit is cancelled, never applied
   * later. `scopeId` is the REST bucket's major parameter (the channel or
   * guild id) so a rate-limit notice for another channel is ignored.
   */
  call: <T>(
    fn: (signal: AbortSignal) => Promise<T>,
    name: string,
    scopeId: string,
    retryOnTimeout?: boolean,
  ) => Promise<T>;
}

const refuse = (text: string, extra: Partial<Outcome> = {}): Outcome => ({
  ok: false,
  text,
  ...extra,
});

const KINDS = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
} as const;

export function createChannelManagerRouter(client: Client): Router {
  const router = Router();

  async function fetchGuild(guildId: string): Promise<Guild | null> {
    try {
      return await client.guilds.fetch(guildId);
    } catch (error) {
      logger.warn("channel manager: guild fetch failed", error);
      return null;
    }
  }

  async function pageBase(
    req: Parameters<typeof requireSessionContext>[0],
  ): Promise<{
    csrfToken: string;
    remainingMs: number;
    navFeatureStatus: Awaited<ReturnType<typeof navStatusForPage>>;
  }> {
    const session = requireSessionContext(req);
    return {
      csrfToken: getCsrfFromReq(req),
      remainingMs: getDisplayedRemainingMs(session),
      navFeatureStatus: await navStatusForPage(),
    };
  }

  async function liveChannel(
    guild: Guild,
    id: string,
  ): Promise<GuildChannel | null> {
    const found = await guild.channels.fetch(id).catch(() => null);
    return found && !found.isThread() ? (found as GuildChannel) : null;
  }

  /**
   * Wrap one POST: the enable gate, the guild and permission checks, the
   * handler, one audit entry and the flash redirect.
   */
  function write(
    name: string,
    handler: (ctx: ActionContext) => Promise<Outcome>,
  ): ReturnType<typeof asyncHandler> {
    return asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const params = { id: String(req.params.id ?? "") };
      let outcome: Outcome;
      try {
        const guild = await fetchGuild(session.guildId);
        if (!guild) {
          outcome = refuse("Discord couldn't be reached, so nothing changed.");
        } else if (!(await botCanManageChannels(guild))) {
          outcome = refuse(
            "KoolBot doesn't have the Manage Channels permission. Grant it in Discord, then try again.",
          );
        } else {
          const manager = CommandManager.getInstance(client);
          outcome = await handler({
            guild,
            channels: await fetchChannelViews(guild),
            maxBitrate: maxBitrateOf(guild),
            body: (req.body as Record<string, unknown> | undefined) ?? {},
            params,
            reason: `KoolBot web UI, by ${session.discordUserId}`,
            rest: client.rest,
            call: (fn, opName, scopeId, retryOnTimeout = false) =>
              cancellableCall(
                manager,
                client.rest,
                fn,
                opName,
                scopeId,
                retryOnTimeout,
              ),
          });
        }
      } catch (error) {
        logger.error(`channel manager: ${name} failed`, error);
        const message = getErrorMessage(error);
        outcome = refuse(
          error instanceof ChannelRateLimitedError
            ? message
            : /timeout/i.test(message)
              ? "Discord didn't answer within 30 seconds, so the request was cancelled and nothing should have changed. Check the channel in Discord before trying again."
              : `Discord refused the change: ${message.slice(0, 200)}`,
        );
      }
      await recordAudit(session, {
        action: `channels.${name}`,
        targetId: outcome.targetId ?? (params.id || null),
        details: outcome.details,
        result: outcome.ok ? "success" : "failure",
        errorMessage: outcome.ok ? null : outcome.text,
      });
      flashRedirect(res, CHANNELS_PATH, {
        type: outcome.ok ? "ok" : "err",
        text: outcome.text,
      });
    });
  }

  function targetOf(ctx: ActionContext): ManagedChannelView | Outcome {
    if (!isSnowflake(ctx.params.id)) {
      return refuse("That isn't a channel on this server.");
    }
    const target = ctx.channels.find((c) => c.id === ctx.params.id);
    if (!target) return refuse("That channel no longer exists.");
    if (target.kind === "other") {
      return refuse(
        `"${target.name}" is a ${target.typeLabel} channel; only text channels, voice channels and categories are managed here.`,
      );
    }
    return target;
  }

  router.get(
    "/channels",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const base = await pageBase(req);
      const flash = readSignedFlash(req.query);
      const props = {
        ...base,
        channels: null as ManagedChannelView[] | null,
        tree: null as ReturnType<typeof buildChannelTree> | null,
        protection: null as Map<string, string[]> | null,
        botCanManage: false,
        recentChanges: null as Awaited<ReturnType<typeof loadRecentChanges>>,
        maxBitrate: 0,
        error: undefined as string | undefined,
        flash: flash
          ? { type: flash.type, text: flash.text.slice(0, 500) }
          : null,
      };
      const guild = await fetchGuild(session.guildId);
      if (!guild) {
        props.error = "Discord couldn't be reached.";
      } else {
        try {
          props.channels = await fetchChannelViews(guild);
          props.tree = buildChannelTree(props.channels);
          props.maxBitrate = maxBitrateOf(guild);
          props.botCanManage = await botCanManageChannels(guild);
          props.protection = await loadProtection(guild, props.channels).catch(
            (err) => {
              logger.warn("channel manager: protection unavailable", err);
              return null;
            },
          );
        } catch (error) {
          logger.warn("channel manager: could not read the server", error);
          props.channels = null;
          props.tree = null;
          props.error = "The server's channels couldn't be read from Discord.";
        }
      }
      props.recentChanges = await loadRecentChanges(session.guildId);
      res.type("text/html").send(renderChannelManagerPage(props));
    }),
  );

  router.get(
    "/channels/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const base = await pageBase(req);
      const id = String(req.params.id ?? "");
      const guild = await fetchGuild(session.guildId);
      if (!guild) {
        flashRedirect(res, CHANNELS_PATH, {
          type: "err",
          text: "Discord couldn't be reached.",
        });
        return;
      }
      let channel: ManagedChannelView | null = null;
      let verdict: ReturnType<typeof deleteVerdict> = { ok: true };
      let allChannels: ManagedChannelView[] = [];
      try {
        const channels = await fetchChannelViews(guild);
        allChannels = channels;
        channel = isSnowflake(id)
          ? (channels.find((c) => c.id === id) ?? null)
          : null;
        if (channel && channel.kind === "other") {
          verdict = {
            ok: false,
            reasons: [],
            message: `"${channel.name}" is a ${channel.typeLabel} channel; only text channels, voice channels and categories are managed here.`,
          };
        } else if (channel) {
          verdict = deleteVerdict(
            channel,
            channels,
            await loadProtection(guild, channels),
          );
        }
      } catch (error) {
        logger.warn("channel manager: delete check failed", error);
        verdict = {
          ok: false,
          reasons: [],
          message:
            "Couldn't verify whether KoolBot manages this channel, so it can't be deleted right now. Try again in a moment.",
        };
      }
      res.type("text/html").send(
        renderChannelDeleteConfirmPage({
          ...base,
          channel,
          verdict,
          confirmToken: channel ? confirmationToken(channel, allChannels) : "",
          botCanManage: await botCanManageChannels(guild),
        }),
      );
    }),
  );

  router.post(
    "/channels/create",
    write("create", async (ctx) => {
      const type = String(ctx.body.type ?? "");
      if (type !== "text" && type !== "voice" && type !== "category") {
        return refuse("Pick text channel, voice channel or category.");
      }
      const name = validateName(ctx.body.name);
      if (!name.ok) return refuse(name.error);
      const options: GuildChannelCreateOptions & { type: ChannelType } = {
        name: name.value,
        type: KINDS[type],
        reason: ctx.reason,
      } as GuildChannelCreateOptions & { type: ChannelType };
      let parentId: string | null = null;
      if (type !== "category") {
        const parent = resolveParent(ctx.channels, ctx.body.parent);
        if (!parent.ok) return refuse(parent.error);
        parentId = parent.value;
        if (parentId) options.parent = parentId;
      }
      const room = checkCapacity(ctx.channels, { parentId, creating: true });
      if (!room.ok) return refuse(room.error);
      if (type === "text") {
        const topic = validateTopic(ctx.body.topic);
        if (!topic.ok) return refuse(topic.error);
        if (topic.value) options.topic = topic.value;
      }
      if (type === "voice") {
        const limit = validateUserLimit(ctx.body.userLimit);
        if (!limit.ok) return refuse(limit.error);
        const bitrate = validateBitrateKbps(ctx.body.bitrate, ctx.maxBitrate);
        if (!bitrate.ok) return refuse(bitrate.error);
        options.userLimit = limit.value;
        if (bitrate.value !== undefined) options.bitrate = bitrate.value;
      }
      // A create is not idempotent: never retry it after a timeout.
      const created = await ctx.call(
        () => ctx.guild.channels.create(options),
        "create channel",
        ctx.guild.id,
        false,
      );
      return {
        ok: true,
        text: `Created ${type === "category" ? "category" : `${type} channel`} "${created.name}".`,
        targetId: created.id,
        details: { type, name: created.name, parentId },
      };
    }),
  );

  router.post(
    "/channels/:id/edit",
    write("edit", async (ctx) => {
      const target = targetOf(ctx);
      if ("ok" in target) return target;
      const changes: Record<string, unknown> = {};
      // The form carries what it displayed (`orig_*` fields). A field counts
      // as edited only when the admin changed it from that baseline, so saving
      // one field never writes the others back: not even their normalised
      // forms (a bitrate shown rounded), and not stale values over a newer
      // edit made elsewhere. An edited field whose live value no longer matches
      // the baseline is a lost-update conflict and the whole save is refused.
      // A request without baselines (a hand-made POST) is compared to the live
      // channel instead.
      const body = ctx.body;
      const posted = (key: string): string => String(body[key] ?? "");
      const baseline = (key: string, live: string): string =>
        typeof body[`orig_${key}`] === "string"
          ? (body[`orig_${key}`] as string)
          : live;
      const stale: string[] = [];
      const nl = (v: string): string => v.replace(/\r\n?/g, "\n");
      // A browser posts a textarea with CRLF breaks and drops a leading newline.
      const sameTopic = (a: string, b: string): boolean =>
        nl(a) === nl(b) ||
        nl(a) === nl(b).replace(/^\n/, "") ||
        nl(a).replace(/^\n/, "") === nl(b);
      const sameNumber = (a: string, b: string): boolean =>
        a.trim() === b.trim() ||
        (/^\d*$/.test(a.trim()) &&
          /^\d*$/.test(b.trim()) &&
          Number(a.trim() || 0) === Number(b.trim() || 0));

      if (posted("name") !== baseline("name", target.name)) {
        const name = validateName(posted("name"));
        if (!name.ok) return refuse(name.error);
        if (name.value !== target.name) {
          if (target.name !== baseline("name", target.name)) stale.push("name");
          else changes.name = name.value;
        }
      }
      if (target.kind === "text") {
        const live = target.topic ?? "";
        if (!sameTopic(posted("topic"), baseline("topic", live))) {
          const topic = validateTopic(nl(posted("topic")));
          if (!topic.ok) return refuse(topic.error);
          if (topic.value !== live) {
            if (!sameTopic(live, baseline("topic", live))) stale.push("topic");
            else changes.topic = topic.value;
          }
        }
      }
      if (target.kind === "voice") {
        const liveLimit = String(target.userLimit ?? "");
        if (
          !sameNumber(posted("userLimit"), baseline("userLimit", liveLimit))
        ) {
          const limit = validateUserLimit(posted("userLimit"));
          if (!limit.ok) return refuse(limit.error);
          if (limit.value !== (target.userLimit ?? 0)) {
            if (!sameNumber(liveLimit, baseline("userLimit", liveLimit))) {
              stale.push("user limit");
            } else changes.userLimit = limit.value;
          }
        }
        // The form shows the bitrate rounded to whole kbps (65536 bps shows
        // 66); a value posted back as shown is neither validated against the
        // server maximum nor sent.
        const liveShown = target.bitrate
          ? String(Math.round(target.bitrate / 1000))
          : "";
        if (
          posted("bitrate").trim() !== baseline("bitrate", liveShown).trim()
        ) {
          const bitrate = validateBitrateKbps(body.bitrate, ctx.maxBitrate);
          if (!bitrate.ok) return refuse(bitrate.error);
          if (bitrate.value !== undefined && bitrate.value !== target.bitrate) {
            if (liveShown !== baseline("bitrate", liveShown).trim()) {
              stale.push("bitrate");
            } else changes.bitrate = bitrate.value;
          }
        }
      }
      if (target.kind !== "category") {
        const liveParent = target.parentId ?? "";
        if (posted("parent").trim() !== baseline("parent", liveParent).trim()) {
          const parent = resolveParent(ctx.channels, body.parent);
          if (!parent.ok) return refuse(parent.error);
          if (parent.value !== target.parentId) {
            if (liveParent !== baseline("parent", liveParent).trim()) {
              stale.push("category");
            } else {
              const room = checkCapacity(ctx.channels, {
                parentId: parent.value,
                creating: false,
                movingFrom: target.parentId,
              });
              if (!room.ok) return refuse(room.error);
              changes.parent = parent.value;
              // Moving must not rewrite the channel's permissions.
              changes.lockPermissions = false;
            }
          }
        }
      }
      if (stale.length > 0) {
        return refuse(
          `"${target.name}" was changed elsewhere since you opened this page (${stale.join(", ")}). Nothing was saved; reload the page and make your edit again.`,
          { targetId: target.id, details: { stale } },
        );
      }
      const fields = Object.keys(changes).filter(
        (k) => k !== "lockPermissions",
      );
      if (fields.length === 0) {
        return {
          ok: true,
          text: `Nothing to change on "${target.name}".`,
          targetId: target.id,
          details: { changed: [] },
        };
      }
      const channel = await liveChannel(ctx.guild, target.id);
      if (!channel) return refuse("That channel no longer exists.");
      if (channel.manageable === false) {
        return refuse(
          `KoolBot can't change "${target.name}": a permission override on it blocks the bot.`,
        );
      }
      // Renames and edits share a strict per-channel rate limit, and a request
      // queued behind it would otherwise run later: the call is cancellable and
      // never retried after a timeout.
      const patch: Record<string, unknown> = {};
      if ("name" in changes) patch.name = changes.name;
      if ("topic" in changes) patch.topic = changes.topic;
      if ("userLimit" in changes) patch.user_limit = changes.userLimit;
      if ("bitrate" in changes) patch.bitrate = changes.bitrate;
      if ("parent" in changes) {
        patch.parent_id = changes.parent;
        // Moving must not rewrite the channel's permissions.
        patch.lock_permissions = false;
      }
      const edited = (await ctx.call(
        (signal) =>
          ctx.rest.patch(Routes.channel(target.id), {
            body: patch,
            reason: ctx.reason,
            signal,
          }),
        "edit channel",
        target.id,
        false,
      )) as { name?: string } | undefined;
      return {
        ok: true,
        text: `Saved "${edited?.name ?? target.name}" (${fields.join(", ")}).`,
        targetId: target.id,
        details: { changed: fields, name: edited?.name ?? target.name },
      };
    }),
  );

  router.post(
    "/channels/:id/move",
    write("move", async (ctx) => {
      const target = targetOf(ctx);
      if ("ok" in target) return target;
      const direction = ctx.body.direction;
      if (direction !== "up" && direction !== "down") {
        return refuse("Choose up or down.");
      }
      if (!canMove(ctx.channels, target, direction)) {
        return refuse(
          `"${target.name}" is already ${direction === "up" ? "first" : "last"}.`,
        );
      }
      // The button was drawn for a particular neighbour. If the order changed
      // since the page was shown, the same click would move it somewhere the
      // admin didn't see, so refuse and let them look again.
      const expected = ctx.body.neighbor;
      const live = neighbourOf(ctx.channels, target, direction);
      if (typeof expected === "string" && expected !== (live?.id ?? "")) {
        return refuse(
          `The order around "${target.name}" changed since you opened this page. Nothing was moved; reload and try again.`,
          { targetId: target.id, details: { direction, stale: true } },
        );
      }
      const channel = await liveChannel(ctx.guild, target.id);
      if (!channel) return refuse("That channel no longer exists.");
      if (channel.manageable === false) {
        return refuse(
          `KoolBot can't move "${target.name}": a permission override on it blocks the bot.`,
        );
      }
      // What discord.js's relative setPosition sends: the channel's sibling
      // group (same parent, same text/voice group) renumbered 0..n-1 with the
      // channel moved one place. Sent directly so the request can be cancelled.
      const order = siblingsOf(ctx.channels, target);
      const at = order.findIndex((c) => c.id === target.id);
      order.splice(at, 1);
      order.splice(direction === "up" ? at - 1 : at + 1, 0, target);
      await ctx.call(
        (signal) =>
          ctx.rest.patch(Routes.guildChannels(ctx.guild.id), {
            body: order.map((c, i) => ({ id: c.id, position: i })),
            reason: ctx.reason,
            signal,
          }),
        "reorder channel",
        ctx.guild.id,
        false,
      );
      return {
        ok: true,
        text: `Moved "${target.name}" ${direction}.`,
        targetId: target.id,
        details: { direction },
      };
    }),
  );

  router.post(
    "/channels/:id/delete",
    write("delete", async (ctx) => {
      const target = targetOf(ctx);
      if ("ok" in target) return target;
      const details = { name: target.name, type: target.kind };
      const posted =
        typeof ctx.body.confirm === "string" ? ctx.body.confirm : "";
      if (posted !== confirmationToken(target, ctx.channels)) {
        return refuse(
          posted === ""
            ? "Deleting needs the confirmation page. Open the channel's Delete button and confirm there."
            : `"${target.name}" changed since you opened the confirmation page (renamed, moved or its contents changed). Nothing was deleted; open Delete again and confirm what is there now.`,
          { targetId: target.id, details },
        );
      }
      let verdict: ReturnType<typeof deleteVerdict>;
      try {
        verdict = deleteVerdict(
          target,
          ctx.channels,
          await loadProtection(ctx.guild, ctx.channels),
        );
      } catch (error) {
        logger.warn("channel manager: protection check failed", error);
        return refuse(
          `Couldn't verify whether KoolBot manages "${target.name}", so it was not deleted.`,
          { targetId: target.id, details },
        );
      }
      if (!verdict.ok) {
        return refuse(verdict.message, {
          targetId: target.id,
          details: { ...details, reasons: verdict.reasons },
        });
      }
      const channel = await liveChannel(ctx.guild, target.id);
      if (!channel) {
        return refuse("That channel no longer exists.", {
          targetId: target.id,
          details,
        });
      }
      if (channel.deletable === false) {
        return refuse(
          `KoolBot can't delete "${target.name}": a permission override on it blocks the bot.`,
          { targetId: target.id, details },
        );
      }
      try {
        await ctx.call(
          (signal) =>
            ctx.rest.delete(Routes.channel(target.id), {
              reason: ctx.reason,
              signal,
            }),
          "delete channel",
          target.id,
          true,
        );
      } catch (error) {
        // A retry after a timeout can find it already deleted.
        if ((error as { code?: unknown }).code !== DISCORD_UNKNOWN_CHANNEL) {
          throw error;
        }
      }
      return {
        ok: true,
        text: `Deleted "${target.name}".`,
        targetId: target.id,
        details,
      };
    }),
  );

  return router;
}
