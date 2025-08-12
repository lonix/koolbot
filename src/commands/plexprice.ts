import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import axios from "axios";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("plexprice")
  .setDescription("Get the current PLEX price in ISK");

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const response = await axios.get(
      "https://api.evemarketer.com/ec/marketstat/json?typeid=44992&usesystem=30000142",
    );
    const plexData = response.data[0];
    const buyPrice = plexData.buy.max.toLocaleString();
    const sellPrice = plexData.sell.min.toLocaleString();

    await interaction.reply(
      `Current PLEX Prices in Jita:\nBuy: ${buyPrice} ISK\nSell: ${sellPrice} ISK`,
    );
  } catch (error) {
    logger.error("Error in plexprice command:", error);
    await interaction.reply({
      content: "There was an error while executing this command!",
      ephemeral: true,
    });
  }
}
