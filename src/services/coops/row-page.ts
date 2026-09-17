/**
 * @fileoverview Byte-bounded row paging shared by the CO-OPS time-series tools
 *   (water level, tide predictions, tidal currents).
 * @module services/coops/row-page
 *
 * A CO-OPS time series is dense and its row width varies by product, so a fixed row
 * count bounds the response for one product and not the next: 124 high/low events fit
 * comfortably while 240 six-minute observations do not. The page is therefore bounded by
 * the serialized size of the row array itself, measured against the framework's inlining
 * budget, and the caller walks the series with a row offset.
 *
 * The budget is spent on the rows only. Identity fields, the residual summary, and the
 * enrichment trailer sit outside it, which is why the constant is a budget rather than a
 * hard ceiling on the whole response.
 */

import { DEFAULT_OUTLINE_BUDGET_BYTES } from '@cyanheads/mcp-ts-core/utils';

/**
 * Serialized bytes a page of rows may occupy. The framework's own threshold for when a
 * payload should stop being inlined, reused so the tools and the framework agree on what
 * "too large to hand a client" means.
 */
export const ROW_PAGE_BUDGET_BYTES = DEFAULT_OUTLINE_BUDGET_BYTES;

/** One page of a row series, plus the accounting a caller needs to reach the rest. */
export interface RowPage<T> {
  /** Total rows the requested range matched, before the page was cut. */
  matched: number;
  /** Offset to request for the following page, or null when this page reaches the end. */
  nextOffset: number | null;
  /** Row offset this page starts at, echoed from the request. */
  offset: number;
  rows: T[];
  /**
   * True when the page is the entire matched series read from the start — the one case a
   * caller discloses nothing, so a range that fits comes back exactly as it did unpaged.
   */
  whole: boolean;
}

/** Page controls. `limit` lowers the page; it can never raise it past the byte bound. */
export interface RowPageOptions {
  budgetBytes?: number;
  limit?: number;
  offset: number;
}

