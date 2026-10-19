/**
 * The simulated servers of the adoption end-to-end tests, as data (#1025,
 * #1180). Each builder returns a fresh `World` plus the claims an admin would
 * make on it; the tests share the machinery in `adoption-world.ts`.
 *
 * 1. `referenceServer`: a gaming community (hoisted staff roles, role-gated
 *    game categories, a picker owned by another bot, webhook-fed news
 *    channels, an integration bot's category, a music-bot channel, an AFK
 *    channel, and existing quotes / announcement / voice-stats channels).
 * 2. `communityServer`: a small Community server (the owner is the only admin,
 *    a native rules channel, another bot's join-to-create lobby in a shared
 *    "Voice Chat" category, permanent personal rooms, five overlapping bots).
 * 3. `largeCommunity`: thousands of members, Onboarding region roles, an
 *    `emoji | name` naming convention, a forum, an announcement channel, a
 *    booster-gated VIP channel, a lobby with live temporary channels and
 *    permanent team voice channels in per-game categories.
 */

import {
  ADMIN,
  F,
  KOOLBOT_USER,
  T,
  VIEW,
  channel,
  hiddenFrom,
  role,
  sf,
  webhook,
  worldOf,
  type Claim,
  type World,
} from "./adoption-world.js";

// ---------------------------------------------------------------------------
// 1. The reference server
// ---------------------------------------------------------------------------

const OTHER_BOT_MEMBER = "bot-music";

export function referenceServer(): World {
  const G = "g1";
  const ownOverwrite = [
    { id: OTHER_BOT_MEMBER, type: "member" as const, allow: VIEW, deny: "0" },
  ];
  return worldOf({
    guildId: G,
    ownerId: "owner",
    adminId: "admin",
    roles: [
      role(G, "@everyone", 0, VIEW),
      role("koolbot", "KoolBot", 20, ADMIN, true),
      role("admin-role", "Admin", 15, ADMIN),
      role("mod-role", "Moderator", 14),
      role("vip-role", "VIP", 13),
      role("bots-role", "Bots", 12),
      role("carl", "Music Bot", 11, "0", true),
      role("retired-role", "Old Event", 3),
      ...Array.from({ length: 10 }, (_, i) =>
        role(`game-${i}`, `Game ${i}`, 2),
      ),
    ],
    botRoles: [
      ["koolbot", KOOLBOT_USER],
      ["carl", OTHER_BOT_MEMBER],
    ],
    members: [
      ["owner", { bot: false, roleIds: [] }],
      ["admin", { bot: false, roleIds: ["admin-role"] }],
      ["u-mod", { bot: false, roleIds: ["mod-role"] }],
      ["u-vip", { bot: false, roleIds: ["vip-role"] }],
      ["u-old", { bot: false, roleIds: ["retired-role"] }],
      [KOOLBOT_USER, { bot: true, roleIds: ["koolbot"] }],
      [OTHER_BOT_MEMBER, { bot: true, roleIds: ["carl"] }],
      // Only some of the bots are in the Bots role.
      ["bot-feed", { bot: true, roleIds: ["bots-role"] }],
      ["bot-picker", { bot: true, roleIds: [] }],
    ],
    channels: [
      channel(
        "cat-admin",
        "Admin",
        T.category,
        null,
        hiddenFrom(G, "admin-role"),
      ),
      channel(
        "staff-log",
        "staff-log",
        T.text,
        "cat-admin",
        hiddenFrom(G, "admin-role"),
      ),
      channel("cat-news", "News", T.category),
      channel("news", "news", T.text, "cat-news"),
      channel("updates", "updates", T.text, "cat-news"),
      channel("cat-info", "Info", T.category),
      channel("quotes", "quotes", T.text, "cat-info"),
      channel("announcement", "announcement", T.text, "cat-info"),
      channel("voice-stats", "voice-stats", T.text, "cat-info"),
      channel("vip-lounge", "vip-lounge", T.text, "cat-info"),
      channel("picker", "pick-your-game", T.text, "cat-info", ownOverwrite),
      channel("cat-integration", "Integration", T.category, null, ownOverwrite),
      channel("integration-feed", "feed", T.text, "cat-integration"),
      channel("music", "music", T.voice, "cat-info", ownOverwrite),
      channel("afk", "afk", T.voice),
      channel("cat-voice", "Voice Channels", T.category),
      channel("lobby", "Lobby", T.voice, "cat-voice"),
      ...Array.from({ length: 10 }, (_, i) => [
        channel(
          `cat-game-${i}`,
          `Game ${i}`,
          T.category,
          null,
          hiddenFrom(G, `game-${i}`),
        ),
        channel(`game-chat-${i}`, `chat-${i}`, T.text, `cat-game-${i}`),
      ]).flat(),
    ],
    // Webhook-fed news channels, a followed announcement channel, the other
    // bots' own webhooks and an application webhook on the picker.
    webhooks: [
      webhook("wh-news", "news"),
      webhook("wh-updates", "updates"),
      webhook("wh-updates-follow", "updates", "channel-follower"),
      webhook("wh-integration", "integration-feed"),
      webhook("wh-picker-app", "picker", "application"),
    ],
    afkChannelId: "afk",
  });
}

