import { startOfDay } from 'date-fns';

/**
 * Gets the current date for all loan calculations.
 * If ASOFDATE is set in the environment, it will be used instead of the real date.
 * This allows simulating different dates for testing without changing the system clock.
 * 
 * Format: YYYY-MM-DD (e.g., "2026-04-15")
 * 
 * @returns Date object representing the start of the effective day
 */
export function getAsOfDate(): Date {
  const override = process.env.ASOFDATE || process.env.ASOF_DATE || process.env.NEXT_PUBLIC_ASOFDATE;
  if (override) {
    const parsed = new Date(override);
    if (!isNaN(parsed.getTime())) {
      return startOfDay(parsed);
    }
  }
  return startOfDay(new Date());
}

/**
 * Gets the current date for server-side calculations.
 * This version is explicitly for server actions and API routes.
 */
export function getServerAsOfDate(): Date {
  return getAsOfDate();
}
