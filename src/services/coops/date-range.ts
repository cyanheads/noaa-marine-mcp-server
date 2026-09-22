/**
 * @fileoverview Strict calendar-date range validation shared by the CO-OPS date tools
 *   (tide predictions, water level, currents).
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
 * (365 days for predictions/currents, 31 for 6-minute water level).
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