export const REFERENCE_CLAIMS: Claim[] = [
  { channelId: "news", action: "read-only", feed: true },
  { channelId: "updates", action: "read-only", feed: true },
  { channelId: "vip-lounge", action: "gate", roleIds: ["vip-role"] },
  { channelId: "quotes", action: "leave", bindKey: "quotes.channel_id" },
  {
    channelId: "voice-stats",
    action: "leave",
    bindKey: "voicetracking.announcements.channel_id",
  },
  {
    channelId: "announcement",
    action: "leave",
    bindKey: "events.announcement_channel_id",
  },
  {
    channelId: "staff-log",
    action: "leave",
    bindKey: "core.errors.channel_id",
  },
  {
    channelId: "cat-voice",
    action: "leave",
    bindKey: "voicechannels.category_id",
    voiceManagedOnly: true,
  },
  {
    channelId: "lobby",
    action: "leave",
    bindKey: "voicechannels.lobby.channel_id",
  },
];

// ---------------------------------------------------------------------------
// 2. A small Community server
// ---------------------------------------------------------------------------

export interface Community {
  world: World;
  claims: Claim[];
  ids: Record<
    | "guild"
    | "owner"
    | "rules"
    | "announcements"
    | "general"
    | "supportersChat"
    | "catInfo"
    | "catGeneral"
    | "catVoice"
    | "catRooms"
    | "vcChat"
    | "foreignLobby"
    | "lounge"
    | "roomAlice"
    | "roomBob"
    | "afk"
    | "supporters"
    | "newcomer"
    | "jtcBot",
    string
  >;
}

export function communityServer(): Community {
  const ids = {
    guild: sf("c2.guild"),
    owner: sf("c2.owner"),
    rules: sf("c2.rules"),
    announcements: sf("c2.announcements"),
    general: sf("c2.general"),
    supportersChat: sf("c2.supporters-chat"),
    catInfo: sf("c2.cat-info"),
    catGeneral: sf("c2.cat-general"),
    catVoice: sf("c2.cat-voice"),
    catRooms: sf("c2.cat-rooms"),
    vcChat: sf("c2.vc-chat"),
    foreignLobby: sf("c2.foreign-lobby"),
    lounge: sf("c2.lounge"),
    roomAlice: sf("c2.room-alice"),
    roomBob: sf("c2.room-bob"),
    afk: sf("c2.afk"),
    supporters: sf("c2.supporters"),
    newcomer: sf("c2.newcomer"),
    jtcBot: sf("c2.bot-jtc"),
  };
  const bots = ["a", "b", "c", "d"].map((x) => sf(`c2.bot-${x}`));
  const jtcRole = sf("c2.role-bot-jtc");
  const botRoleIds = bots.map((_, i) => sf(`c2.role-bot-${i}`));
  const world = worldOf({
    guildId: ids.guild,
    // There are no admin or moderator roles: the owner is the admin.
    ownerId: ids.owner,
    adminId: ids.owner,
    features: ["COMMUNITY"],
    rulesChannelId: ids.rules,
    afkChannelId: ids.afk,
    onboardingRoleIds: [ids.newcomer],
    roles: [
      role(ids.guild, "@everyone", 0, VIEW),
      role(sf("c2.role-koolbot"), "KoolBot", 20, ADMIN, true),
      role(jtcRole, "TempVoice", 9, "0", true),
      ...botRoleIds.map((id, i) => role(id, `Bot ${i}`, 5 + i, "0", true)),
      role(ids.supporters, "Supporters", 3),
      role(ids.newcomer, "Newcomer", 2),
    ],
    botRoles: [
      [sf("c2.role-koolbot"), KOOLBOT_USER],
      [jtcRole, ids.jtcBot],
      ...botRoleIds.map((id, i): [string, string] => [id, bots[i]!]),
    ],
    members: [
      [ids.owner, { bot: false, roleIds: [] }],
      [KOOLBOT_USER, { bot: true, roleIds: [sf("c2.role-koolbot")] }],
      [ids.jtcBot, { bot: true, roleIds: [jtcRole] }],
      ...bots.map((id, i): [string, { bot: boolean; roleIds: string[] }] => [
        id,
        { bot: true, roleIds: [botRoleIds[i]!] },
      ]),
      ["h1", { bot: false, roleIds: [ids.supporters] }],
      ["h2", { bot: false, roleIds: [ids.supporters] }],
      ["h3", { bot: false, roleIds: [ids.newcomer] }],
      ["h4", { bot: false, roleIds: [ids.newcomer] }],
      ["h5", { bot: false, roleIds: [] }],
      ["h6", { bot: false, roleIds: [] }],
    ],
    channels: [
      channel(ids.catInfo, "Information", T.category),
      channel(ids.rules, "rules", T.text, ids.catInfo),
      channel(ids.announcements, "announcements", T.announcement, ids.catInfo),
      channel(ids.catGeneral, "General", T.category),
      channel(ids.general, "general", T.text, ids.catGeneral, [
        // Left over from a member who has since gone.
        { id: "h-gone", type: "member", allow: VIEW, deny: "0" },
      ]),
      channel(ids.supportersChat, "supporters-chat", T.text, ids.catGeneral),
      // Another bot's join-to-create lobby shares this category with a text
      // channel and a permanent lounge.
      channel(ids.catVoice, "Voice Chat", T.category),
      channel(ids.vcChat, "vc-chat", T.text, ids.catVoice),
      channel(ids.foreignLobby, "➕ Create Room", T.voice, ids.catVoice, [
        { id: ids.jtcBot, type: "member", allow: VIEW, deny: "0" },
      ]),
      channel(ids.lounge, "Lounge", T.voice, ids.catVoice),
      // Personal permanent rooms.
      channel(ids.catRooms, "Rooms", T.category),
      channel(ids.roomAlice, "Alice's Room", T.voice, ids.catRooms),
      channel(ids.roomBob, "Bob's Room", T.voice, ids.catRooms),
      channel(ids.afk, "AFK", T.voice),
    ],
    webhooks: [
      webhook(sf("c2.wh-announce"), ids.announcements),
      webhook(sf("c2.wh-follow"), ids.announcements, "channel-follower"),
      webhook(sf("c2.wh-vc-app"), ids.vcChat, "application"),
    ],
  });
  const claims: Claim[] = [
    { channelId: ids.announcements, action: "read-only", feed: true },
    {
      channelId: ids.supportersChat,
      action: "gate",
      roleIds: [ids.supporters],
    },
    {
      channelId: ids.catVoice,
      action: "leave",
      bindKey: "voicechannels.category_id",
      voiceManagedOnly: true,
    },
    { channelId: ids.catRooms, action: "leave" },
  ];
  return { world, claims, ids };
}

