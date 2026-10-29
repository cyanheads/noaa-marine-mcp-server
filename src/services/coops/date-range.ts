/**
 * @fileoverview Strict calendar-date range validation shared by the CO-OPS date tools
 *   (tide predictions, water level, monthly means, currents), the verification-lag window
 *   rule the verified-product tools share, and the rule for a window that starts after the
 *   station's current date.
 * @module services/coops/date-range
 *
 * The tools accept each date as `YYYYMMDD` or `YYYY-MM-DD`; CO-OPS takes `YYYYMMDD`. The
 * hyphens are stripped here, once, so calendar validation, the span, and the request the
 * service sends all read the same compact date — while every rejection names the date the
 * caller actually sent.
 *
 * `new Date(...)` silently normalizes impossible calendar dates (20250231 → Mar 3,
 * month 00/13 rolls the year), so a bad date reaches CO-OPS and returns HTTP 400 —
 * which the tools then mislabel as `station_not_found`. This validator rejects those
 * locally before any upstream call, and rejects reversed ranges (begin after end).
 * It deliberately does not enforce a maximum span: each tool keeps its own limit
 * (365 days for predictions/currents, 31 to 3,655 for water level by interval, 73,000 for
 * monthly means).
 */

/** Parsed range plus its span in whole days (both endpoints at midnight UTC). */
export interface CoopsDateRange {
  begin: Date;
  /** `begin_date` as CO-OPS takes it, `YYYYMMDD`. */
  beginDate: string;
  end: Date;
  /** `end_date` as CO-OPS takes it, `YYYYMMDD`. */
  endDate: string;
  /** Whole-day span from begin to end (end − begin). */
  spanDays: number;
}

/** Validation outcome — a valid range, or a message naming the offending date as given. */
export type CoopsDateRangeResult = ({ ok: true } & CoopsDateRange) | { ok: false; error: string };

/** The two accepted spellings of one calendar date, shared by the tool input schemas. */
export const COOPS_DATE_FORM = /^(\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * Strictly parse a `YYYYMMDD` string into a midnight-UTC Date, rejecting any value
 * that `Date` would normalize (Feb 31, month 00/13, day 00). Returns null on any
 * malformed or impossible input.
 */
function parseYyyymmdd(s: string): Date | null {
  if (!/^\d{8}$/.test(s)) return null;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  // Reconstruct and compare — a normalized (rolled-over) date won't round-trip.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * Reads either accepted spelling into its compact `YYYYMMDD` form and the calendar date it
 * names. Null for any other string, and for a date the calendar does not have.
 */
function parseCalendarDate(s: string): { compact: string; date: Date } | null {
  if (!COOPS_DATE_FORM.test(s)) return null;
  const compact = s.replaceAll('-', '');
  const date = parseYyyymmdd(compact);
  return date ? { compact, date } : null;
}

/**
 * Whether a window ending on `end` can still be waiting for CO-OPS verification.
 *
 * CO-OPS verifies its coarser products monthly, for the prior month, and answers an unverified
 * window with the same `may not be offered at this station at the requested time` sentence it
 * sends for a window before the station's record begins. The window's end is what separates
 * the two: one ending on or after the first day of the prior month (UTC) may not be verified
 * yet, and any earlier one had its chance to be. `now` is injectable so the boundary is testable.
 */
export function awaitsVerification(end: Date, now: Date = new Date()): boolean {
  const priorMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  return end.getTime() >= priorMonthStart;
}

/** The zones CO-OPS reads a request's dates in: UTC, local standard, local standard/daylight. */
export type CoopsTimeZone = 'gmt' | 'lst' | 'lst_ldt';

/** A station's clock as its catalog row publishes it. */
export interface StationClock {
  /** Whether the station keeps daylight time (`observedst`). */
  observesDst: boolean;
  /** Standard-time offset from UTC in hours (`timezonecorr`). */
  utcOffsetHours: number;
}

/**
 * The offsets no station's local date falls outside: CO-OPS gauges run from UTC−11 to UTC+12,
 * plus a daylight hour, and the bounds keep a margin past both ends.
 */
const WESTMOST_OFFSET_HOURS = -12;
const EASTMOST_OFFSET_HOURS = 14;

const HOUR_MS = 60 * 60 * 1000;

/** The calendar date `offsetHours` from UTC at `now`, as midnight UTC on that date. */
function dateAtOffset(now: Date, offsetHours: number): number {
  const shifted = new Date(now.getTime() + offsetHours * HOUR_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

/**
 * Whether a window beginning on `begin` starts after the station's current date, in the zone
 * CO-OPS reads the request's dates in — so it cannot hold an observation yet.
 *
 * Under `gmt` that is the UTC date, exactly. Under `lst` and `lst_ldt` it is the station's local
 * date, which runs up to a day either side of UTC, so the station's clock is read only where
 * stations disagree: a `begin` on or before the date at UTC−12 has arrived everywhere, and one
 * after the date at UTC+14 has arrived nowhere. Between them the clock is the station's standard
 * offset, plus an hour under `lst_ldt` where it keeps daylight time — applied year-round, so it
 * can only place the local date later than it is. A missing clock falls back to the UTC+14 bound,
 * which inside that band never refuses. The rule therefore never refuses a window that can hold
 * data; a near-midnight window or an unknown station is left to CO-OPS to answer.
 *
 * `now` is injectable so the boundaries are testable.
 */
export async function beginsAfterStationDate(
  begin: Date,
  timeZone: CoopsTimeZone,
  stationClock: () => Promise<StationClock | undefined>,
  now: Date = new Date(),
): Promise<boolean> {
  const beginsAfter = (offsetHours: number) => begin.getTime() > dateAtOffset(now, offsetHours);
  if (timeZone === 'gmt') return beginsAfter(0);
  if (!beginsAfter(WESTMOST_OFFSET_HOURS)) return false;
  if (beginsAfter(EASTMOST_OFFSET_HOURS)) return true;
  const clock = await stationClock();
  if (!clock) return false;
  const daylightHours = timeZone === 'lst_ldt' && clock.observesDst ? 1 : 0;
  return beginsAfter(clock.utcOffsetHours + daylightHours);
}

/**
 * Validate a CO-OPS `begin_date`/`end_date` pair, each as `YYYYMMDD` or `YYYY-MM-DD`. On
 * success returns the parsed dates, the compact strings to send CO-OPS, and the span in
 * days; on failure returns an actionable message naming the impossible or reversed date
 * exactly as it was given.
 */
export function validateCoopsDateRange(beginDate: string, endDate: string): CoopsDateRangeResult {
  const begin = parseCalendarDate(beginDate);
  if (!begin) {
    return { ok: false, error: `begin_date "${beginDate}" is not a real calendar date.` };
  }
  const end = parseCalendarDate(endDate);
  if (!end) {
    return { ok: false, error: `end_date "${endDate}" is not a real calendar date.` };
  }
  if (begin.date.getTime() > end.date.getTime()) {
    return {
      ok: false,
      error: `begin_date "${beginDate}" is after end_date "${endDate}" — provide the earlier date first.`,
    };
  }
  const spanDays = (end.date.getTime() - begin.date.getTime()) / (1000 * 60 * 60 * 24);
  return {
    ok: true,
    begin: begin.date,
    beginDate: begin.compact,
    end: end.date,
    endDate: end.compact,
    spanDays,
  };
}
