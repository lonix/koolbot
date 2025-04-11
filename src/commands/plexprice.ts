import { CommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Logger } from '../utils/logger';
import axios from 'axios';

const logger = Logger.getInstance();

interface MarketOrder {
  duration: number;
  is_buy_order: boolean;
  issued: string;
  location_id: number;
  min_volume: number;
  order_id: number;
  price: number;
  range: string;
  system_id: number;
  type_id: number;
  volume_remain: number;
  volume_total: number;
}

export const data = new SlashCommandBuilder()
  .setName('plexprice')
  .setDescription('Check current PLEX price in Jita');

export async function execute(interaction: CommandInteraction) {
  try {
    logger.info(`Executing plexprice command for user ${interaction.user.tag}`);
    
    // Fetch PLEX price from ESI
    const response = await axios.get<MarketOrder[]>('https://esi.evetech.net/latest/markets/10000002/orders/?datasource=tranquility&order_type=all&page=1&type_id=44992');
    const orders = response.data;
    
    // Filter for sell orders in Jita (The Forge region)
    const jitaOrders = orders.filter(order => 
      order.location_id === 60003760 && // Jita 4-4 CNAP
      order.is_buy_order === false
    );
    
    if (jitaOrders.length === 0) {
      await interaction.reply('No PLEX sell orders found in Jita.');
      return;
    }
    
    // Find the lowest price
    const lowestPrice = Math.min(...jitaOrders.map(order => order.price));
    
    // Format price in millions with 3 decimal places
    const formattedPrice = (lowestPrice / 1000000).toFixed(3);
    
    await interaction.reply(`Current PLEX price in Jita: ${formattedPrice} M ISK`);
    logger.info(`Plexprice command completed for user ${interaction.user.tag}`);
  } catch (error) {
    logger.error('Error executing plexprice command:', error);
    await interaction.reply({ content: 'An error occurred while fetching PLEX prices.', ephemeral: true });
  }
} 