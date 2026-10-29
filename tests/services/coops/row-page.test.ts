/**
 * @fileoverview Tests for the count-bounded row pager shared by the CO-OPS time-series tools.
 * @module tests/services/coops/row-page.test
 */

import { describe, expect, it } from 'vitest';
import {
  pageDisclosure,
  pageNotice,
  pagePairedRows,
  pageRows,
  type RowPage,
} from '@/services/coops/row-page.js';

/** A 6-minute observation row, timestamped on the CO-OPS grid from 2026-09-01 00:00. */
function obsRow(index: number): { quality: string; sigma: number; time: string; value: number } {
  const minutes = index * 6;
  const day = String(1 + Math.floor(minutes / 1440)).padStart(2, '0');
  const hour = String(Math.floor((minutes % 1440) / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return {
    quality: 'p',
    sigma: 0.014,
    time: `2026-09-${day} ${hour}:${minute}`,
    value: Number((8 + (index % 100) / 100).toFixed(3)),
  };
}

function predRow(index: number): { time: string; value: number } {
  const { time } = obsRow(index);
  return { time, value: Number((8 + (index % 90) / 100).toFixed(3)) };
}

describe('pageRows', () => {
  const rows = Array.from({ length: 720 }, (_, i) => obsRow(i));

  it('returns a series of exactly limit rows whole, with no next page', () => {
    const page = pageRows(rows.slice(0, 50), { limit: 50, offset: 0 });
    expect(page.rows).toHaveLength(50);
    expect(page.matched).toBe(50);
    expect(page.nextOffset).toBeNull();
    expect(page.whole).toBe(true);
  });

  it('cuts a series of limit + 1 rows to limit, with the next page at limit', () => {
    const page = pageRows(rows.slice(0, 51), { limit: 50, offset: 0 });
    expect(page.rows).toEqual(rows.slice(0, 50));
    expect(page.matched).toBe(51);
    expect(page.nextOffset).toBe(50);
    expect(page.whole).toBe(false);
  });

  it('takes rows offset to offset + limit, whatever their width', () => {
    const wide = rows.map((row) => ({ ...row, note: 'x'.repeat(50_000) }));
    const page = pageRows(wide, { limit: 7, offset: 100 });
    expect(page.rows).toEqual(wide.slice(100, 107));
    expect(page.offset).toBe(100);
    expect(page.nextOffset).toBe(107);
    expect(page.matched).toBe(720);
  });

  it('walks first page to last in limit-sized steps and concatenates to the whole series', () => {
    const walked: ReturnType<typeof obsRow>[] = [];
    const sizes: number[] = [];
    let offset = 0;

    for (;;) {
      const page = pageRows(rows, { limit: 100, offset });
      walked.push(...page.rows);
      sizes.push(page.rows.length);
      expect(sizes.length).toBeLessThan(20);
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBe(offset + 100);
      offset = page.nextOffset;
    }

    expect(sizes).toEqual([100, 100, 100, 100, 100, 100, 100, 20]);
    expect(walked).toEqual(rows);
  });

  it('marks a remainder read from a later offset as the last page, not as whole', () => {
    const page = pageRows(rows, { limit: 100, offset: 700 });
    expect(page.rows).toHaveLength(20);
    expect(page.nextOffset).toBeNull();
    expect(page.whole).toBe(false);
  });

  it.each([720, 5000])(
    'treats offset %i as an empty page, not a clamp to the last page',
    (offset) => {
      const page = pageRows(rows, { limit: 50, offset });
      expect(page.rows).toEqual([]);
      expect(page.offset).toBe(offset);
      expect(page.matched).toBe(720);
      expect(page.nextOffset).toBeNull();
      expect(page.whole).toBe(false);
    },
  );

  it('pages an empty series as an empty whole page', () => {
    const page = pageRows([], { limit: 50, offset: 0 });
    expect(page.rows).toEqual([]);
    expect(page.matched).toBe(0);
    expect(page.nextOffset).toBeNull();
    expect(page.whole).toBe(true);
  });
});

describe('pageNotice', () => {
  const page = (overrides: Partial<RowPage<unknown>>): RowPage<unknown> => ({
    matched: 240,
    nextOffset: 100,
    offset: 0,
    rows: Array.from({ length: 100 }),
    whole: false,
    ...overrides,
  });

  it('names the span and the next offset on a page that leaves rows behind', () => {
    expect(pageNotice(page({}), 'predictions')).toBe(
      'This page carries predictions 1–100 of 240. Call again with offset=100 for the next page.',
    );
  });

  it('calls the final page the last one', () => {
    expect(
      pageNotice(
        page({ nextOffset: null, offset: 200, rows: Array.from({ length: 40 }) }),
        'events',
      ),
    ).toBe(
      'This page carries events 201–240 of 240 and is the last one — the series is fully read.',
    );
  });

  it('calls a page past the end empty and points back into the series', () => {
    expect(pageNotice(page({ nextOffset: null, offset: 300, rows: [] }), 'months')).toBe(
      'Offset 300 is past the last of 240 months in the requested range, so this page is empty. Request a lower offset to read the series.',
    );
  });
});

describe('pageDisclosure', () => {
  it('reports the page accounting under the enrichment field names', () => {
    const page = pageRows(
      Array.from({ length: 120 }, (_, i) => obsRow(i)),
      { limit: 50, offset: 50 },
    );
    expect(pageDisclosure(page)).toEqual({
      next_offset: 100,
      page_offset: 50,
      rows_matched: 120,
      rows_returned: 50,
      truncated: true,
    });
  });
});

describe('pagePairedRows', () => {
  const observations = Array.from({ length: 720 }, (_, i) => obsRow(i));
  const predictions = Array.from({ length: 720 }, (_, i) => predRow(i));

  /** Walks every page at `limit` and returns each page's primary and companion rows. */
  function walk<P extends { time: string }, C extends { time: string }>(
    primary: readonly P[],
    companion: readonly C[],
    limit: number,
  ): { companion: C[]; primary: P[] }[] {
    const pages: { companion: C[]; primary: P[] }[] = [];
    let offset = 0;
    for (;;) {
      const paired = pagePairedRows(primary, companion, { limit, offset });
      pages.push({ companion: paired.companion, primary: paired.page.rows });
      expect(pages.length).toBeLessThan(20);
      if (paired.page.nextOffset === null) return pages;
      expect(paired.page.nextOffset).toBe(offset + limit);
      offset = paired.page.nextOffset;
    }
  }

  it('counts only the primary series against limit, with the companion rows of its span', () => {
    const paired = pagePairedRows(observations, predictions, { limit: 300, offset: 0 });
    expect(paired.page.rows).toEqual(observations.slice(0, 300));
    expect(paired.page.nextOffset).toBe(300);
    expect(paired.companion).toEqual(predictions.slice(0, 300));
  });

  it('returns a primary series of exactly limit rows whole, with the trailing companion rows', () => {
    const paired = pagePairedRows(observations.slice(0, 50), predictions.slice(0, 53), {
      limit: 50,
      offset: 0,
    });
    expect(paired.page.whole).toBe(true);
    expect(paired.page.nextOffset).toBeNull();
    expect(paired.companion).toEqual(predictions.slice(0, 53));
  });

  it('carries every prediction inside an outage on the page whose rows span it', () => {
    // The sensor silent for slots 20–49 of the 6-minute grid: CO-OPS still predicts them.
    const gapped = observations.filter((_, i) => i < 20 || i >= 50);
    const paired = pagePairedRows(gapped, predictions, { limit: 300, offset: 0 });
    expect(paired.page.rows).toHaveLength(300);
    expect(paired.page.rows.at(-1)?.time).toBe(observations[329]?.time);
    expect(paired.companion).toEqual(predictions.slice(0, 330));
  });

  it('partitions both series when an outage straddles a page boundary', () => {
    // Observation slots 300–339 missing: page one ends on slot 299, page two resumes at 340.
    const gapped = observations.filter((_, i) => i < 300 || i >= 340);
    const pages = walk(gapped, predictions, 300);

    expect(pages.map((p) => p.primary.length)).toEqual([300, 300, 80]);
    // The outage's predictions open the page after it — the first span that reaches past them.
    expect(pages.map((p) => p.companion.length)).toEqual([300, 340, 80]);
    expect(pages[1]?.companion[0]?.time).toBe(predictions[300]?.time);
    expect(pages.flatMap((p) => p.primary)).toEqual(gapped);
    expect(pages.flatMap((p) => p.companion)).toEqual(predictions);
  });

  it.each([680, 5000])('carries no companion rows on the empty page at offset %i', (offset) => {
    const gapped = observations.filter((_, i) => i < 300 || i >= 340);
    const paired = pagePairedRows(gapped, predictions, { limit: 300, offset });
    expect(paired.page.rows).toEqual([]);
    expect(paired.page.nextOffset).toBeNull();
    expect(paired.companion).toEqual([]);
  });

  it('leaves trailing companion rows on the last real page, not on the empty page after it', () => {
    // A sensor that goes silent at the end of the range: the observed series stops while
    // CO-OPS still predicts the remaining slots.
    const primary = observations.slice(0, 5);
    const companion = predictions.slice(0, 8);

    const last = pagePairedRows(primary, companion, { limit: 50, offset: 0 });
    expect(last.page.rows).toHaveLength(5);
    expect(last.companion).toEqual(companion);

    // The page after it covers no span of its own, so it repeats none of them.
    const past = pagePairedRows(primary, companion, { limit: 50, offset: primary.length });
    expect(past.page.rows).toEqual([]);
    expect(past.companion).toEqual([]);
  });

  it('returns the whole pair when the primary series has no companion at all', () => {
    const paired = pagePairedRows(observations.slice(0, 5), [], { limit: 50, offset: 0 });
    expect(paired.page.rows).toHaveLength(5);
    expect(paired.companion).toEqual([]);
    expect(paired.page.whole).toBe(true);
  });
});
