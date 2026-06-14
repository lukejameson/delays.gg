/**
 * Shared time formatting utilities — always uses Guernsey local time (Europe/London).
 * Import from $lib/time instead of using raw toLocaleTimeString/DateString directly.
 */

export const GY_TZ = 'Europe/London';

/** Format a date/time as HH:MM in Guernsey local time. */
export function formatGuernseyTime(date: string | Date | null | undefined): string {
  if (!date) return '--:--';
  return new Date(date).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: GY_TZ,
  });
}

/** Format a date/time as "DD Mon YYYY, HH:MM" in Guernsey local time. */
export function formatGuernseyDateTime(date: string | Date | null | undefined): string {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: GY_TZ,
  });
}

/** Format a date as "Day, DD Mon" in Guernsey local time. */
export function formatGuernseyShortDate(date: string | Date | null | undefined): string {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: GY_TZ,
  });
}

/** Format a date as "DD Mon YYYY" (e.g., "07 Jun 2026") — stats page date display. */
export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: GY_TZ,
  });
}
