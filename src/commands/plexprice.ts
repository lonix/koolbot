import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import axios from "axios";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("plexprice")
  .setDescription("Get the current PLEX price in ISK");

interface MarketOrder {
  is_buy_order: boolean;
  price: number;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    // Try the primary API first
    let plexData;
    try {
      const response = await axios.get(
        "https://api.evemarketer.com/ec/marketstat/json?typeid=44992&usesystem=30000142",
        { timeout: 10000 },
      );
      plexData = response.data[0];
    } catch (primaryError) {
      logger.warn(
        "Primary EVE Market API failed, trying alternative:",
        primaryError,
      );

      // Try alternative API endpoint
      try {
        const response = await axios.get(
          "https://esi.evetech.net/latest/markets/10000002/orders/?datasource=tranquility&order_type=all&page=1&type_id=44992",
          { timeout: 10000 },
        );

        // Process ESI data format
        const orders: MarketOrder[] = response.data as MarketOrder[];
        const buyOrders = orders
          .filter((order) => order.is_buy_order === false)
          .sort((a, b) => a.price - b.price);
        const sellOrders = orders
          .filter((order) => order.is_buy_order === true)
          .sort((a, b) => b.price - a.price);

        if (buyOrders.length > 0 && sellOrders.length > 0) {
          const buyPrice = Math.floor(buyOrders[0].price).toLocaleString();
          const sellPrice = Math.floor(sellOrders[0].price).toLocaleString();

          await interaction.reply(
            `Current PLEX Prices in Jita (ESI):\nBuy: ${buyPrice} ISK\nSell: ${sellPrice} ISK\n\n*Note: Using alternative API due to primary API issues*`,
          );
          return;
        }
      } catch (secondaryError) {
        logger.error("Both EVE Market APIs failed:", secondaryError);
      }

      // If both APIs fail, provide helpful error message
      await interaction.reply({
        content:
          "❌ Unable to fetch PLEX prices at the moment. The EVE Market APIs appear to be unavailable.\n\n**Workarounds:**\n• Check https://market.evemarketer.com/\n• Use https://eve-central.com/\n\nThis is a known issue being investigated.",
        ephemeral: true,
      });
      return;
    }

    // Process successful response from primary API
    const buyPrice = plexData.buy.max.toLocaleString();
    const sellPrice = plexData.sell.min.toLocaleString();

    await interaction.reply(
      `Current PLEX Prices in Jita:\nBuy: ${buyPrice} ISK\nSell: ${sellPrice} ISK`,
    );
  } catch (error) {
    logger.error("Error in plexprice command:", error);
    await interaction.reply({
      content:
        "There was an error while executing this command! Please try again later.",
      ephemeral: true,
    });
  }
}
