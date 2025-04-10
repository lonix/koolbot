import mongoose from 'mongoose';
import { logger } from './logger';

const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 seconds

export async function connectDB() {
  let retries = 0;
  const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/koolbot';

  while (retries < MAX_RETRIES) {
    try {
      await mongoose.connect(mongoURI);
      logger.info('Connected to MongoDB');
      return;
    } catch (error) {
      retries++;
      logger.error(`MongoDB connection attempt ${retries} failed:`, error);

      if (retries < MAX_RETRIES) {
        logger.info(`Retrying in ${RETRY_DELAY/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        logger.error('Max retries reached. Could not connect to MongoDB');
        process.exit(1);
      }
    }
  }
}

// Handle MongoDB connection events
mongoose.connection.on('connected', () => {
  logger.info('MongoDB connection established');
});

mongoose.connection.on('error', (error) => {
  logger.error('MongoDB connection error:', error);
});

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected. Attempting to reconnect...');
});

// Handle process termination
process.on('SIGINT', async () => {
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed through app termination');
    process.exit(0);
  } catch (error) {
    logger.error('Error closing MongoDB connection:', error);
    process.exit(1);
  }
});
