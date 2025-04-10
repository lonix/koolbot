import { CommandInteraction } from 'discord.js';
import { Logger } from '../utils/logger';
import axios from 'axios';

const logger = Logger.getInstance();

export async function handlePlexPrice(interaction: CommandInteraction) {
  try {
    logger.debug('PlexPrice command executed');

    // Get PLEX price from Eve Online's ESI API
    const response = await axios.get('https://esi.evetech.net/latest/markets/10000002/orders/?datasource=tranquility&order_type=all&type_id=44992');
    const orders = response.data;

    // Calculate average price
    const buyOrders = orders.filter((order: any) => order.is_buy_order === false);
    const totalPrice = buyOrders.reduce((sum: number, order: any) => sum + order.price, 0);
    const averagePrice = totalPrice / buyOrders.length;

    await interaction.reply(`Current PLEX price in Jita: ${averagePrice.toLocaleString()} ISK`);
  } catch (error) {
    logger.error('Error fetching PLEX price:', error);
    await interaction.reply({ content: 'Failed to fetch PLEX price. Please try again later.', ephemeral: true });
  }
}
