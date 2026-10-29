/**
 * @fileoverview Count-bounded row paging shared by the CO-OPS time-series tools
 *   (water level, monthly means, tide predictions, tidal currents).
 * @module services/coops/row-page
 *
 * A page is the caller's `limit` rows starting at `offset`, and nothing else bounds it, so
 * `next_offset` is always `offset + limit` until the series runs out and a caller can walk
 * it without reading the page it got back. Each tool owns its default and cap for `limit`
 * (`limit-clamp.ts`); response size follows from the count and the product's row width.
 */

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
   * caller discloses no page, so a range of at most `limit` rows comes back as it would unpaged.
   */
  whole: boolean;
}

/**
 * Page controls, both validated by the tool schema: `limit` a whole number from 1 (already
 * clamped to the tool's cap), `offset` a whole number from 0.
 */
export interface RowPageOptions {
  limit: number;
  offset: number;
}

/**
 * Takes rows `offset` up to `offset + limit`, stopping at the end of the series. An offset at
 * or past the end is an empty page, not a clamp to the last one.
 */
export function pageRows<T>(rows: readonly T[], { limit, offset }: RowPageOptions): RowPage<T> {
  const end = Math.max(offset, Math.min(rows.length, offset + limit));
  return {
    matched: rows.length,
    nextOffset: end < rows.length ? end : null,
    offset,
    rows: rows.slice(offset, end),
    whole: offset === 0 && end === rows.length,
  };
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
    : `This page carries ${span}. Call again with offset=${page.nextOffset} for the next page.`;
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
 * The primary series carries the offset and is the only one counted against `limit`; the
 * companion follows by time window rather than by index, because the two need not be the
 * same length. A sensor outage drops observation rows while CO-OPS still predicts those
 * slots, so equal index slices would pair rows from different instants. Windowing by time
 * keeps each page's two arrays describing one span, and the windows partition the companion
 * series exactly: a page ends at its last primary row's time, the next starts after it, and
 * the final page takes whatever trails the last primary row. A page whose span covers an
 * outage therefore carries every companion row inside it — more companion rows than `limit`.
 */
export function pagePairedRows<P extends { time: string }, C extends { time: string }>(
  primary: readonly P[],
  companion: readonly C[],
  options: RowPageOptions,
): PairedRowPage<P, C> {
  const page = pageRows(primary, options);
  const last = page.rows.at(-1);
  /*
   * A page that took no primary row covers no span, so it carries no companion rows either —
   * the page before it already took everything trailing the last primary row. Without this
   * the empty page past the end would repeat the companion rows a sensor outage at the end
   * of the range leaves unpaired.
   */
  if (last === undefined) return { companion: [], page };

  /*
   * Earlier pages already carried every companion row at or before the time of the primary
   * row just before this page.
   */
  const previous = primary[options.offset - 1];
  const start = previous === undefined ? 0 : rowsThrough(companion, previous.time);
  const end = page.nextOffset === null ? companion.length : rowsThrough(companion, last.time);
  return { companion: companion.slice(start, end), page };
}

/** How many leading rows of a time-ordered series fall at or before `time`. */
function rowsThrough(rows: readonly { time: string }[], time: string): number {
  const after = rows.findIndex((row) => row.time > time);
  return after === -1 ? rows.length : after;
}