/** Serialized length of a value, and 0 for anything `JSON.stringify` drops. */
export function serializedBytes(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/**
 * Serialized length of an array once `row` joins it: the row itself, plus one comma when
 * something is already there. Lets a greedy walk price each candidate row without
 * re-serializing the whole page it would join.
 */
function withRow(bytes: number, taken: number, row: unknown): number {
  return bytes + (taken > 0 ? 1 : 0) + serializedBytes(row);
}

/** The index a page may not reach past: the end of the series, or the caller's row cap. */
function pageCeiling(length: number, offset: number, limit: number | undefined): number {
  return limit === undefined ? length : Math.min(length, offset + Math.max(limit, 0));
}

function buildPage<T>(rows: readonly T[], offset: number, end: number): RowPage<T> {
  return {
    matched: rows.length,
    nextOffset: end < rows.length ? end : null,
    offset,
    rows: rows.slice(offset, end),
    whole: offset === 0 && end === rows.length,
  };
}

/**
 * Takes the leading rows at `offset` that fit the byte budget.
 *
 * One row is always taken when one exists at the offset, so a row wider than the whole
 * budget is still returned and the walk always advances rather than looping on an empty
 * page. An offset past the end is an empty page, not a clamp to the last one.
 */
export function pageRows<T>(rows: readonly T[], options: RowPageOptions): RowPage<T> {
  const budget = options.budgetBytes ?? ROW_PAGE_BUDGET_BYTES;
  const ceiling = pageCeiling(rows.length, options.offset, options.limit);

  let bytes = 2; // the enclosing `[]`
  let taken = 0;
  for (let i = options.offset; i < ceiling; i += 1) {
    const row = rows[i];
    if (row === undefined) break;
    const candidate = withRow(bytes, taken, row);
    if (taken > 0 && candidate > budget) break;
    bytes = candidate;
    taken += 1;
  }

  return buildPage(rows, options.offset, options.offset + taken);
}

/**
 * The page accounting, in the field names every CO-OPS time-series tool declares in its
 * `enrichment` block. Enrichment reaches `structuredContent` and the `content[]` trailer
 * alike, so one call puts the accounting on both surfaces.
 */
export interface RowPageDisclosure {
  next_offset: number | null;
  page_offset: number;
  rows_matched: number;
  rows_returned: number;
  truncated: boolean;
}

/** Page accounting for `ctx.enrich`. */
export function pageDisclosure(page: RowPage<unknown>): RowPageDisclosure {
  return {
    next_offset: page.nextOffset,
    page_offset: page.offset,
    rows_matched: page.matched,
    rows_returned: page.rows.length,
    truncated: page.nextOffset !== null,
  };
}

/** One sentence naming what this page covers and how to reach the next, for the notice. */
export function pageNotice(page: RowPage<unknown>, rowNoun: string): string {
  if (page.rows.length === 0) {
    return `Offset ${page.offset} is past the last of ${page.matched} ${rowNoun} in the requested range, so this page is empty. Request a lower offset to read the series.`;
  }
  const span = `${rowNoun} ${page.offset + 1}–${page.offset + page.rows.length} of ${page.matched}`;
  return page.nextOffset === null
    ? `This page carries ${span} and is the last one — the series is fully read.`
    : `This page carries ${span}; it is bounded by response size rather than by a row count. Call again with offset=${page.nextOffset} for the next page.`;
}

/** A page of a primary series with the companion rows covering the same span. */
export interface PairedRowPage<P, C> {
  companion: C[];
  page: RowPage<P>;
}

/**
 * Pages two time-keyed series that describe the same period — observed water levels and
 * the tide predictions they are compared against.
 *
 * The primary series carries the offset; the companion follows by time window rather than
 * by index, because the two need not be the same length. A sensor outage drops observation
 * rows while CO-OPS still predicts those slots, so equal index slices would pair rows from
 * different instants. Windowing by time keeps each page's two arrays describing one span,
 * and the windows partition the companion series exactly: a page ends at its last primary
 * row's time, the next starts after it, and the final page takes whatever trails the last
 * primary row.
 *
 * Both series are charged to one budget, so a pair cannot each spend it in full, and both
 * walks are incremental — the companion pointer only ever moves forward.
 */
export function pagePairedRows<P extends { time: string }, C extends { time: string }>(
  primary: readonly P[],
  companion: readonly C[],
  options: RowPageOptions,
): PairedRowPage<P, C> {
  const budget = options.budgetBytes ?? ROW_PAGE_BUDGET_BYTES;
  const ceiling = pageCeiling(primary.length, options.offset, options.limit);

  /*
   * Skip the companion rows earlier pages already carried: everything at or before the time
   * of the primary row just before this page. An offset past the primary series has no such
   * row to window from, so nothing of the companion belongs to it.
   */
  let windowStart = 0;
  const previous = primary[options.offset - 1];
  if (previous !== undefined) {
    while (windowStart < companion.length) {
      const row = companion[windowStart];
      if (row === undefined || row.time > previous.time) break;
      windowStart += 1;
    }
  } else if (options.offset > 0) {
    windowStart = companion.length;
  }

  let primaryBytes = 2;
  let taken = 0;
  let windowEnd = windowStart;
  let windowBytes = 2;

  for (let i = options.offset; i < ceiling; i += 1) {
    const row = primary[i];
    if (row === undefined) break;

    // Price the row and the companion rows it pulls in, before committing to either: a row
    // that does not fit must not leave the companion window advanced past the page.
    const candidatePrimary = withRow(primaryBytes, taken, row);
    let probeEnd = windowEnd;
    let probeBytes = windowBytes;
    let probeCount = windowEnd - windowStart;
    while (probeEnd < companion.length) {
      const next = companion[probeEnd];
      if (next === undefined || next.time > row.time) break;
      probeBytes = withRow(probeBytes, probeCount, next);
      probeCount += 1;
      probeEnd += 1;
    }

    if (taken > 0 && candidatePrimary + probeBytes > budget) break;

    primaryBytes = candidatePrimary;
    windowBytes = probeBytes;
    windowEnd = probeEnd;
    taken += 1;
  }

  const end = options.offset + taken;
  const companionEnd = end >= primary.length ? companion.length : windowEnd;
  return {
    /*
     * A page that took no primary row covers no span, so it carries no companion rows either —
     * the page before it already took everything trailing the last primary row. Without this
     * the empty page past the end would repeat the companion rows a sensor outage at the end
     * of the range leaves unpaired.
     */
    companion: taken === 0 ? [] : companion.slice(windowStart, companionEnd),
    page: buildPage(primary, options.offset, end),
  };
}
