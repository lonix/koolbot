import { formatDistanceToNow, format } from 'date-fns';
import { utcToZonedTime } from 'date-fns-tz';
import Logger from './logger.js';

const logger = Logger.getInstance();

/**
 * Formats a duration in milliseconds to a human-readable string
 * @param durationMs Duration in milliseconds
 * @returns Formatted duration string (e.g., "2 hours, 30 minutes")
 */
export function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const remainingHours = hours % 24;
  const remainingMinutes = minutes % 60;
  const remainingSeconds = seconds % 60;

  const parts: string[] = [];

  if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (remainingHours > 0) parts.push(`${remainingHours} hour${remainingHours > 1 ? 's' : ''}`);
  if (remainingMinutes > 0) parts.push(`${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}`);
  if (remainingSeconds > 0 && parts.length === 0) parts.push(`${remainingSeconds} second${remainingSeconds > 1 ? 's' : ''}`);

  return parts.join(', ');
}

/**
 * Formats a date to show how long ago it was
 * @param date The date to format
 * @returns Formatted time ago string (e.g., "2 hours ago")
 */
export function formatTimeAgo(date: Date): string {
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * Formats a date to a specific timezone
 * @param date The date to format
 * @param timezone The timezone to use (e.g., "UTC", "America/New_York")
 * @returns Formatted date string in the specified timezone
 */
export function formatDateInTimezone(date: Date, timezone: string): string {
  try {
    const zonedDate = utcToZonedTime(date, timezone);
    return format(zonedDate, 'yyyy-MM-dd HH:mm:ss');
  } catch (err) {
    // Fallback to UTC if timezone is invalid
    logger.error(`Invalid timezone ${timezone}:`, err);
    return format(date, 'yyyy-MM-dd HH:mm:ss');
  }
} 
