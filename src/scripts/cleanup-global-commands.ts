import { REST, Routes } from "discord.js";
import { requireEnv } from "../config/env.js";
import logger from "../utils/logger.js";

async function cleanupGlobalCommands(): Promise<void> {
  try {
    const rest = new REST({ version: "10" }).setToken(
      requireEnv("DISCORD_TOKEN"),
    );

    logger.info("Starting global commands cleanup...");

    // Deregister all global commands
    await rest.put(Routes.applicationCommands(requireEnv("CLIENT_ID")), {
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