// ---------------------------------------------------------------------------
// 3. A large community
// ---------------------------------------------------------------------------

export interface LargeSize {
  categories: number;
  perCategory: number;
  humans: number;
}
export const LARGE: LargeSize = {
  categories: 40,
  perCategory: 9,
  humans: 3000,
};
export const REGIONS = [
  "🇳🇴 Norway",
  "🇸🇪 Sweden",
  "🇩🇰 Denmark",
  "🇫🇮 Finland",
  "🇮🇸 Iceland",
  "🇩🇪 Germany",
  "🇬🇧 United Kingdom",
  "🇺🇸 United States",
];

export interface Large {
  world: World;
  claims: Claim[];
  ids: {
    guild: string;
    rules: string;
    news: string;
    feedback: string;
    vip: string;
    booster: string;
    catVoice: string;
    lobby: string;
    admin: string;
    regionRoles: string[];
    gameRoles: string[];
    teamChannels: string[];
    tempRooms: string[];
    inhouseBot: string;
  };
}

export function largeCommunity(size: LargeSize = LARGE): Large {
  const g = sf("l3.guild");
  const ids = {
    guild: g,
    rules: sf("l3.rules"),
    news: sf("l3.news"),
    feedback: sf("l3.feedback"),
    vip: sf("l3.vip"),
    booster: sf("l3.role-booster"),
    catVoice: sf("l3.cat-voice"),
    lobby: sf("l3.lobby"),
    admin: sf("l3.role-admin"),
    regionRoles: REGIONS.map((_, i) => sf(`l3.role-region-${i}`)),
    gameRoles: Array.from({ length: size.categories }, (_, i) =>
      sf(`l3.role-game-${i}`),
    ),
    teamChannels: [] as string[],
    tempRooms: ["Alice", "Bjorn", "Chen", "Dara"].map((n) =>
      sf(`l3.temp-${n}`),
    ),
    inhouseBot: sf("l3.bot-inhouse"),
  };
  const catInfo = sf("l3.cat-info");
  const koolbotRole = sf("l3.role-koolbot");
  const inhouseRole = sf("l3.role-inhouse");

  const channels = [
    channel(catInfo, "📌 | Info", T.category),
    channel(ids.rules, "📜 | rules", T.text, catInfo),
    channel(ids.news, "📢 | news", T.announcement, catInfo),
    channel(ids.feedback, "📋 | feedback", T.forum, catInfo),
    channel(ids.vip, "💎 | vip-lounge", T.text, catInfo),
    channel(ids.catVoice, "🔊 | Voice", T.category),
    channel(ids.lobby, "➕ | Lobby", T.voice, ids.catVoice),
    ...["Alice", "Bjorn", "Chen", "Dara"].map((n, i) =>
      channel(ids.tempRooms[i]!, `🔊 | ${n}`, T.voice, ids.catVoice, [], {
        voiceMemberCount: 2,
      }),
    ),
  ];
  const webhooks = [
    webhook(sf("l3.wh-news"), ids.news),
    webhook(sf("l3.wh-news-2"), ids.news),
    webhook(sf("l3.wh-news-follow"), ids.news, "channel-follower"),
  ];
  for (let i = 0; i < size.categories; i++) {
    const cat = sf(`l3.cat-game-${i}`);
    channels.push(
      channel(
        cat,
        `🎮 | Game ${i}`,
        T.category,
        null,
        hiddenFrom(g, ids.gameRoles[i]!),
      ),
    );
    for (let j = 0; j < size.perCategory; j++) {
      const team = j === 0;
      const id = sf(`l3.ch-${i}-${j}`);
      if (team) ids.teamChannels.push(id);
      channels.push(
        channel(
          id,
          team ? `🔊 | team-${i}` : `💬 | game-${i}-chat-${j}`,
          team ? T.voice : T.text,
          cat,
        ),
      );
      // Some game channels are fed by game bots through webhooks.
      if (!team && j === 1 && i % 4 === 0) {
        webhooks.push(webhook(sf(`l3.wh-game-${i}`), id));
      }
    }
  }

  const fillerRoles = Array.from({ length: 30 }, (_, i) =>
    role(sf(`l3.role-colour-${i}`), `Colour ${i}`, 1),
  );
  const humans = Array.from(
    { length: size.humans },
    (_, i): [string, { bot: boolean; roleIds: string[] }] => [
      `u${i}`,
      {
        bot: false,
        roleIds: [
          ids.regionRoles[i % ids.regionRoles.length]!,
          ...(i % 7 === 0 ? [ids.gameRoles[i % size.categories]!] : []),
        ],
      },
    ],
  );
  const world = worldOf({
    guildId: g,
    ownerId: sf("l3.owner"),
    adminId: "admin",
    features: ["COMMUNITY"],
    rulesChannelId: ids.rules,
    onboardingRoleIds: ids.regionRoles,
    roles: [
      role(g, "@everyone", 0, VIEW),
      role(koolbotRole, "KoolBot", 90, ADMIN, true),
      role(inhouseRole, "In-house bot", 85, "0", true),
      // Server Booster is managed by Discord, never by a bot.
      role(ids.booster, "Server Booster", 60, "0", true),
      role(ids.admin, "Admin", 80, ADMIN),
      role(sf("l3.role-mod"), "Moderator", 70, F.ModerateMembers.toString()),
      ...REGIONS.map((name, i) => role(ids.regionRoles[i]!, name, 10 + i)),
      ...ids.gameRoles.map((id, i) => role(id, `Game ${i}`, 20 + i)),
      ...fillerRoles,
    ],
    botRoles: [
      [koolbotRole, KOOLBOT_USER],
      [inhouseRole, ids.inhouseBot],
    ],
    members: [
      [sf("l3.owner"), { bot: false, roleIds: [] }],
      ["admin", { bot: false, roleIds: [ids.admin] }],
      [KOOLBOT_USER, { bot: true, roleIds: [koolbotRole] }],
      [ids.inhouseBot, { bot: true, roleIds: [inhouseRole] }],
      ...humans,
    ],
    channels,
    webhooks,
  });

  // Every channel gets a claim (most "leave alone"), so the plan is built
  // against hundreds of claims, not a handful.
  const special: Record<string, Claim> = {
    [ids.news]: { channelId: ids.news, action: "read-only", feed: true },
    [ids.feedback]: { channelId: ids.feedback, action: "read-only" },
    [ids.vip]: { channelId: ids.vip, action: "gate", roleIds: [ids.booster] },
    [ids.catVoice]: {
      channelId: ids.catVoice,
      action: "leave",
      bindKey: "voicechannels.category_id",
      voiceManagedOnly: true,
      usePrefix: true,
    },
    [ids.lobby]: {
      channelId: ids.lobby,
      action: "leave",
      bindKey: "voicechannels.lobby.channel_id",
    },
  };
  const claims = [...world.channels.keys()].map(
    (id) => special[id] ?? { channelId: id, action: "leave" as const },
  );
  return { world, claims, ids };
}
