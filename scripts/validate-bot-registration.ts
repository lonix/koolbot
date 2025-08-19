#!/usr/bin/env node

import { REST, Routes } from "discord.js";
import { config } from "dotenv";
import logger from "../src/utils/logger.js";
import { deployCommands } from "../src/deploy-commands.js";

config();

interface CommandInfo {
  id: string;
  name: string;
  description: string;
  version: string;
}

async function validateBotRegistration(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;

  if (!token) {
    logger.error("❌ DISCORD_TOKEN not found in environment variables");
    process.exit(1);
  }

  if (!clientId) {
    logger.error("❌ CLIENT_ID not found in environment variables");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(token);

  try {
    logger.info("🔍 Validating bot registration...");
    logger.info(`📋 Client ID: ${clientId}`);

    // Test 1: Check if bot token is valid
    logger.info("🧪 Test 1: Validating bot token...");
    try {
      const application = await rest.get(Routes.oauth2CurrentApplication());
      logger.info(`✅ Bot token is valid`);
      logger.info(`🤖 Bot name: ${(application as any).name}`);
      logger.info(`🆔 Application ID: ${(application as any).id}`);
    } catch (error) {
      logger.error("❌ Bot token is invalid or bot doesn't exist");
      logger.error(error);
      process.exit(1);
    }

    // Test 2: Check current registered commands
    logger.info("🧪 Test 2: Checking current registered commands...");
    try {
      const currentCommands = await rest.get(Routes.applicationCommands(clientId)) as CommandInfo[];
      logger.info(`📊 Currently registered commands: ${currentCommands.length}`);
      
      if (currentCommands.length > 0) {
        logger.info("📋 Current commands:");
        currentCommands.forEach((cmd, index) => {
          logger.info(`  ${index + 1}. /${cmd.name} - ${cmd.description}`);
        });
      } else {
        logger.info("📋 No commands currently registered");
      }
    } catch (error) {
      logger.error("❌ Failed to fetch current commands");
      logger.error(error);
    }

    // Test 3: Deploy commands
    logger.info("🧪 Test 3: Deploying commands...");
    try {
      await deployCommands();
      logger.info("✅ Commands deployed successfully");
    } catch (error) {
      logger.error("❌ Failed to deploy commands");
      logger.error(error);
      process.exit(1);
    }

    // Test 4: Verify commands were registered
    logger.info("🧪 Test 4: Verifying command registration...");
    try {
      const registeredCommands = await rest.get(Routes.applicationCommands(clientId)) as CommandInfo[];
      logger.info(`✅ Successfully verified ${registeredCommands.length} commands registered`);
      
      logger.info("📋 Registered commands:");
      registeredCommands.forEach((cmd, index) => {
        logger.info(`  ${index + 1}. /${cmd.name} - ${cmd.description} (ID: ${cmd.id})`);
      });

      // Check for specific important commands
      const commandNames = registeredCommands.map(cmd => cmd.name);
      const importantCommands = ['ping', 'botstats', 'config'];
      
      logger.info("🔍 Checking for important commands:");
      importantCommands.forEach(cmdName => {
        if (commandNames.includes(cmdName)) {
          logger.info(`  ✅ /${cmdName} is registered`);
        } else {
          logger.warn(`  ⚠️ /${cmdName} is NOT registered`);
        }
      });

    } catch (error) {
      logger.error("❌ Failed to verify command registration");
      logger.error(error);
      process.exit(1);
    }

    // Test 5: Check bot permissions
    logger.info("🧪 Test 5: Checking bot permissions...");
    logger.info("ℹ️  Make sure your bot has the following permissions in your Discord server:");
    logger.info("  - Send Messages");
    logger.info("  - Use Slash Commands");
    logger.info("  - Manage Channels (for voice channel features)");
    logger.info("  - View Channels");
    logger.info("  - Read Message History");

    logger.info("🎉 Bot registration validation completed successfully!");
    logger.info("📝 Next steps:");
    logger.info("  1. Invite the bot to your Discord server");
    logger.info("  2. Test commands like /ping and /botstats");
    logger.info("  3. Check that commands appear in Discord's slash command menu");

  } catch (error) {
    logger.error("❌ Bot registration validation failed");
    logger.error(error);
    process.exit(1);
  }
}

// Run the validation
validateBotRegistration().catch((error) => {
  logger.error("❌ Unexpected error during validation:", error);
  process.exit(1);
});
