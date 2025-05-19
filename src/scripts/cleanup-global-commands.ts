import { REST, Routes } from "discord.js";
import { config } from "dotenv";
import Logger from "../utils/logger.js";

config();
const logger = Logger.getInstance();

async function cleanupGlobalCommands(): Promise<void> {
  try {
    const rest = new REST({ version: "10" }).setToken(
      process.env.DISCORD_TOKEN!,
    );

    logger.info("Starting global commands cleanup...");

    // Deregister all global commands
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), {
      body: [],
    });

    logger.info("Successfully deregistered all global commands");
  } catch (error) {
    logger.error("Error during global commands cleanup:", error);
    throw error;
  }
}

// Run the cleanup
cleanupGlobalCommands()
  .then(() => {
    logger.info("Cleanup completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    logger.error("Cleanup failed:", error);
    process.exit(1);
  });
