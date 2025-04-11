import {
  REST,
  Routes,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { config } from "dotenv";
import { Logger } from "./utils/logger";
import { data as pingCommand } from "./commands/ping";
import { data as amikoolCommand } from "./commands/amikool";
import { data as plexpriceCommand } from "./commands/plexprice";
import { data as vctopCommand } from "./commands/vctop";
import { data as vcstatsCommand } from "./commands/vcstats";
import { data as seenCommand } from "./commands/seen";

config();
const logger = Logger.getInstance();

// Build command list based on enabled features
const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];

if (process.env.ENABLE_PING === "true") {
  commands.push(pingCommand.toJSON());
}

if (process.env.ENABLE_AMIKOOL === "true") {
  commands.push(amikoolCommand.toJSON());
}

if (process.env.ENABLE_PLEXPRICE === "true") {
  commands.push(plexpriceCommand.toJSON());
}

if (process.env.ENABLE_VC_TRACKING === "true") {
  commands.push(vctopCommand.toJSON());
  commands.push(vcstatsCommand.toJSON());
}

if (process.env.ENABLE_SEEN === "true") {
  commands.push(seenCommand.toJSON());
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
