import {
  REST,
  Routes,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { config } from "dotenv";
import Logger from "./utils/logger.js";
import { data as ping } from "./commands/ping.js";
import { data as amikool } from "./commands/amikool.js";
import { data as plexprice } from "./commands/plexprice.js";
import { data as vctop } from "./commands/vctop.js";
import { data as vcstats } from "./commands/vcstats.js";
import { data as seen } from "./commands/seen.js";

config();
const logger = Logger.getInstance();

// Build command list based on enabled features
const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];

if (process.env.ENABLE_PING === "true") {
  commands.push(ping.toJSON());
}

if (process.env.ENABLE_AMIKOOL === "true") {
  commands.push(amikool.toJSON());
}

if (process.env.ENABLE_PLEXPRICE === "true") {
  commands.push(plexprice.toJSON());
}

if (process.env.ENABLE_VC_TRACKING === "true") {
  commands.push(vctop.toJSON());
  commands.push(vcstats.toJSON());
}

if (process.env.ENABLE_SEEN === "true") {
  commands.push(seen.toJSON());
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
