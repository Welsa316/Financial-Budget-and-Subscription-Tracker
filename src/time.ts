import { config } from './config.js';

/**
 * Every date boundary in this app — pay weeks, "this month", cron fire times —
 * is evaluated in the configured zone, never the server's. Railway containers
 * run UTC, and a UTC week boundary would roll the Friday paycheck over five
 * hours early.
 */
const ZONE = config.timezone;

const ymdFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const stampFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const dayMonthFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  month: 'short',
  day: 'numeric',
});

const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  weekday: 'long',
});

/** Local calendar date (YYYY-MM-DD) for an instant. */
export function toYmd(date: Date = new Date()): string {
  return ymdFormatter.format(date);
}

/** "Aug 11, 7:02 PM" — used for every "as of" stamp. */
export function formatStamp(iso: string | Date): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return 'unknown';
  return stampFormatter.format(date);
}

/** "Aug 11" — used in tables where the year is implied. */
export function formatDayMonth(ymd: string): string {
  return dayMonthFormatter.format(parseYmd(ymd));
}

export function weekdayName(ymd: string): string {
  return weekdayFormatter.format(parseYmd(ymd));
}

/** Parses YYYY-MM-DD as noon UTC, which keeps it on the same calendar day in any US zone. */
export function parseYmd(ymd: string): Date {
  const [year, month, day] = ymd.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12, 0, 0));
}

export function addDays(ymd: string, days: number): string {
  const date = parseYmd(ymd);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Adds calendar months, clamping to the end of the target month so that
 * Jan 31 + 1 month lands on Feb 28 rather than rolling into March.
 */
export function addMonths(ymd: string, months: number): string {
  const date = parseYmd(ymd);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const daysInTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 12),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, daysInTargetMonth));
  return date.toISOString().slice(0, 10);
}

/** First day of the calendar month containing the given date. */
export function startOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

export function daysBetween(fromYmd: string, toYmd_: string): number {
  const from = parseYmd(fromYmd).getTime();
  const to = parseYmd(toYmd_).getTime();
  return Math.round((to - from) / 86_400_000);
}

/** 0 = Sunday … 5 = Friday, 6 = Saturday. */
export function dayOfWeek(ymd: string): number {
  return parseYmd(ymd).getUTCDay();
}

