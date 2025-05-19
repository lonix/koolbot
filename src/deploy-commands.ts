import { REST, Routes } from "discord.js";
import { config } from "dotenv";
import Logger from "./utils/logger.js";
import { data as ping } from "./commands/ping.js";
import { data as amikool } from "./commands/amikool.js";
import { data as plexprice } from "./commands/plexprice.js";
import { data as vctop } from "./commands/vctop.js";
import { data as vcstats } from "./commands/vcstats.js";
import { data as seen } from "./commands/seen.js";
import { data as configCommand } from "./commands/config/index.js";
import { ConfigService } from "./services/config-service.js";

config();
const logger = Logger.getInstance();
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
  if (await configService.get("ENABLE_PING")) {
    commands.push(ping.toJSON());
  }

  if (await configService.get("ENABLE_AMIKOOL")) {
    commands.push(amikool.toJSON());
  }

  if (await configService.get("ENABLE_PLEX_PRICE")) {
    commands.push(plexprice.toJSON());
  }

  if (await configService.get("ENABLE_VC_TRACKING")) {
    commands.push(vctop.toJSON());
    commands.push(vcstats.toJSON());
  }

  if (await configService.get("ENABLE_SEEN")) {
    commands.push(seen.toJSON());
  }

  commands.push(configCommand.toJSON());
}

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);

export async function deployCommands(): Promise<void> {
  try {
    // First, remove all existing commands
    logger.info("Removing all existing commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), {
      body: [],
    });
    logger.info("Successfully removed all existing commands.");

    // Build the command list
    await buildCommandList();

    // Then register our commands
    logger.info(`Registering ${commands.length} new commands...`);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), {
      body: commands,
    });
    logger.info("Successfully registered new commands.");
  } catch (error) {
    logger.error("Error during command deployment:", error);
    throw error;
  }
}
