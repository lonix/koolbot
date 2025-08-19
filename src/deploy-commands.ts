import { REST, Routes } from "discord.js";
import { config } from "dotenv";
import logger from "./utils/logger.js";
import { data as ping } from "./commands/ping.js";
import { data as amikool } from "./commands/amikool.js";
import { data as plexprice } from "./commands/plexprice.js";
import { data as vctop } from "./commands/vctop.js";
import { data as vcstats } from "./commands/vcstats.js";
import { data as seen } from "./commands/seen.js";
import { data as configCommand } from "./commands/config/index.js";
import { data as quoteCommand } from "./commands/quote.js";
import { data as botstatsCommand } from "./commands/botstats.js";
import { command as setupLobbyCommand } from "./commands/setup-lobby.js";
import { data as transferOwnershipCommand } from "./commands/transfer-ownership.js";
import { data as announceVcStatsCommand } from "./commands/announce-vc-stats.js";
import { data as excludeChannelCommand } from "./commands/exclude-channel.js";
import { ConfigService } from "./services/config-service.js";

config();
const configService = ConfigService.getInstance();

// Build command list based on enabled features
const commands: Array<{
  name: string;
  description: string;
  options?: Array<{
    name: string;
    description: string;
    type: number;
    required?: boolean;
  }>;
}> = [];

async function buildCommandList(): Promise<void> {
  // Always add core commands
  commands.push(configCommand.toJSON());
  commands.push(botstatsCommand.toJSON());
  commands.push(setupLobbyCommand.data.toJSON());
  commands.push(excludeChannelCommand.toJSON());

  // Add conditional commands based on configuration
  if (await configService.get("ENABLE_PING")) {
    commands.push(ping.toJSON());
    logger.info("✓ /ping command enabled");
  }

  if (await configService.get("ENABLE_AMIKOOL")) {
    commands.push(amikool.toJSON());
    logger.info("✓ /amikool command enabled");
  }

  if (await configService.get("ENABLE_PLEX_PRICE")) {
    commands.push(plexprice.toJSON());
    logger.info("✓ /plexprice command enabled");
  }

  if (await configService.get("ENABLE_VC_TRACKING")) {
    commands.push(vctop.toJSON());
    commands.push(vcstats.toJSON());
    logger.info("✓ /vctop and /vcstats commands enabled");
  }

  if (await configService.get("ENABLE_SEEN")) {
    commands.push(seen.toJSON());
    logger.info("✓ /seen command enabled");
  }

  if (await configService.get("ENABLE_VC_MANAGEMENT")) {
    commands.push(transferOwnershipCommand.toJSON());
    logger.info("✓ /transfer-ownership command enabled");
  }

  if (await configService.get("ENABLE_VC_WEEKLY_ANNOUNCEMENT")) {
    commands.push(announceVcStatsCommand.toJSON());
    logger.info("✓ /announce-vc-stats command enabled");
  }

  if (await configService.get("quotes.enabled")) {
    commands.push(quoteCommand.toJSON());
    logger.info("✓ /quote command enabled");
  }

  logger.info(`Total commands to register: ${commands.length}`);
}

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);

export async function deployCommands(): Promise<void> {
  try {
    logger.info("Starting command deployment process...");
    
    // Build the command list
    await buildCommandList();

    // First, remove all existing commands
    logger.info("Removing all existing commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), {
      body: [],
    });
    logger.info("Successfully removed all existing commands.");

    // Then register our commands
    logger.info(`Registering ${commands.length} new commands...`);
    const data = await rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), {
      body: commands,
    });
    
    logger.info("Successfully registered new commands.");
    logger.info(`Registered commands: ${commands.map(cmd => cmd.name).join(', ')}`);
    
    // Log the response from Discord API
    if (Array.isArray(data)) {
      logger.info(`Discord API confirmed ${data.length} commands registered`);
    }
  } catch (error) {
    logger.error("Error during command deployment:", error);
    throw error;
  }
}
