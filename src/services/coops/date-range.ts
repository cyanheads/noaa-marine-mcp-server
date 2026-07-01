/**
 * @fileoverview Strict YYYYMMDD date-range validation shared by the CO-OPS date tools
 *   (tide predictions, water level, currents).
 * @module services/coops/date-range
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
  end: Date;
  /** Whole-day span from begin to end (end − begin). */
  spanDays: number;
}

/** Validation outcome — a valid range, or a message naming the offending date. */
export type CoopsDateRangeResult = ({ ok: true } & CoopsDateRange) | { ok: false; error: string };

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
 * Validate a CO-OPS `begin_date`/`end_date` pair. On success returns the parsed
 * dates and their span in days; on failure returns an actionable message naming
 * the impossible or reversed date.
 */
export function validateCoopsDateRange(beginDate: string, endDate: string): CoopsDateRangeResult {
  const begin = parseYyyymmdd(beginDate);
  if (!begin) {
    return { ok: false, error: `begin_date "${beginDate}" is not a real YYYYMMDD calendar date.` };
  }
  const end = parseYyyymmdd(endDate);
  if (!end) {
    return { ok: false, error: `end_date "${endDate}" is not a real YYYYMMDD calendar date.` };
  }
  if (begin.getTime() > end.getTime()) {
    return {
      ok: false,
      error: `begin_date "${beginDate}" is after end_date "${endDate}" — provide the earlier date first.`,
    };
  }
  const spanDays = (end.getTime() - begin.getTime()) / (1000 * 60 * 60 * 24);
  return { ok: true, begin, end, spanDays };
}
